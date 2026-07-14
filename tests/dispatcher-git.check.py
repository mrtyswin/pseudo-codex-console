#!/usr/bin/env python3
"""Isolated regression check for dispatcher Git publishing and synchronization."""

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
        source = projects / "fixture-project"
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
            "fixture-project": {
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
            "project": "fixture-project",
            "title": "Git publishing check",
        }
        workspace, context = dispatcher.prepare_job_workspace(job, source.resolve())
        task = dispatcher.task_for(job, dispatcher.get_project_config("fixture-project"), workspace)
        if f"JOB WORKSPACE (authoritative): {workspace}" not in task:
            raise AssertionError(task)
        if f'"workspace": "{workspace}"' not in task:
            raise AssertionError(task)

        continuation_job = {
            "id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "project": "fixture-project",
            "title": "Continuation workspace check",
            "parentJobId": job["id"],
            "rootJobId": job["id"],
        }
        continuation_workspace, continuation_context = dispatcher.prepare_job_workspace(
            continuation_job, source.resolve()
        )
        if continuation_workspace != workspace:
            raise AssertionError(
                f"continuation changed worktree: {workspace} -> {continuation_workspace}"
            )
        if continuation_context is None or continuation_context["branch"] != context["branch"]:
            raise AssertionError("continuation changed the job branch")
        if continuation_context.get("workspaceOwnerJobId") != job["id"]:
            raise AssertionError("continuation did not retain the root workspace owner")
        (workspace / "app.js").write_text("module.exports = 'after';\n", encoding="utf-8")
        ok, detail = dispatcher.publish_git_changes(job, context)
        if not ok:
            raise AssertionError(detail)
        for marker in (
            "push結果: ok",
            "main反映結果: fast-forward",
            "Ubuntu同期結果: ok",
            "PUBLISH_VERIFY_OK",
        ):
            if marker not in detail:
                raise AssertionError(detail)

        branch = "chatgpt-job/" + job["id"]
        published_branch = git(remote, "show", f"{branch}:app.js")
        published_main = git(remote, "show", "main:app.js")
        local_main = (source / "app.js").read_text(encoding="utf-8").strip()
        if published_branch != "module.exports = 'after';":
            raise AssertionError(published_branch)
        if published_main != "module.exports = 'after';":
            raise AssertionError(published_main)
        if local_main != "module.exports = 'after';":
            raise AssertionError(local_main)
        if git(source, "rev-parse", "HEAD") != git(remote, "rev-parse", "main"):
            raise AssertionError("Ubuntu workspace and remote main SHA differ")

        dispatcher.cleanup_git_worktree(context)
        if workspace.exists():
            raise AssertionError("completed worktree was not removed")

        dirty_job = {
            "id": "22222222-3333-4444-8555-666666666666",
            "project": "fixture-project",
            "title": "Dirty workspace safety check",
        }
        dirty_workspace, dirty_context = dispatcher.prepare_job_workspace(dirty_job, source.resolve())
        before_main = git(remote, "rev-parse", "main")
        (dirty_workspace / "app.js").write_text("module.exports = 'candidate';\n", encoding="utf-8")
        (source / "local-only.txt").write_text("dirty\n", encoding="utf-8")
        dirty_ok, dirty_detail = dispatcher.publish_git_changes(dirty_job, dirty_context)
        if dirty_ok or "UBUNTU_WORKSPACE_DIRTY" not in dirty_detail:
            raise AssertionError(dirty_detail)
        if git(remote, "rev-parse", "main") != before_main:
            raise AssertionError("remote main changed while Ubuntu workspace was dirty")

        print("DISPATCHER_GIT_MAIN_SYNC_OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
