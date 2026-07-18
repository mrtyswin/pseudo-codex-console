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

    from datetime import datetime, timedelta, timezone

    live_lease = (datetime.now(timezone.utc) + timedelta(seconds=120)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    dead_lease = "2020-01-01T00:00:00.000Z"
    module.api_json = lambda method, path, payload=None: (200, {"jobs": [
        {"id": "failed-job", "status": "running", "stage": "waiting_chatgpt", "leaseExpiresAt": live_lease},
        {"id": "other-job", "status": "running", "stage": "waiting_chatgpt", "leaseExpiresAt": live_lease},
    ]})
    recovery = module.recover_browser_after_failure("failed-job")
    assert "other active sessions=other-job" in recovery

    # A job whose lease has expired is dead and must not block the restart:
    # on 2026-07-17 two wedged workers blocked each other all night.
    module.restart_browser = lambda: "STUB_RESTART"
    module.api_json = lambda method, path, payload=None: (200, {"jobs": [
        {"id": "failed-job", "status": "running", "stage": "waiting_chatgpt", "leaseExpiresAt": dead_lease},
        {"id": "other-job", "status": "running", "stage": "waiting_chatgpt", "leaseExpiresAt": dead_lease},
    ]})
    assert module.recover_browser_after_failure("failed-job") == "STUB_RESTART"

    # The consecutive-infra-failure watchdog forces a restart past the guard.
    forced = module.recover_browser_after_failure("failed-job", force=True)
    assert "BROWSER_RESTART_FORCED" in forced and "STUB_RESTART" in forced

    assert module.is_infra_failure("ChatGPT browser request failed: [ERROR] spawnSync node ETIMEDOUT")
    assert module.is_infra_failure("[ERROR] CHATGPT_SEND_BUTTON_UNAVAILABLE after prompt input")
    assert module.is_infra_failure("ChatGPT browser request failed: [ERROR] [ERROR] Waiting failed: 60000ms exceeded")
    assert module.is_infra_failure("ChatGPT browser request failed: [ERROR] [ERROR] socket hang up")
    assert not module.is_infra_failure("Agent exited 1; completion marker missing.")
    assert module.FORCED_RESTART_AFTER_FAILURES == 2
    assert module.note_infra_failure() is False
    assert module.note_infra_failure() is True
    assert module.note_infra_failure() is False  # cooldown holds the next one back
    module.note_browser_responsive()

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
