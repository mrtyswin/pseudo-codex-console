#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    projects = root / "projects"
    workspace = projects / "request-console"
    workspace.mkdir(parents=True)
    config_path = root / "projects.json"
    config = {
        "request-console": {
            "workspace": str(workspace),
            "executionMode": "local",
            "requiresDeployment": False,
        }
    }
    config_path.write_text(json.dumps(config), encoding="utf-8")
    os.environ["PSEUDO_CODEX_PROJECT_ROOT"] = str(projects)
    os.environ["PSEUDO_CODEX_PROJECT_CONFIG"] = str(config_path)
    os.environ["PSEUDO_CODEX_STATE_DIR"] = str(root / "state")

    dispatcher_path = Path(__file__).resolve().parents[1] / "dispatcher" / "dispatcher.py"
    spec = importlib.util.spec_from_file_location("dispatcher_host_native_check", dispatcher_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    resolved = module.project_path("request-console", config["request-console"])
    assert resolved == workspace.resolve()
    module.ensure_host_native_workspace(resolved)
    try:
        module.ensure_host_native_workspace(Path("/mnt") / "workspace")
    except RuntimeError as exc:
        assert "SANDBOX_WORKSPACE_DISABLED" in str(exc)
    else:
        raise AssertionError("disabled workspace was accepted")

    launcher = root / "chatgpt-browser-agent"
    launcher.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    launcher.chmod(0o644)
    module.AGENT = str(launcher)
    try:
        module.verify_agent_launcher()
    except RuntimeError as exc:
        assert "AGENT_LAUNCHER_NOT_EXECUTABLE" in str(exc)
    else:
        raise AssertionError("non-executable launcher was accepted")
    launcher.chmod(0o755)
    assert module.verify_agent_launcher() == launcher.resolve()

    task = module.task_for(
        {"id": "host-native", "project": "request-console", "title": "ssh", "instruction": "ssh今とじてるん？"},
        config["request-console"],
    )
    assert "directly on the Ubuntu host" in task
    assert "available sandbox tools" not in task

    source = dispatcher_path.read_text(encoding="utf-8")
    assert '"--host-native"' in source
    assert "AUTO_DEPLOY_SKIPPED_NO_CHANGES" in source
    assert "AGENT_LAUNCHER_NOT_EXECUTABLE" in source

print("DISPATCHER_HOST_NATIVE_EXECUTION_OK")
