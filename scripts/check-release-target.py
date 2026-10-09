#!/usr/bin/env python3
"""Fail closed before creating a new, immutable release version."""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = "JermZone/watch-now"
IMAGE = "ghcr.io/jermzone/watch-now"
TAG = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?")
MANIFEST_TYPES = ", ".join([
    "application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


class ReleaseSafetyError(ValueError):
    pass


def request_json(url, headers):
    request = urllib.request.Request(url, headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    except (urllib.error.URLError, TimeoutError):
        raise ReleaseSafetyError("Release target verification is unavailable; nothing may be published") from None
    with response:
        status = response.code
        try:
            data = json.loads(response.read(1024 * 1024))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ReleaseSafetyError("Release target verification returned an invalid response") from None
    return status, data


def check_target(tag, token, actor, request=request_json):
    if not TAG.fullmatch(tag):
        raise ReleaseSafetyError("Expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.N")
    if not token or not actor:
        raise ReleaseSafetyError("Authenticated release target verification is required")
    github_headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "watch-now-release"}
    # A repository access failure must never be mistaken for a missing release.
    status, _ = request(f"https://api.github.com/repos/{REPOSITORY}", github_headers)
    if status != 200:
        raise ReleaseSafetyError("Cannot verify access to the approved release repository")
    status, _ = request(f"https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}", github_headers)
    if status == 200:
        raise ReleaseSafetyError("This GitHub release already exists; published versions are never replaced")
    if status != 404:
        raise ReleaseSafetyError("Cannot establish that the GitHub release is absent")
    basic = base64.b64encode(f"{actor}:{token}".encode()).decode("ascii")
    status, data = request("https://ghcr.io/token?service=ghcr.io&scope=repository:jermzone/watch-now:pull",
                           {"Authorization": f"Basic {basic}", "User-Agent": "watch-now-release"})
    registry_token = data.get("token") if isinstance(data, dict) else None
    if status != 200 or not isinstance(registry_token, str) or not registry_token:
        raise ReleaseSafetyError("Cannot authenticate release image verification")
    status, data = request(f"https://ghcr.io/v2/jermzone/watch-now/manifests/{tag[1:]}",
                           {"Authorization": f"Bearer {registry_token}", "Accept": MANIFEST_TYPES,
                            "User-Agent": "watch-now-release"})
    if status == 200:
        raise ReleaseSafetyError("This versioned image already exists, including a partial prior publication; use a new version")
    errors = data.get("errors") if isinstance(data, dict) else None
    if status != 404 or not isinstance(errors, list) or not errors or any(
            not isinstance(error, dict) or error.get("code") not in {"MANIFEST_UNKNOWN", "NAME_UNKNOWN"}
            for error in errors):
        raise ReleaseSafetyError("Cannot establish that the versioned image is absent")


def main():
    if os.environ.get("GITHUB_REPOSITORY", REPOSITORY).lower() != REPOSITORY.lower():
        raise ReleaseSafetyError("Publication is restricted to the approved repository")
    if len(sys.argv) != 2:
        raise ReleaseSafetyError("Pass exactly one release tag")
    check_target(sys.argv[1], os.environ.get("GH_TOKEN"), os.environ.get("GITHUB_ACTOR"))
    print(f"Verified unused release and versioned image for {sys.argv[1]}")


if __name__ == "__main__":
    try:
        main()
    except ReleaseSafetyError as error:
        sys.exit(str(error))
