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

    job_workspace, git_context = module.prepare_job_workspace(
        {"id": "host-native", "project": "request-console"},
        resolved,
        config["request-console"],
    )
    assert job_workspace == resolved
    assert git_context is None

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

    stale_handoff = """Task instruction:
===AGENT_BLOCKED==={"reason":"old limit","errorClass":"model_usage_limit"}
When verified, output ===TASK_COMPLETE=== on its own line.
Sending to ChatGPT... (turn 1)
===AGENT_FATAL==={"reason":"selector unavailable"}
"""
    protocol_tail = module.agent_protocol_tail(stale_handoff)
    assert module.agent_marker(protocol_tail, module.BLOCKED_MARKER) is None
    assert module.agent_marker(protocol_tail, module.FATAL_MARKER) == {
        "reason": "selector unavailable"
    }
    assert module.COMPLETE_MARKER not in protocol_tail

    recovered_handoff = stale_handoff.rsplit("Sending to ChatGPT...", 1)[0] + """Sending to ChatGPT... (turn 1)
Recovered successfully.
===TASK_COMPLETE===
"""
    recovered_tail = module.agent_protocol_tail(recovered_handoff)
    assert module.agent_marker(recovered_tail, module.BLOCKED_MARKER) is None
    assert module.COMPLETE_MARKER in recovered_tail

print("DISPATCHER_HOST_NATIVE_EXECUTION_OK")
