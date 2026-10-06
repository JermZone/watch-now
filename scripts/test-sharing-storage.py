#!/usr/bin/env python3
"""Exercise sharing storage in disposable, hardened containers; never print keys."""
import io
import os
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

image = sys.argv[1] if len(sys.argv) > 1 else "watch-now:ci"
prefix = "watch-now-share-test-" + uuid.uuid4().hex
containers = []
volumes = []


def docker(*args):
    result = subprocess.run(["docker", *args], capture_output=True)
    if result.returncode:
        # Docker errors can include environment values: keep failures nonsecret.
        raise RuntimeError("Docker sharing storage test operation failed")
    return result.stdout


def volume(suffix):
    name = prefix + suffix
    docker("volume", "create", name)
    volumes.append(name)
    return name


def start(suffix, storage=None, readonly=False, explicit=None, directory=True):
    name = prefix + suffix
    args = ["run", "-d", "--name", name, "--pull=never", "--network=none",
            "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
            "--pids-limit=100", "--memory=256m", "-e", "DISPATCHARR_URL=http://127.0.0.1:9"]
    if directory:
        args += ["-e", "NOW_SHARE_KEY_DIR=/var/lib/watch-now"]
    if explicit:
        args += ["-e", "NOW_SHARE_KEY=" + explicit]
    if storage:
        mount = "type=volume,source=" + storage + ",target=/var/lib/watch-now"
        args += ["--mount", mount + (",readonly" if readonly else "")]
    containers.append(name)
    docker(*args, image)
    for _ in range(30):
        check = subprocess.run(["docker", "exec", name, "/watch-now", "healthcheck"], capture_output=True)
        if check.returncode == 0:
            return name
        time.sleep(0.5)
    raise RuntimeError("Sharing storage failure prevented healthy playback startup")


def saved_key(name):
    try:
        archive = docker("cp", name + ":/var/lib/watch-now/share-key", "-")
    except RuntimeError:
        # Only report directory metadata and a warning flag, never file contents,
        # environment values or raw application/Docker output.
        with tarfile.open(fileobj=io.BytesIO(docker("cp", name + ":/var/lib/watch-now", "-"))) as files:
            entry = files.getmembers()[0]
            raise RuntimeError("Sharing key unavailable: directory uid=%d gid=%d mode=%04o warning=%s" %
                               (entry.uid, entry.gid, entry.mode, warning(name))) from None
    with tarfile.open(fileobj=io.BytesIO(archive)) as files:
        entry = files.getmembers()[0]
        assert entry.uid == 65532 and entry.gid == 65532 and entry.mode == 0o600
        value = files.extractfile(entry).read().strip()
        assert len(value) == 64 and len(bytes.fromhex(value.decode())) == 32
        return value


def warning(name):
    return b"Sharing unavailable;" in docker("logs", name)


try:
    store = volume("-persistent")
    first = start("-fresh", store)
    key = saved_key(first)
    assert not warning(first) and key not in docker("logs", first)
    docker("rm", "-f", first)
    second = start("-recreated", store)
    assert saved_key(second) == key and not warning(second)
    docker("rm", "-f", second)
    # A saved private key can be read from a read-only backup mount.
    third = start("-readonly-existing", store, readonly=True)
    assert saved_key(third) == key and not warning(third)
    docker("rm", "-f", third)
    # Corruption must disable sharing without silently changing the file.
    with tempfile.TemporaryDirectory() as temp:
        path = os.path.join(temp, "share-key")
        with open(path, "w") as file:
            file.write("damaged-key")
        os.chmod(path, 0o600)
        stopped = prefix + "-corrupt-writer"
        containers.append(stopped)
        docker("create", "--name", stopped, "--mount",
               "type=volume,source=" + store + ",target=/var/lib/watch-now", image)
        docker("cp", path, stopped + ":/var/lib/watch-now/share-key")
        docker("rm", stopped)
    corrupt = start("-corrupt", store)
    assert warning(corrupt)
    with tarfile.open(fileobj=io.BytesIO(docker("cp", corrupt + ":/var/lib/watch-now/share-key", "-"))) as files:
        assert files.extractfile(files.getmembers()[0]).read() == b"damaged-key"
    blank = volume("-blank-readonly")
    assert warning(start("-readonly-blank", blank, readonly=True))
    assert warning(start("-unmounted"))
    override = start("-explicit", blank, readonly=True, explicit="ab" * 32)
    assert not warning(override) and ("ab" * 32).encode() not in docker("logs", override)
    assert not warning(start("-disabled", directory=False))
    print("Sharing storage container tests passed: fresh, persistent, private, explicit, readonly and damaged storage.")
finally:
    for name in containers:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    for name in volumes:
        subprocess.run(["docker", "volume", "rm", name], capture_output=True)
