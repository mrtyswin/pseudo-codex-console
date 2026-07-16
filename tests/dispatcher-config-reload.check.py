#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    projects = root / "projects"
    workspace = projects / "request-console"
    workspace.mkdir(parents=True)
    config_path = root / "projects.json"
    initial = {"request-console": {"workspace": str(workspace), "executionMode": "local"}}
    config_path.write_text(json.dumps(initial), encoding="utf-8")
    os.environ["PSEUDO_CODEX_PROJECT_ROOT"] = str(projects)
    os.environ["PSEUDO_CODEX_PROJECT_CONFIG"] = str(config_path)
    os.environ["PSEUDO_CODEX_STATE_DIR"] = str(root / "state")

    dispatcher_path = Path(__file__).resolve().parents[1] / "dispatcher" / "dispatcher.py"
    spec = importlib.util.spec_from_file_location("dispatcher_config_reload_check", dispatcher_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    assert module.get_project_config("request-console")["executionMode"] == "local"

    updated = {"request-console": {"workspace": str(workspace), "executionMode": "verify_only"}}
    time.sleep(0.01)
    config_path.write_text(json.dumps(updated), encoding="utf-8")
    assert module.get_project_config("request-console")["executionMode"] == "verify_only"

    time.sleep(0.01)
    config_path.write_text("{broken", encoding="utf-8")
    assert module.get_project_config("request-console")["executionMode"] == "verify_only"

    invalid_container_service = {
        "request-console": {
            "workspace": str(workspace),
            "requiresDeployment": True,
            "deployCommand": "/usr/local/libexec/example-deploy",
            "productionRoot": "docker-compose://example",
            "service": "example-wordpress-1",
        }
    }
    config_path.write_text(json.dumps(invalid_container_service), encoding="utf-8")
    try:
        module.load_project_configs()
    except RuntimeError as exc:
        assert "must be a systemd .service unit" in str(exc)
    else:
        raise AssertionError("a Docker container name was accepted as a systemd service")

    invalid_docker_systemd_mix = {
        "request-console": {
            "workspace": str(workspace),
            "requiresDeployment": True,
            "deployCommand": "/usr/local/libexec/example-deploy",
            "productionRoot": "docker-compose://example",
            "service": "example.service",
        }
    }
    config_path.write_text(json.dumps(invalid_docker_systemd_mix), encoding="utf-8")
    try:
        module.load_project_configs()
    except RuntimeError as exc:
        assert "uses Docker Compose" in str(exc)
    else:
        raise AssertionError("Docker Compose and systemd service checks were allowed together")

print("DISPATCHER_DYNAMIC_CONFIG_RELOAD_OK")
