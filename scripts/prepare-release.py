#!/usr/bin/env python3
"""Build deterministic customer assets, check extracted links, and record the exact image."""
import argparse
import gzip
import hashlib
import pathlib
import re
import subprocess
import tempfile
import urllib.parse
import zipfile

ROOT_FILES = {
    ".env.example", "compose.yaml", "compose.release.yaml", "compose.dvr.yaml", "compose.dvr-master.yaml",
    "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "PROVENANCE.md", "RELEASE_NOTES.md",
    "SUPPORT.md", "SECURITY.md", "CONTRIBUTING.md", "AGENTS.md", "deploy/nginx.conf",
}
DOC_SUFFIXES = {".md", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif"}
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?")
IMAGE = "ghcr.io/jermzone/watch-now"


def validate_version(version):
    if not VERSION.fullmatch(version):
        raise ValueError("Invalid release version")


def release_body(notes, version):
    validate_version(version)
    matches = list(re.finditer(r"(?m)^## +([^\n]+)\n", notes))
    selected = [index for index, match in enumerate(matches)
                if re.match(re.escape(version) + r"(?:\s|$)", match[1])]
    if len(selected) != 1:
        raise ValueError("Release notes must contain exactly one matching version section")
    index = selected[0]
    end = matches[index + 1].start() if index + 1 < len(matches) else len(notes)
    body = notes[matches[index].start():end].strip()
    if not body.partition("\n")[2].strip():
        raise ValueError("Customer release notes may not be empty")
    # GitHub renders the body at /releases/tag/, where repository-relative links break.
    base = f"https://github.com/JermZone/watch-now/blob/v{version}/"
    def published_link(match):
        target = match[1]
        parsed = urllib.parse.urlsplit(target)
        if parsed.scheme or target.startswith(("#", "//")):
            return match[0]
        path = pathlib.PurePosixPath(parsed.path)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("Release-note links must stay within the repository")
        return "](" + base + target + ")"
    return re.sub(r"\]\(([^\s)]+)\)", published_link, body) + "\n"


def installation_files(root):
    tracked = set(subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0"))
    if not ROOT_FILES <= tracked:
        raise ValueError("Installation package is missing required tracked public files")
    selected = set(ROOT_FILES)
    for name in tracked:
        if not name.startswith("docs/"):
            continue
        path = pathlib.PurePosixPath(name)
        if "archive" in path.parts or path.suffix.lower() not in DOC_SUFFIXES:
            raise ValueError("Unexpected file in the public documentation package")
        selected.add(name)
    for name in selected:
        path = root / name
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("Installation package may contain only regular public files")
    return sorted(selected)


def validate_local_links(root):
    for path in sorted(root.rglob("*.md")):
        source = path.read_text(encoding="utf-8")
        targets = [left or right for left, right in re.findall(r"\]\(\s*(?:<([^>]+)>|([^\s)]+))", source)]
        targets += [left or right for left, right in re.findall(r"(?m)^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))", source)]
        for target in targets:
            parsed = urllib.parse.urlsplit(target)
            if parsed.scheme or target.startswith(("#", "//")):
                continue
            destination = (path.parent / urllib.parse.unquote(parsed.path)).resolve()
            if not destination.is_relative_to(root.resolve()) or not destination.exists():
                raise ValueError(f"Broken packaged link in {path.relative_to(root)}: {target}")


def verify_installation(archive):
    with tempfile.TemporaryDirectory() as directory, zipfile.ZipFile(archive) as package:
        root = pathlib.Path(directory)
        for entry in package.infolist():
            path = pathlib.PurePosixPath(entry.filename)
            if path.is_absolute() or ".." in path.parts or entry.filename.endswith("/"):
                raise ValueError("Unexpected installation archive entry")
        package.extractall(root)
        validate_local_links(root)


def prepare(root, version, output, notes_file):
    validate_version(version)
    body = release_body((root / "RELEASE_NOTES.md").read_text(encoding="utf-8"), version)
    files = installation_files(root)
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()) or notes_file.exists():
        raise ValueError("Release staging paths must be empty; do not replace prepared assets")
    archive = output / f"watch-now-{version}-install.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
        for name in files:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            package.writestr(info, (root / name).read_bytes(), compresslevel=9)
    verify_installation(archive)
    source = subprocess.check_output(["git", "archive", "--format=tar", f"--prefix=watch-now-{version}/", "HEAD"], cwd=root)
    (output / f"watch-now-{version}.tar.gz").write_bytes(gzip.compress(source, compresslevel=9, mtime=0))
    notes_file.parent.mkdir(parents=True, exist_ok=True)
    notes_file.write_text(body, encoding="utf-8")


def finalize(output, version, digest):
    validate_version(version)
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("Expected the exact published image digest")
    names = [f"watch-now-{version}.tar.gz", f"watch-now-{version}-install.zip"]
    if not all((output / name).is_file() for name in names):
        raise ValueError("Checked release packages must exist before recording the image")
    if (output / "image-digest.txt").exists() or (output / "SHA256SUMS").exists():
        raise ValueError("Do not replace finalized release assets")
    verify_installation(output / names[1])
    (output / "image-digest.txt").write_text(f"{IMAGE}@{digest}\n", encoding="ascii")
    names.append("image-digest.txt")
    manifest = "".join(f"{hashlib.sha256((output / name).read_bytes()).hexdigest()}  {name}\n" for name in names)
    (output / "SHA256SUMS").write_text(manifest, encoding="ascii")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["prepare", "finalize"])
    parser.add_argument("version")
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("release"))
    parser.add_argument("--notes-file", type=pathlib.Path)
    parser.add_argument("--digest")
    args = parser.parse_args()
    if args.phase == "prepare":
        if not args.notes_file:
            parser.error("prepare requires --notes-file")
        prepare(args.root, args.version, args.output, args.notes_file)
    else:
        if not args.digest:
            parser.error("finalize requires --digest")
        finalize(args.output, args.version, args.digest)


if __name__ == "__main__":
    main()
