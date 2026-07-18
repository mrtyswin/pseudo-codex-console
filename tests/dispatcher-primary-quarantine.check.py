#!/usr/bin/env python3
"""Isolated regression check: a failed primary-mode job must leave the
canonical workspace clean, with the abandoned changes preserved in a stash
entry and a patch file."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
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
    root = Path(tempfile.mkdtemp(prefix="pseudo-codex-quarantine-"))
    try:
        source = root / "workspace"
        state = root / "state"
        project_config = root / "projects.json"
        source.mkdir(parents=True)
        project_config.write_text("{}\n", encoding="utf-8")
        git(source, "init", "-b", "main")
        git(source, "config", "user.name", "Pseudo Codex Test")
        git(source, "config", "user.email", "pseudo-codex@example.invalid")
        (source / "app.js").write_text("module.exports = 'before';\n", encoding="utf-8")
        git(source, "add", "app.js")
        git(source, "commit", "-m", "initial")

        os.environ.update({
            "PSEUDO_CODEX_STATE_DIR": str(state),
            "PSEUDO_CODEX_PROJECT_CONFIG": str(project_config),
        })
        dispatcher_path = Path(os.environ.get(
            "DISPATCHER_PATH",
            Path(__file__).parent.parent / "dispatcher" / "dispatcher.py",
        ))
        spec = importlib.util.spec_from_file_location("pseudo_codex_dispatcher_quarantine", dispatcher_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("cannot load dispatcher module")
        dispatcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dispatcher)

        context = {
            "mode": "primary",
            "source": source,
            "worktree": source,
            "branch": "main",
            "remote": "origin",
            "baseBranch": "main",
            "push": True,
        }

        # A clean workspace must be reported as such and left untouched.
        note = dispatcher.quarantine_primary_workspace("job-clean", context)
        assert note == "PRIMARY_WORKSPACE_CLEAN", note

        # Dirty the workspace like an abandoned job: tracked edit + new file.
        (source / "app.js").write_text("module.exports = 'abandoned';\n", encoding="utf-8")
        (source / "leftover.txt").write_text("untracked leftover\n", encoding="utf-8")

        # A message-cap deferral must be able to return to the same primary
        # workspace without discarding its already-valid edits.
        ready, detail = dispatcher.validate_primary_workspace(source, "main")
        assert not ready and detail == "UBUNTU_WORKSPACE_DIRTY", detail
        ready, detail = dispatcher.validate_primary_workspace(source, "main", allow_dirty_resume=True)
        assert ready and detail == "UBUNTU_WORKSPACE_RESUME_DIRTY", detail

        note = dispatcher.quarantine_primary_workspace("job-dirty", context)
        assert note.startswith("PRIMARY_WORKSPACE_QUARANTINED"), note
        assert "workspace=clean" in note, note

        # The workspace must now pass the same preflight that used to fail.
        ready, detail = dispatcher.validate_primary_workspace(source, "main")
        assert ready, detail
        assert (source / "app.js").read_text(encoding="utf-8") == "module.exports = 'before';\n"
        assert not (source / "leftover.txt").exists()

        # Nothing may be silently discarded: stash entry and patch file exist.
        stash_list = git(source, "stash", "list")
        assert "pseudo-codex quarantine job=job-dirty" in stash_list, stash_list
        patches = list((state / "quarantine").glob("job-dirty-*.patch"))
        assert len(patches) == 1, patches
        patch_text = patches[0].read_text(encoding="utf-8")
        assert "abandoned" in patch_text, patch_text

        # Non-primary contexts must be ignored entirely.
        assert dispatcher.quarantine_primary_workspace("job-x", None) == ""
        assert dispatcher.quarantine_primary_workspace("job-x", {"mode": "worktree", "worktree": source}) == ""

        print("DISPATCHER_PRIMARY_QUARANTINE_OK")
    finally:
        import shutil
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
