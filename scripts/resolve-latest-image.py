#!/usr/bin/env python3
"""Resolve a published, successfully built release for latest promotion."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

REPO = "JermZone/watch-now"
IMAGE = "ghcr.io/jermzone/watch-now"


def version(tag):
    match = re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag)
    if not match:
        raise ValueError("Expected a vMAJOR.MINOR.PATCH release tag")
    return tuple(map(int, match.groups()))


def validate_release(tag, releases):
    version(tag)
    candidates = []
    for release in releases:
        if release.get("draft") is not False or release.get("prerelease") is not False or not release.get("published_at"):
            continue
        try:
            candidates.append((version(release["tag_name"]), release))
        except ValueError:
            continue
    if not candidates or version(tag) != max(item[0] for item in candidates):
        raise ValueError("Only the newest published stable version may become latest")
    release = next((item[1] for item in candidates if item[1]["tag_name"] == tag), None)
    if not release:
        raise ValueError("Release has not been published")
    return release


def validate_manifest(tag, digest_bytes, checksum_bytes):
    version(tag)
    expected_name = f"watch-now-{tag[1:]}.tar.gz"
    required_names = {expected_name, "image-digest.txt"}
    allowed_names = required_names | {f"watch-now-{tag[1:]}-install.zip"}
    checksums = {}
    for line in checksum_bytes.decode("ascii").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})\s+\*?(.+)", line)
        if not match or match[2] not in allowed_names or match[2] in checksums:
            raise ValueError("Invalid release checksum manifest")
        checksums[match[2]] = match[1]
    if not required_names <= set(checksums):
        raise ValueError("Missing release checksum entries")
    if hashlib.sha256(digest_bytes).hexdigest() != checksums["image-digest.txt"]:
        raise ValueError("Image digest checksum mismatch")
    image = digest_bytes.decode("ascii").strip()
    if not re.fullmatch(re.escape(IMAGE) + r"@sha256:[0-9a-f]{64}", image):
        raise ValueError("Unexpected registry or digest")
    return image


def api(path, paginate=False):
    args = ["gh", "api", f"repos/{REPO}/{path}"]
    if paginate:
        args += ["--paginate", "--slurp"]
    return json.loads(subprocess.check_output(args, text=True))


def main(tag):
    version(tag)
    releases = [item for page in api("releases?per_page=100", True) for item in page]
    validate_release(tag, releases)
    obj = api(f"git/ref/tags/{tag}")["object"]
    while obj["type"] == "tag":
        obj = api(f"git/tags/{obj['sha']}")["object"]
    if obj["type"] != "commit":
        raise ValueError("Release tag must identify a commit")
    pages = api(f"actions/workflows/release.yml/runs?event=push&head_sha={obj['sha']}&per_page=100", True)
    runs = [run for page in pages for run in page["workflow_runs"]]
    if not any(run["head_branch"] == tag and run["head_sha"] == obj["sha"]
               and run["status"] == "completed" and run["conclusion"] == "success" for run in runs):
        raise ValueError("The tagged release has no successful release workflow")
    with tempfile.TemporaryDirectory() as directory:
        subprocess.run(["gh", "release", "download", tag, "--repo", REPO,
                        "--pattern", "image-digest.txt", "--pattern", "SHA256SUMS",
                        "--dir", directory], check=True)
        root = pathlib.Path(directory)
        image = validate_manifest(tag, (root / "image-digest.txt").read_bytes(),
                                  (root / "SHA256SUMS").read_bytes())
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"image={image}\ndigest={image.split('@')[1]}\n")
    print(f"Verified published release {tag}: {image}")


if __name__ == "__main__":
    main(sys.argv[1])
