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

# Optional DVR overlay mounts only the explicitly supplied credential file.
dvr_env = dict(env, NOW_DVR_KEYS_HOST_FILE="/tmp/watch-now-test-dvr-keys.json")
dvr_config = json.loads(subprocess.check_output(
    ["docker", "compose", "-f", "compose.yaml", "-f", "compose.build.yaml", "-f", "compose.dvr.yaml", "config", "--format", "json"],
    cwd=root, env=dvr_env))
dvr_service = dvr_config["services"]["watch-now"]
assert dvr_service["environment"]["NOW_DVR_API_KEYS_FILE"] == "/run/secrets/watch_now_dvr_keys"
assert dvr_service["secrets"][0]["source"] == "watch_now_dvr_keys"
assert dvr_config["secrets"]["watch_now_dvr_keys"]["file"] == dvr_env["NOW_DVR_KEYS_HOST_FILE"]
assert dvr_service["read_only"] and "ALL" in dvr_service["cap_drop"]
print("Optional DVR credential mount tests passed.")

master_env = dict(env, NOW_DVR_MASTER_API_KEY="fixture-master-key")
master_config = json.loads(subprocess.check_output(
    ["docker", "compose", "-f", "compose.yaml", "config", "--format", "json"], cwd=root, env=master_env))
assert master_config["services"]["watch-now"]["environment"]["NOW_DVR_MASTER_API_KEY"] == "fixture-master-key"
master_file_env = dict(env, NOW_DVR_MASTER_KEY_HOST_FILE="/tmp/watch-now-master-key.txt")
master_file_config = json.loads(subprocess.check_output(
    ["docker", "compose", "-f", "compose.yaml", "-f", "compose.dvr-master.yaml", "config", "--format", "json"], cwd=root, env=master_file_env))
assert master_file_config["services"]["watch-now"]["environment"]["NOW_DVR_MASTER_API_KEY_FILE"] == "/run/secrets/watch_now_dvr_master_key"
assert master_file_config["secrets"]["watch_now_dvr_master_key"]["file"] == "/tmp/watch-now-master-key.txt"
print("Master DVR key configuration tests passed.")

qa_env = dict(env, NOW_QA_IMAGE="watch-now:qa-dvr-fixture",
              NOW_QA_HOST_BIND="127.0.0.1", NOW_QA_HOST_PORT="19195")
qa_config = json.loads(subprocess.check_output(
    ["docker", "compose", "-f", "compose.qa.yaml", "config", "--format", "json"], cwd=root, env=qa_env))
assert set(qa_config["services"]) == {"watch-now"}
qa_service = qa_config["services"]["watch-now"]
assert qa_service["image"] == qa_env["NOW_QA_IMAGE"] and qa_service["pull_policy"] == "never"
assert qa_service["ports"][0]["host_ip"] == "127.0.0.1"
assert qa_service["ports"][0]["published"] == "19195"
assert qa_service["environment"]["NOW_PROGRAM_SEARCH_ENABLED"] == "true"
assert qa_service["environment"]["NOW_DVR_MASTER_API_KEY_FILE"] == "/run/secrets/watch_now_dvr_master_key"
assert "NOW_DVR_MASTER_API_KEY" not in qa_service["environment"]
assert qa_service["read_only"] and "ALL" in qa_service["cap_drop"]
assert "no-new-privileges:true" in qa_service["security_opt"]
assert len(qa_service["secrets"]) == 1 and not qa_service.get("volumes")
missing_qa_env = dict(qa_env)
missing_qa_env.pop("NOW_QA_IMAGE")
assert subprocess.run(["docker", "compose", "-f", "compose.qa.yaml", "config", "--quiet"],
                      cwd=root, env=missing_qa_env, capture_output=True).returncode != 0
print("Isolated DVR QA configuration tests passed.")
