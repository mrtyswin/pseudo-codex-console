#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

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

    lock_path = Path(os.environ["PSEUDO_CODEX_STATE_DIR"]) / "browser-restart.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    marker_path = Path(temporary) / "claim-reached-api"
    child_code = f"""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('dispatcher_child', {str(root / 'dispatcher' / 'dispatcher.py')!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def fake_api(method, path, payload=None):
    Path({str(marker_path)!r}).write_text('reached', encoding='utf-8')
    return 204, None
module.api_json = fake_api
module.claim_next_job()
"""
    with lock_path.open("a+", encoding="utf-8") as restart_lock:
        fcntl.flock(restart_lock.fileno(), fcntl.LOCK_EX)
        child = subprocess.Popen([sys.executable, "-c", child_code], env=os.environ.copy())
        time.sleep(0.3)
        assert child.poll() is None
        assert not marker_path.exists()
        fcntl.flock(restart_lock.fileno(), fcntl.LOCK_UN)
        assert child.wait(timeout=5) == 0
    assert marker_path.read_text(encoding="utf-8") == "reached"

print("DISPATCHER_PARALLEL_POOL_OK")
