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

        # A follow-up after completion uses the original branch. The original
        # worktree was removed above, so it must be attached again rather than
        # recreated with -b and rejected as an existing branch.
        resumed_workspace, resumed_context = dispatcher.prepare_job_workspace(
            continuation_job, source.resolve()
        )
        if resumed_workspace != workspace or resumed_context is None:
            raise AssertionError("completed-job continuation did not reuse worktree path")
        if resumed_context.get("branch") != context.get("branch"):
            raise AssertionError("completed-job continuation changed branch")
        dispatcher.cleanup_git_worktree(resumed_context)

        dispatcher.PROJECT_CONFIGS["fixture-project"]["git"]["workspaceMode"] = "primary"
        primary_job = {
            "id": "33333333-4444-4555-8666-777777777777",
            "project": "fixture-project",
            "title": "Primary workspace publishing check",
        }
        primary_workspace, primary_context = dispatcher.prepare_job_workspace(
            primary_job, source.resolve()
        )
        if primary_workspace != source.resolve() or primary_context is None:
            raise AssertionError("primary mode did not use the canonical Ubuntu workspace")
        if primary_context.get("mode") != "primary":
            raise AssertionError(primary_context)
        primary_task = dispatcher.task_for(
            primary_job,
            dispatcher.get_project_config("fixture-project"),
            primary_workspace,
        )
        if "directly in the canonical Ubuntu Git workspace" not in primary_task:
            raise AssertionError(primary_task)
        if dispatcher.project_allows_parallel("fixture-project"):
            raise AssertionError("primary workspace project must be serialized")
        (primary_workspace / "app.js").write_text("module.exports = 'primary';\n", encoding="utf-8")
        primary_ok, primary_detail = dispatcher.publish_git_changes(
            primary_job, primary_context
        )
        if not primary_ok:
            raise AssertionError(primary_detail)
        if git(remote, "show", "main:app.js") != "module.exports = 'primary';":
            raise AssertionError("primary workspace change did not reach remote main")
        dispatcher.cleanup_git_worktree(primary_context)
        if not source.exists():
            raise AssertionError("primary workspace cleanup removed the canonical workspace")

        dispatcher.PROJECT_CONFIGS["fixture-project"]["git"]["workspaceMode"] = "worktree"

        dirty_job = {
            "id": "22222222-3333-4444-8555-666666666666",
            "project": "fixture-project",
            "title": "Dirty workspace safety check",
        }
        dirty_workspace, dirty_context = dispatcher.prepare_job_workspace(dirty_job, source.resolve())
        (dirty_workspace / "app.js").write_text("module.exports = 'candidate';\n", encoding="utf-8")
        (source / "local-only.txt").write_text("dirty\n", encoding="utf-8")
        # Stray edits in the primary checkout are leftover junk (jobs work in
        # isolated worktrees). They used to hard-fail the whole deployment as
        # UBUNTU_WORKSPACE_DIRTY; now they are auto-stashed and kept
        # recoverable while the publication continues.
        dirty_ok, dirty_detail = dispatcher.publish_git_changes(dirty_job, dirty_context)
        if not dirty_ok or "PRIMARY_STASH_OK" not in dirty_detail:
            raise AssertionError(dirty_detail)
        if (source / "local-only.txt").exists():
            raise AssertionError("stray file must be stashed out of the primary workspace")
        stash_list = git(source, "stash", "list")
        if "pseudo-codex-auto-stash job=" + dirty_job["id"] not in stash_list:
            raise AssertionError(stash_list)
        if git(remote, "show", "main:app.js") != "module.exports = 'candidate';":
            raise AssertionError("auto-recovered publication did not reach remote main")

        # A rerun whose branch predates newer base commits used to be doomed:
        # ChatGPT finished its work and publish died on GIT_REBASE_CONFLICT.
        # The stale commits must be archived and the branch restarted from the
        # current base before the agent runs.
        stale_job = {
            "id": "44444444-5555-4666-8777-888888888888",
            "project": "fixture-project",
            "title": "Stale branch refresh check",
        }
        stale_workspace, stale_context = dispatcher.prepare_job_workspace(stale_job, source.resolve())
        (stale_workspace / "app.js").write_text("module.exports = 'stale';\n", encoding="utf-8")
        git(stale_workspace, "add", "app.js")
        git(stale_workspace, "commit", "-m", "stale work")
        (source / "app.js").write_text("module.exports = 'mainline';\n", encoding="utf-8")
        git(source, "add", "app.js")
        git(source, "commit", "-m", "mainline change")
        git(source, "push", "origin", "main")
        refreshed_workspace, _refreshed_context = dispatcher.prepare_job_workspace(stale_job, source.resolve())
        if refreshed_workspace != stale_workspace:
            raise AssertionError("refresh changed the worktree path")
        refreshed_app = (refreshed_workspace / "app.js").read_text(encoding="utf-8")
        if refreshed_app != "module.exports = 'mainline';\n":
            raise AssertionError("stale branch was not reset onto the current base: " + refreshed_app)
        archives = git(stale_workspace, "branch", "--list", "archive/*")
        if "archive/" not in archives:
            raise AssertionError("conflicting stale work was not archived: " + archives)

        # In-progress edits must survive a reuse untouched.
        (stale_workspace / "app.js").write_text("module.exports = 'wip';\n", encoding="utf-8")
        dispatcher.prepare_job_workspace(stale_job, source.resolve())
        if (stale_workspace / "app.js").read_text(encoding="utf-8") != "module.exports = 'wip';\n":
            raise AssertionError("dirty worktree was clobbered by the refresh")

        print("DISPATCHER_GIT_MAIN_SYNC_OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
