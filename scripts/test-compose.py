#!/usr/bin/env python3
"""Check documented configuration reaches image-only and source-built stacks."""
import json
import os
import pathlib
import re
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
settings = dict(re.findall(r"^#?\s*((?:NOW_|DISPATCHARR_)[A-Z_]+)=(.*)$", (root / ".env.example").read_text(), re.M))
settings.update(DISPATCHARR_URL="http://dispatcharr.test:9191", NOW_COOKIE_SECURE="true",
                NOW_TRUST_PROXY_HEADERS="true", NOW_SESSION_IDLE_TIMEOUT="15m",
                NOW_HOST_PORT="19292", NOW_HOST_BIND="127.0.0.1")
env = dict(os.environ, **settings)
for files in [["compose.yaml"], ["compose.release.yaml"], ["compose.yaml", "compose.build.yaml"]]:
    command = ["docker", "compose"]
    for file in files:
        command += ["-f", file]
    result = subprocess.check_output(command + ["config", "--format", "json"], cwd=root, env=env)
    service = json.loads(result)["services"]["watch-now"]
    for key, value in settings.items():
        if key in {"NOW_HOST_PORT", "NOW_HOST_BIND", "NOW_IMAGE"}:
            continue
        assert str(service["environment"].get(key)) == value, (files, key, service["environment"].get(key))
    assert service["ports"][0]["host_ip"] == "127.0.0.1"
    assert service["ports"][0]["published"] == "19292"
    assert service["read_only"] and "ALL" in service["cap_drop"]
    assert ("build" in service) == ("compose.build.yaml" in files)

test_env = dict(env, NOW_TEST_IMAGE="ghcr.io/jermzone/watch-now@sha256:" + "0" * 64,
                NOW_TEST_HOST_BIND="127.0.0.1", NOW_TEST_HOST_PORT="9194")
test_config = json.loads(subprocess.check_output(
    ["docker", "compose", "-f", "compose.test.yaml", "config", "--format", "json"],
    cwd=root, env=test_env))
assert set(test_config["services"]) == {"watch-now-test"}
test_service = test_config["services"]["watch-now-test"]
assert test_service["image"] == test_env["NOW_TEST_IMAGE"]
assert "build" not in test_service and not test_service.get("volumes")
assert test_service["ports"][0]["published"] == "9194"
assert test_service["ports"][0]["host_ip"] == "127.0.0.1"
assert test_service["environment"]["DISPATCHARR_URL"] == settings["DISPATCHARR_URL"]
assert test_service["read_only"] and "ALL" in test_service["cap_drop"]
assert "no-new-privileges:true" in test_service["security_opt"]
missing_image_env = dict(test_env)
missing_image_env.pop("NOW_TEST_IMAGE")
missing_image = subprocess.run(
    ["docker", "compose", "-f", "compose.test.yaml", "config"],
    cwd=root, env=missing_image_env, capture_output=True)
assert missing_image.returncode != 0 and b"NOW_TEST_IMAGE" in missing_image.stderr
print("Compose configuration forwarding tests passed.")
