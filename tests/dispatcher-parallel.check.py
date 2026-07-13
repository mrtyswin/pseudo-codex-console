#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as temporary:
    project_root = Path(temporary) / "projects"
    workspace = project_root / "request-console"
    workspace.mkdir(parents=True)
    config_path = Path(temporary) / "projects.json"
    config_path.write_text(json.dumps({
        "request-console": {"workspace": str(workspace), "requiresDeployment": False}
    }), encoding="utf-8")
    os.environ["PSEUDO_CODEX_PROJECT_CONFIG"] = str(config_path)
    os.environ["PSEUDO_CODEX_PROJECT_ROOT"] = str(project_root)
    os.environ["PSEUDO_CODEX_STATE_DIR"] = str(Path(temporary) / "state")
    os.environ["PSEUDO_CODEX_MAX_WORKERS"] = "2"

    spec = importlib.util.spec_from_file_location("dispatcher_under_test", root / "dispatcher" / "dispatcher.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    captured = {}
    def fake_api(method, path, payload=None):
        captured.update(payload or {})
        return 204, None

    module.api_json = fake_api
    assert module.claim_next_job({"request-console"}) is None
    assert captured["excludedProjects"] == ["request-console"]
    assert module.MAX_WORKERS == 2
    assert module.project_allows_parallel("request-console") is False
    recovery = module.recover_browser_after_failure()
    assert "BROWSER_RESTART_SKIPPED_SHARED_DAEMON" in recovery
    assert "systemctl" not in recovery

print("DISPATCHER_PARALLEL_POOL_OK")
