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

print("DISPATCHER_DYNAMIC_CONFIG_RELOAD_OK")
