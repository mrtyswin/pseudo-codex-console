#!/usr/bin/env python3
"""Isolated regression check for dispatcher Git worktree publishing."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(cwd), *args],
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stdout or "") + (result.stderr or ""))
    return result.stdout.strip()


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="pseudo-codex-dispatcher-git-"))
    try:
        projects = root / "projects"
        source = projects / "request-console"
        remote = root / "remote.git"
        state = root / "state"
        source.mkdir(parents=True)
        subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
        git(source, "init", "-b", "main")
        git(source, "config", "user.name", "Pseudo Codex Test")
        git(source, "config", "user.email", "pseudo-codex@example.invalid")
        (source / "app.js").write_text("module.exports = 'before';\n", encoding="utf-8")
        git(source, "add", "app.js")
        git(source, "commit", "-m", "initial")
        git(source, "remote", "add", "origin", str(remote))
        git(source, "push", "-u", "origin", "main")

        config_path = root / "projects.json"
        config_path.write_text(json.dumps({
            "request-console": {
                "workspace": str(source),
                "requiresDeployment": False,
                "git": {
                    "enabled": True,
                    "remote": "origin",
                    "baseBranch": "main",
                    "branchPrefix": "chatgpt-job",
                    "push": True,
                },
            }
        }), encoding="utf-8")
        os.environ.update({
            "PSEUDO_CODEX_PROJECT_ROOT": str(projects),
            "PSEUDO_CODEX_PROJECT_CONFIG": str(config_path),
            "PSEUDO_CODEX_STATE_DIR": str(state),
        })

        dispatcher_path = Path(os.environ.get(
            "DISPATCHER_PATH",
            Path(__file__).parent.parent / "dispatcher" / "dispatcher.py",
        ))
        spec = importlib.util.spec_from_file_location("pseudo_codex_dispatcher_check", dispatcher_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("cannot load dispatcher module")
        dispatcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dispatcher)

        job = {
            "id": "11111111-2222-4333-8444-555555555555",
            "project": "request-console",
            "title": "Git publishing check",
        }
        workspace, context = dispatcher.prepare_job_workspace(job, source.resolve())
        (workspace / "app.js").write_text("module.exports = 'after';\n", encoding="utf-8")
        ok, detail = dispatcher.publish_git_changes(job, context)
        if not ok or "push=ok" not in detail:
            raise AssertionError(detail)
        branch = "chatgpt-job/" + job["id"]
        published = git(remote, "show", f"{branch}:app.js")
        if published != "module.exports = 'after';":
            raise AssertionError(published)
        dispatcher.cleanup_git_worktree(context)
        if workspace.exists():
            raise AssertionError("completed worktree was not removed")
        print("DISPATCHER_GIT_PUBLISH_OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
