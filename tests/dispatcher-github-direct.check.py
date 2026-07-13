#!/usr/bin/env python3
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
    root = Path(tempfile.mkdtemp(prefix="pseudo-codex-github-direct-"))
    try:
        projects = root / "projects"
        source = projects / "fixture-project"
        author = root / "author"
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

        subprocess.run(["git", "clone", str(remote), str(author)], check=True, capture_output=True)
        git(author, "config", "user.name", "GitHub Direct Test")
        git(author, "config", "user.email", "github-direct@example.invalid")
        git(author, "switch", "-c", "chatgpt-job/direct-check", "origin/main")
        (author / "app.js").write_text("module.exports = 'after';\n", encoding="utf-8")
        git(author, "add", "app.js")
        git(author, "commit", "-m", "direct change")
        commit_sha = git(author, "rev-parse", "HEAD")
        git(author, "push", "-u", "origin", "chatgpt-job/direct-check")

        config_path = root / "projects.json"
        config = {
            "fixture-project": {
                "workspace": str(source),
                "requiresDeployment": False,
                "executionMode": "github_direct",
                "git": {
                    "enabled": True,
                    "repository": "example/request-console",
                    "remote": "origin",
                    "baseBranch": "main",
                    "branchPrefix": "chatgpt-job",
                    "push": True,
                },
            }
        }
        config_path.write_text(json.dumps(config), encoding="utf-8")
        os.environ.update({
            "PSEUDO_CODEX_PROJECT_ROOT": str(projects),
            "PSEUDO_CODEX_PROJECT_CONFIG": str(config_path),
            "PSEUDO_CODEX_STATE_DIR": str(state),
        })

        dispatcher_path = Path(__file__).parent.parent / "dispatcher" / "dispatcher.py"
        spec = importlib.util.spec_from_file_location("dispatcher_github_direct_check", dispatcher_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("cannot load dispatcher")
        dispatcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dispatcher)

        job = {"id": "direct-check", "project": "fixture-project", "title": "direct"}
        cwd, context = dispatcher.prepare_job_workspace(job, source.resolve(), config["fixture-project"])
        assert cwd == source.resolve()
        assert context and context["mode"] == "github_direct"
        output = "\n".join([
            "===GITHUB_COMPLETE===",
            json.dumps({
                "repository": "example/request-console",
                "branch": "chatgpt-job/direct-check",
                "baseBranch": "main",
                "commitSha": commit_sha,
                "pullRequestUrl": "https://github.com/example/request-console/pull/1",
                "changedFiles": ["app.js"],
                "summary": "done",
            }),
            "===END_GITHUB_COMPLETE===",
        ])
        ok, detail = dispatcher.publish_github_direct_changes(
            job, context, output, config["fixture-project"]
        )
        if not ok:
            raise AssertionError(detail)
        if git(source, "rev-parse", "HEAD") != commit_sha:
            raise AssertionError("source workspace did not fast-forward")
        if git(remote, "rev-parse", "main") != commit_sha:
            raise AssertionError("remote main did not fast-forward")
        dispatcher.cleanup_git_worktree(context)
        print("DISPATCHER_GITHUB_DIRECT_OK")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
