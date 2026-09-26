#!/usr/bin/env python3
"""Render a launchd plist from an operator-owned JSON file outside the checkout."""
import argparse
import json
import os
import plistlib
from pathlib import Path
from urllib.parse import urlparse


def render(config):
    required = ("user", "group", "home", "checkout", "gitmon_bin", "path", "repo", "api_base")
    for key in required:
        if not isinstance(config.get(key), str) or not config[key].strip():
            raise ValueError("missing nonempty setting: " + key)
        if "<" in config[key] or ">" in config[key]:
            raise ValueError("replace the example placeholder: " + key)
    for key in ("home", "checkout", "gitmon_bin"):
        if not Path(config[key]).is_absolute():
            raise ValueError(key + " must be an absolute path")
    api = urlparse(config["api_base"])
    if api.scheme not in ("http", "https") or not api.hostname or api.username or api.password:
        raise ValueError("api_base must be an HTTP(S) URL without credentials")
    instance = config.get("instance", "default")
    if not isinstance(instance, str) or not instance or "/" in instance or instance in (".", ".."):
        raise ValueError("instance must be a single directory name")
    data_home = config.get("paperclip_home", str(Path(config["home"]) / ".paperclip"))
    if not Path(data_home).is_absolute():
        raise ValueError("paperclip_home must be an absolute path")
    logs = Path(data_home) / "instances" / instance / "logs"
    env = {
        "HOME": config["home"],
        "PATH": config["path"],
        "PAPERCLIP_HOME": data_home,
        "PAPERCLIP_INSTANCE_ID": instance,
        "PAPERCLIP_DEPLOY_REPO": config["repo"],
        "PAPERCLIP_DEPLOY_API_BASE": config["api_base"],
        "PAPERCLIP_DEPLOY_BUILD_WHEN": config.get("build_when", "idle"),
        "PAPERCLIP_DEPLOY_DAEMON_LABEL": config.get("daemon_label", "ing.paperclip.paperclipai"),
    }
    if config.get("git_exec_path"):
        env["GIT_EXEC_PATH"] = config["git_exec_path"]
    if config.get("revision_map"):
        if not Path(config["revision_map"]).is_absolute():
            raise ValueError("revision_map must be an absolute path")
        env["PAPERCLIP_DEPLOY_REVISION_MAP"] = config["revision_map"]
    return {
        "Label": "ing.paperclip.gitmon",
        "UserName": config["user"],
        "GroupName": config["group"],
        "WorkingDirectory": config["checkout"],
        "ProgramArguments": [config["gitmon_bin"], "-i", str(config.get("poll_seconds", 300)),
                             str(Path(config["checkout"]) / "deploy" / "macos" / "deploy.sh")],
        "EnvironmentVariables": env,
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 30,
        "ProcessType": "Background",
        "StandardOutPath": str(logs / "gitmon.log"),
        "StandardErrorPath": str(logs / "gitmon.err.log"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    checkout = Path(__file__).resolve().parents[2]
    for path in (args.config, args.output):
        if path.resolve() == checkout or checkout in path.resolve().parents:
            parser.error("keep operator configuration and generated plists outside the checkout")
    result = render(json.loads(args.config.read_text()))
    # Refuse to overwrite an existing file or follow an output symlink.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        plistlib.dump(result, output)


if __name__ == "__main__":
    main()
