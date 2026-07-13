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

    try:
        module.prepare_job_workspace(
            {"id": "host-native", "project": "request-console"},
            resolved,
            config["request-console"],
        )
    except RuntimeError as exc:
        assert "REQUEST_CONSOLE_CODEX_CLI_ONLY" in str(exc)
    else:
        raise AssertionError("request-console self-maintenance was accepted by the browser dispatcher")

    verify_config = dict(config["request-console"], executionMode="verify_only")
    assert module.prepare_job_workspace(
        {"id": "verify-only", "project": "request-console"},
        resolved,
        verify_config,
    ) == (resolved, None)

    source = dispatcher_path.read_text(encoding="utf-8")
    assert '"--host-native"' in source
    assert "AUTO_DEPLOY_SKIPPED_NO_CHANGES" in source
    assert "AGENT_LAUNCHER_NOT_EXECUTABLE" in source
    assert module.agent_marker(
        'ordinary output\n===AGENT_BLOCKED==={"reason":"turn budget","errorClass":"turn_budget"}',
        module.BLOCKED_MARKER,
    ) == {"reason": "turn budget", "errorClass": "turn_budget"}
    assert module.agent_marker("ordinary output", module.FATAL_MARKER) is None

print("DISPATCHER_HOST_NATIVE_EXECUTION_OK")
