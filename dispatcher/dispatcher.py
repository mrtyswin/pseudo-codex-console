#!/usr/bin/env python3
"""Run queued jobs directly on the Ubuntu host through the ChatGPT browser agent."""

from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from typing import Any
from urllib import error, parse, request
import uuid


HOME = Path.home()
CONSOLE_URL = os.environ.get("PSEUDO_CODEX_CONSOLE_URL", "http://127.0.0.1:8090")
PROJECT_ROOT = Path(os.environ.get("PSEUDO_CODEX_PROJECT_ROOT", str(HOME / "chatgpt-projects"))).resolve()
AGENT = os.environ.get("PSEUDO_CODEX_AGENT", "/usr/local/bin/chatgpt-browser-agent")
STATE_DIR = Path(os.environ.get("PSEUDO_CODEX_STATE_DIR", str(HOME / ".local/state/pseudo-codex")))
POLL_SECONDS = int(os.environ.get("PSEUDO_CODEX_POLL_SECONDS", "5"))
MAX_ATTEMPTS = int(os.environ.get("JOB_MAX_ATTEMPTS", os.environ.get("PSEUDO_CODEX_MAX_ATTEMPTS", "3")))
TOTAL_TIMEOUT_SECONDS = int(
    os.environ.get("JOB_TOTAL_TIMEOUT_SECONDS", os.environ.get("PSEUDO_CODEX_JOB_TIMEOUT_SECONDS", "43200"))
)
IDLE_TIMEOUT_SECONDS = int(os.environ.get("JOB_IDLE_TIMEOUT_SECONDS", "2700"))
RETRY_DELAY_SECONDS = int(os.environ.get("JOB_RETRY_DELAY_SECONDS", "30"))
HEARTBEAT_SECONDS = int(os.environ.get("JOB_HEARTBEAT_SECONDS", "15"))
LEASE_SECONDS = max(int(os.environ.get("JOB_LEASE_SECONDS", "120")), HEARTBEAT_SECONDS * 3)
AUTO_DEPLOY_PROJECT = os.environ.get("PSEUDO_CODEX_AUTO_DEPLOY_PROJECT", "request-console")
AUTO_DEPLOY_COMMAND = os.environ.get(
    "PSEUDO_CODEX_AUTO_DEPLOY_COMMAND",
    "/usr/local/libexec/pseudo-codex-deploy-request-console",
)
AUTO_DEPLOY_TIMEOUT_SECONDS = int(os.environ.get("PSEUDO_CODEX_AUTO_DEPLOY_TIMEOUT_SECONDS", "600"))
PROJECT_CONFIG_PATH = Path(
    os.environ.get("PSEUDO_CODEX_PROJECT_CONFIG", str(HOME / ".config/pseudo-codex/projects.json"))
)
PROJECT_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
COMPLETE_MARKER = "===TASK_COMPLETE==="
BROWSER_SERVICE = os.environ.get("PSEUDO_CODEX_BROWSER_SERVICE", "chatgpt-browser-agent.service")
WORKER_ID = os.environ.get("PSEUDO_CODEX_WORKER_ID", f"{socket.gethostname()}-{os.getpid()}")
MAX_WORKERS = max(1, int(os.environ.get("PSEUDO_CODEX_MAX_WORKERS", "3")))
GITHUB_FIRST_PROJECTS = {"request-console"}


def load_project_configs() -> dict[str, dict[str, Any]]:
    try:
        value = json.loads(PROJECT_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot load project config {PROJECT_CONFIG_PATH}: {exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeError("Project config root must be an object")
    configs = {str(key): item for key, item in value.items() if isinstance(item, dict)}
    for name, config in configs.items():
        if not PROJECT_PATTERN.fullmatch(name):
            raise RuntimeError(f"Invalid project name in config: {name}")
        workspace = config.get("workspace")
        if not isinstance(workspace, str) or not workspace:
            raise RuntimeError(f"Project {name} is missing workspace")
        if config.get("requiresDeployment") and not config.get("deployCommand"):
            raise RuntimeError(f"Project {name} requires deployment but has no deployCommand")
        git_config = config.get("git", {})
        if git_config and not isinstance(git_config, dict):
            raise RuntimeError(f"Project {name} git configuration must be an object")
    return configs


PROJECT_CONFIGS = load_project_configs()

_PROJECT_CONFIG_LOCK = threading.Lock()
try:
    _PROJECT_CONFIG_MTIME_NS = PROJECT_CONFIG_PATH.stat().st_mtime_ns
except OSError:
    _PROJECT_CONFIG_MTIME_NS = -1


def refresh_project_configs(force: bool = False) -> dict[str, dict[str, Any]]:
    global _PROJECT_CONFIG_MTIME_NS
    try:
        modified = PROJECT_CONFIG_PATH.stat().st_mtime_ns
    except OSError as exc:
        logging.getLogger("pseudo-codex-dispatcher").warning(
            "cannot stat project config; keeping last known good config: %r",
            exc,
        )
        return PROJECT_CONFIGS
    if not force and modified == _PROJECT_CONFIG_MTIME_NS:
        return PROJECT_CONFIGS
    try:
        loaded = load_project_configs()
    except RuntimeError as exc:
        logging.getLogger("pseudo-codex-dispatcher").warning(
            "invalid project config; keeping last known good config: %s",
            exc,
        )
        return PROJECT_CONFIGS
    with _PROJECT_CONFIG_LOCK:
        PROJECT_CONFIGS.clear()
        PROJECT_CONFIGS.update(loaded)
        _PROJECT_CONFIG_MTIME_NS = modified
    return PROJECT_CONFIGS


def get_project_config(project: str) -> dict[str, Any]:
    config = refresh_project_configs().get(project)
    if not config:
        raise ValueError(
            f"project is not configured: {project}; add it to {PROJECT_CONFIG_PATH} before submitting jobs"
        )
    return json.loads(json.dumps(config))

def configure_logging() -> logging.Logger:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("pseudo-codex-dispatcher")
    logger.setLevel(logging.INFO)
    handler = logging.FileHandler(STATE_DIR / "dispatcher.log", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.addHandler(logging.StreamHandler(sys.stdout))
    return logger


LOG = configure_logging()


def api_json(method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, Any | None]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = request.Request(CONSOLE_URL + path, data=body, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=15) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else None
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {path} returned {exc.code}: {raw}") from exc


def compact(value: str, limit: int) -> str:
    clean = value.replace("\x00", "")
    return clean[-limit:] if len(clean) > limit else clean


def job_log_path(job_id: str) -> Path:
    directory = STATE_DIR / "jobs"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{job_id}.log"


def job_session_path(job_id: str) -> Path:
    legacy_path = STATE_DIR / "sessions" / f"{job_id}.url"
    directory = STATE_DIR / "sessions" / job_id
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    session_path = directory / "chat.url"
    if legacy_path.is_file() and not session_path.exists():
        session_path.write_text(legacy_path.read_text(encoding="utf-8"), encoding="utf-8")
        session_path.chmod(0o600)
    return session_path


def project_path(project: str, project_config: dict[str, Any] | None = None) -> Path:
    if not PROJECT_PATTERN.fullmatch(project):
        raise ValueError("project must be a lowercase slug")
    config = project_config or get_project_config(project)
    candidate = Path(str(config["workspace"])).resolve()
    try:
        candidate.relative_to(PROJECT_ROOT)
    except ValueError as exc:
        raise ValueError("configured project is outside the allowed project root") from exc
    if not candidate.is_dir():
        raise ValueError(f"configured workspace does not exist: {candidate}")
    return candidate


def ensure_host_native_workspace(workspace: Path) -> None:
    resolved = workspace.resolve()
    disabled_root = Path("/mnt") / "workspace"
    if resolved == disabled_root or disabled_root in resolved.parents:
        raise RuntimeError("SANDBOX_WORKSPACE_DISABLED: jobs must run on the Ubuntu host workspace")


def verify_agent_launcher() -> Path:
    """Fail before claiming work if the configured agent cannot be executed."""
    launcher = Path(AGENT)
    try:
        resolved = launcher.resolve(strict=True)
    except OSError as exc:
        raise RuntimeError(f"AGENT_LAUNCHER_UNAVAILABLE: {launcher}: {exc}") from exc
    if not resolved.is_file():
        raise RuntimeError(f"AGENT_LAUNCHER_UNAVAILABLE: {launcher} does not resolve to a regular file")
    if not os.access(launcher, os.X_OK):
        raise RuntimeError(
            f"AGENT_LAUNCHER_NOT_EXECUTABLE: {launcher} -> {resolved}; "
            "restore execute permission before submitting jobs"
        )
    return resolved


def run_git(workspace: Path, args: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(workspace), *args],
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def git_error(result: subprocess.CompletedProcess[str]) -> str:
    return compact((result.stdout or "") + (result.stderr or ""), 8000).strip()


def git_head(workspace: Path, reference: str = "HEAD") -> str:
    result = run_git(workspace, ["rev-parse", reference])
    if result.returncode != 0:
        raise RuntimeError("Cannot resolve Git commit: " + git_error(result))
    return result.stdout.strip()


def validate_primary_workspace(workspace: Path, base_branch: str) -> tuple[bool, str]:
    status = run_git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"])
    if status.returncode != 0:
        return False, "Cannot inspect Ubuntu workspace: " + git_error(status)
    if status.stdout.strip():
        return False, "UBUNTU_WORKSPACE_DIRTY"
    branch = run_git(workspace, ["symbolic-ref", "--short", "HEAD"])
    if branch.returncode != 0 or branch.stdout.strip() != base_branch:
        return False, "UBUNTU_WORKSPACE_NOT_ON_MAIN"
    return True, "UBUNTU_WORKSPACE_READY"


def run_publish_verification(
    project_config: dict[str, Any],
    workspace: Path,
    remote: str,
    base_branch: str,
) -> tuple[bool, str]:
    outputs: list[str] = []
    diff_check = run_git(workspace, ["diff", "--check", f"{remote}/{base_branch}...HEAD"])
    if diff_check.returncode != 0:
        return False, "PUBLISH_VERIFY_DIFF_FAILED: " + git_error(diff_check)
    outputs.append("PUBLISH_VERIFY_DIFF_OK")

    commands: list[list[str]] = []
    if (workspace / "dispatcher" / "dispatcher.py").is_file():
        commands.append([sys.executable, "-m", "py_compile", "dispatcher/dispatcher.py"])
    if (workspace / "app.js").is_file():
        commands.append(["node", "--check", "app.js"])

    git_config = project_config.get("git", {})
    configured_command = git_config.get("publishVerifyCommand") if isinstance(git_config, dict) else None
    if isinstance(configured_command, str) and configured_command.strip():
        commands.append(["/bin/sh", "-lc", configured_command])

    for command in commands:
        result = subprocess.run(
            command,
            cwd=workspace,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=600,
            check=False,
        )
        output = compact((result.stdout or "") + (result.stderr or ""), 20_000).strip()
        outputs.append("$ " + " ".join(command) + "\n" + output)
        if result.returncode != 0:
            return False, "\n".join(outputs)
    outputs.append("PUBLISH_VERIFY_OK")
    return True, "\n".join(outputs)


def sync_primary_workspace(
    workspace: Path,
    remote: str,
    base_branch: str,
    expected_commit: str,
) -> tuple[bool, str]:
    ready, detail = validate_primary_workspace(workspace, base_branch)
    if not ready:
        return False, detail
    fetch = run_git(workspace, ["fetch", "--prune", remote, base_branch], timeout=300)
    if fetch.returncode != 0:
        return False, "Cannot fetch Ubuntu workspace: " + git_error(fetch)
    merge = run_git(workspace, ["merge", "--ff-only", f"{remote}/{base_branch}"], timeout=300)
    if merge.returncode != 0:
        return False, "Cannot fast-forward Ubuntu workspace: " + git_error(merge)
    actual_commit = git_head(workspace)
    if actual_commit != expected_commit:
        return False, f"UBUNTU_WORKSPACE_COMMIT_MISMATCH expected={expected_commit} actual={actual_commit}"
    return True, f"UBUNTU_SYNC_OK commit={actual_commit}"


def is_github_first_project(project_name: str) -> bool:
    return project_name in GITHUB_FIRST_PROJECTS


def prepare_job_workspace(
    job: dict[str, Any],
    source_workspace: Path,
    project_config: dict[str, Any] | None = None,
) -> tuple[Path, dict[str, Any] | None]:
    project_name = str(job["project"])
    config = project_config or get_project_config(project_name)
    execution_mode = str(config.get("executionMode", "local"))
    if execution_mode == "verify_only":
        return source_workspace, None
    git_config = config.get("git", {})
    if not isinstance(git_config, dict) or not git_config.get("enabled", False):
        return source_workspace, None

    probe = run_git(source_workspace, ["rev-parse", "--show-toplevel"])
    if probe.returncode != 0:
        raise RuntimeError("Git publishing is enabled but the configured workspace is not a Git repository")

    remote = str(git_config.get("remote", "origin"))
    base_branch = str(git_config.get("baseBranch", "main"))
    branch_prefix = re.sub(r"[^a-zA-Z0-9._/-]+", "-", str(git_config.get("branchPrefix", "chatgpt-job"))).strip("-/")
    branch = f"{branch_prefix}/{job['id']}"
    execution_mode = str(config.get("executionMode", "local"))
    if execution_mode == "github_direct":
        repository = str(git_config.get("repository", "")).strip()
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise RuntimeError("GitHub direct mode requires git.repository in owner/repository format")
        if not git_config.get("push", False):
            raise RuntimeError("GitHub direct mode requires git.push=true")
        return source_workspace, {
            "mode": "github_direct",
            "source": source_workspace,
            "branch": branch,
            "remote": remote,
            "baseBranch": base_branch,
            "repository": repository,
            "push": True,
        }

    worktree = STATE_DIR / "worktrees" / project_name / str(job["id"])
    worktree.parent.mkdir(parents=True, exist_ok=True)

    if (worktree / ".git").exists():
        return worktree, {
            "source": source_workspace,
            "worktree": worktree,
            "branch": branch,
            "remote": remote,
            "baseBranch": base_branch,
            "push": bool(git_config.get("push", False)),
            "mode": "local",
        }
    if worktree.exists():
        raise RuntimeError(f"Git worktree path already exists but is invalid: {worktree}")

    fetch = run_git(source_workspace, ["fetch", "--prune", remote, base_branch], timeout=300)
    if fetch.returncode != 0:
        raise RuntimeError("Cannot fetch Git base branch: " + git_error(fetch))
    add = run_git(
        source_workspace,
        ["worktree", "add", "-b", branch, str(worktree), f"{remote}/{base_branch}"],
        timeout=300,
    )
    if add.returncode != 0:
        raise RuntimeError("Cannot create job Git worktree: " + git_error(add))
    return worktree, {
        "source": source_workspace,
        "worktree": worktree,
        "branch": branch,
        "remote": remote,
        "baseBranch": base_branch,
        "push": bool(git_config.get("push", False)),
        "mode": "local",
    }


def publish_git_changes(
    job: dict[str, Any],
    context: dict[str, Any] | None,
    project_config: dict[str, Any] | None = None,
) -> tuple[bool, str]:
    project_name = str(job.get("project", ""))
    project_config = project_config or get_project_config(project_name)
    if context is None:
        if project_config.get("requiresDeployment", False):
            return False, "GIT_PUBLISH_NOT_CONFIGURED"
        return True, "GIT_DISABLED"

    worktree = Path(context["worktree"])
    source = Path(context["source"])
    remote = str(context["remote"])
    base_branch = str(context["baseBranch"])
    branch = str(context["branch"])
    if not context.get("push", False):
        return False, f"job branch: {branch}\npush結果: disabled"

    status = run_git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])
    if status.returncode != 0:
        return False, "Cannot inspect Git changes: " + git_error(status)

    push_result = "no-changes"
    if status.stdout.strip():
        add = run_git(worktree, ["add", "-A"])
        if add.returncode != 0:
            return False, "Cannot stage Git changes: " + git_error(add)
        title = compact(str(job.get("title", "job")), 120).replace("\n", " ").strip() or "job"
        commit = run_git(worktree, ["commit", "-m", f"Pseudo Codex: {title}"])
        if commit.returncode != 0:
            return False, "Cannot commit Git changes; configure a Git author on the Ubuntu host: " + git_error(commit)
        branch_push = run_git(worktree, ["push", "--set-upstream", remote, branch], timeout=300)
        if branch_push.returncode != 0:
            return False, "Cannot push Git branch: " + git_error(branch_push)
        push_result = "ok"

    job_commit = git_head(worktree)
    fetch = run_git(worktree, ["fetch", "--prune", remote, base_branch], timeout=300)
    if fetch.returncode != 0:
        return False, "Cannot refresh origin base: " + git_error(fetch)
    rebase = run_git(worktree, ["rebase", f"{remote}/{base_branch}"], timeout=300)
    if rebase.returncode != 0:
        run_git(worktree, ["rebase", "--abort"])
        return False, "GIT_REBASE_CONFLICT: " + git_error(rebase)

    verify_ok, verify_output = run_publish_verification(project_config, worktree, remote, base_branch)
    if not verify_ok:
        return False, verify_output

    ready, ready_output = validate_primary_workspace(source, base_branch)
    if not ready:
        return False, ready_output

    main_commit = git_head(worktree)
    main_push = run_git(worktree, ["push", remote, f"HEAD:{base_branch}"], timeout=300)
    if main_push.returncode != 0:
        return False, "Cannot fast-forward GitHub main: " + git_error(main_push)

    sync_ok, sync_output = sync_primary_workspace(source, remote, base_branch, main_commit)
    if not sync_ok:
        return False, sync_output

    return True, "\n".join(
        [
            f"job branch: {branch}",
            f"job commit SHA: {job_commit}",
            f"GitHub main SHA: {main_commit}",
            f"Ubuntu workspace SHA: {main_commit}",
            f"push結果: {push_result}",
            "main反映結果: fast-forward",
            "Ubuntu同期結果: ok",
            verify_output,
            sync_output,
        ]
    )


def parse_github_completion(output: str) -> dict[str, Any]:
    match = re.search(
        r"===GITHUB_COMPLETE===\s*(\{.*?\})\s*===END_GITHUB_COMPLETE===",
        output,
        re.DOTALL,
    )
    if not match:
        raise RuntimeError("GITHUB_COMPLETE_RESULT_MISSING")
    try:
        value = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"GITHUB_COMPLETE_RESULT_INVALID: {exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeError("GITHUB_COMPLETE_RESULT_INVALID")
    return value


def publish_github_direct_changes(
    job: dict[str, Any],
    context: dict[str, Any],
    output: str,
    project_config: dict[str, Any],
) -> tuple[bool, str]:
    try:
        result = parse_github_completion(output)
    except RuntimeError as exc:
        return False, str(exc)

    repository = str(result.get("repository", ""))
    branch = str(result.get("branch", ""))
    base_branch = str(result.get("baseBranch", ""))
    commit_sha = str(result.get("commitSha", ""))
    pull_request_url = str(result.get("pullRequestUrl", ""))
    changed_files = [str(item) for item in result.get("changedFiles", []) if isinstance(item, str)]
    expected_branch = str(context["branch"])
    expected_pr_prefix = f"https://github.com/{repository}/pull/"
    sensitive_path = re.compile(
        r"(^|/)(?:\.env(?:\.|$)|id_[rd]sa(?:\.|$)|.*\.(?:pem|key|p12|pfx)|credentials(?:\.|$)|secrets?(?:\.|$))",
        re.IGNORECASE,
    )
    if (
        repository != str(context["repository"])
        or branch != expected_branch
        or base_branch != str(context["baseBranch"])
        or not re.fullmatch(r"[0-9a-fA-F]{40}", commit_sha)
        or not pull_request_url.startswith(expected_pr_prefix)
        or any(sensitive_path.search(path) for path in changed_files)
    ):
        return False, "GITHUB_COMPLETE_RESULT_MISMATCH_OR_SENSITIVE_PATH"

    source = Path(context["source"])
    remote = str(context["remote"])
    ready, ready_output = validate_primary_workspace(source, base_branch)
    if not ready:
        return False, ready_output

    fetch = run_git(
        source,
        ["fetch", "--prune", remote, base_branch, f"{branch}:refs/remotes/{remote}/{branch}"],
        timeout=300,
    )
    if fetch.returncode != 0:
        return False, "Cannot fetch GitHub direct branch: " + git_error(fetch)

    worktree = STATE_DIR / "worktrees" / str(job["project"]) / f"{job['id']}-github"
    worktree.parent.mkdir(parents=True, exist_ok=True)
    if worktree.exists():
        return False, f"GitHub validation worktree already exists: {worktree}"
    add = run_git(
        source,
        ["worktree", "add", "--detach", str(worktree), f"{remote}/{branch}"],
        timeout=300,
    )
    if add.returncode != 0:
        return False, "Cannot create GitHub validation worktree: " + git_error(add)
    context["worktree"] = worktree

    actual_commit = git_head(worktree)
    if actual_commit.lower() != commit_sha.lower():
        return False, f"GITHUB_COMMIT_MISMATCH expected={commit_sha} actual={actual_commit}"
    ancestor = run_git(
        worktree,
        ["merge-base", "--is-ancestor", f"{remote}/{base_branch}", "HEAD"],
    )
    if ancestor.returncode != 0:
        return False, "GITHUB_BRANCH_STALE_OR_DIVERGED"

    verify_ok, verify_output = run_publish_verification(
        project_config,
        worktree,
        remote,
        base_branch,
    )
    if not verify_ok:
        return False, verify_output

    main_push = run_git(worktree, ["push", remote, f"HEAD:{base_branch}"], timeout=300)
    if main_push.returncode != 0:
        return False, "Cannot fast-forward GitHub main: " + git_error(main_push)

    sync_ok, sync_output = sync_primary_workspace(
        source,
        remote,
        base_branch,
        actual_commit,
    )
    if not sync_ok:
        return False, sync_output

    return True, "\n".join(
        [
            f"GitHub repository: {repository}",
            f"job branch: {branch}",
            f"job commit SHA: {actual_commit}",
            f"pull request: {pull_request_url}",
            f"GitHub main SHA: {actual_commit}",
            f"Ubuntu workspace SHA: {actual_commit}",
            "main反映結果: fast-forward",
            "Ubuntu同期結果: ok",
            verify_output,
            sync_output,
        ]
    )


def sync_workspace_to_origin_main(project_name: str, workspace: Path) -> tuple[bool, str]:
    git_config = PROJECT_CONFIGS.get(project_name, {}).get("git", {})
    if not isinstance(git_config, dict) or not git_config.get("enabled", False):
        return True, "GIT_SYNC_NOT_CONFIGURED"
    remote = str(git_config.get("remote", "origin"))
    base_branch = str(git_config.get("baseBranch", "main"))
    fetch = run_git(workspace, ["fetch", "--prune", remote, base_branch], timeout=300)
    if fetch.returncode != 0:
        return False, "Cannot fetch Git base branch before deploy: " + git_error(fetch)
    pull = run_git(workspace, ["pull", "--ff-only", remote, base_branch], timeout=300)
    if pull.returncode != 0:
        return False, "Cannot fast-forward workspace to remote main before deploy: " + git_error(pull)
    head = run_git(workspace, ["rev-parse", "HEAD"])
    remote_head = run_git(workspace, ["rev-parse", f"{remote}/{base_branch}"])
    return True, (
        "GIT_SYNC_OK local=" + head.stdout.strip() +
        " remote=" + remote_head.stdout.strip()
    )


def cleanup_git_worktree(context: dict[str, Any] | None) -> None:
    if context is None or "worktree" not in context:
        return
    source = Path(context["source"])
    worktree = Path(context["worktree"])
    result = run_git(source, ["worktree", "remove", str(worktree)], timeout=300)
    if result.returncode != 0:
        LOG.warning("could not remove completed worktree path=%s detail=%s", worktree, git_error(result))


def task_for(job: dict[str, Any], project_config: dict[str, Any] | None = None) -> str:
    project_name = str(job.get("project", ""))
    project_config = project_config or get_project_config(project_name)
    git_config = project_config.get("git", {})
    if project_config.get("executionMode") == "verify_only":
        return "\n".join(
            [
                "Verification-only task. Do not modify files or Git state.",
                "Run read-only inspection and the smallest relevant tests, then report the results.",
                "Task title: " + str(job.get("title", "")),
                "Task instruction:",
                str(job.get("instruction", "")),
            ]
        )
    if project_config.get("executionMode") == "github_direct":
        return "\n".join(
            [
                "Use the connected GitHub tool to implement this task directly in the configured repository.",
                "Create or update only the dedicated job branch and a pull request. Do not edit Ubuntu files.",
                "Repository: " + str(git_config.get("repository", "")),
                "Base branch: " + str(git_config.get("baseBranch", "main")),
                "Task title: " + str(job.get("title", "")),
                "Task instruction:",
                str(job.get("instruction", "")),
            ]
        )
    lines = [
            "You are the sole implementation agent for this queued local task.",
            "Run directly on the Ubuntu host and work only inside the provided host project directory.",
            "Inspect existing files before changing them. Run meaningful verification commands.",
            "Use standard unified PATCH blocks for existing-file edits; a complete FILE block may replace a file when patch context is unstable.",
            "Keep RUN blocks short. Do not embed base64, gzip payloads, or large scripts in RUN blocks.",
            "Never repeat a command that already failed; change strategy using the returned error.",
            "Do not claim success without command output that supports it.",
            "When verified, output ===TASK_COMPLETE=== on its own line.",
            "HOST DEPLOYMENT CONTRACT (authoritative):",
            json.dumps(project_config, ensure_ascii=False, sort_keys=True),
            "Execution is host-native: there is no isolated project workspace mapping.",
            "The working directory is the real Ubuntu job workspace or Git worktree.",
            "You may inspect Ubuntu host state with non-destructive commands such as ss, systemctl status, ps, and /proc reads.",
            "Do not use sudo, expose credentials, or modify unrelated host paths.",
            "Implement or inspect in the provided host working directory, verify the result, and include a concise user-facing conclusion before ===TASK_COMPLETE===.",
            "After completion, the host dispatcher alone performs configured publication, deployment, and production verification.",
            "Task title: " + str(job.get("title", "")),
            "Task instruction:",
            str(job.get("instruction", "")),
    ]
    if isinstance(git_config, dict) and git_config.get("enabled", False):
        lines.extend(
            [
                "",
                "GIT AUTHORING CONTRACT:",
                "This project is configured to treat the Git workspace as the source of truth.",
                "Make file changes only inside the dedicated Ubuntu host Git worktree for this job.",
                "Do not attempt manual git push credentials setup inside the task.",
                "After you verify the change and output ===TASK_COMPLETE===, the host dispatcher will commit and optionally push using host-side credentials if configured.",
            ]
        )
    if is_github_first_project(project_name):
        lines.extend(
            [
                "",
                "REQUEST-CONSOLE SPECIAL RULE:",
                "This project deploys only from GitHub main after a host-side pull --ff-only.",
                "Do not assume sandbox edits become production immediately.",
                "A successful production deploy requires the host workspace to fast-forward to remote main first.",
            ]
        )
    if int(job.get("attempts", 0)) > 1:
        prior_log = str(job.get("workerLog", ""))
        relevant = [
            line[:500]
            for line in prior_log.splitlines()
            if len(line) <= 1000 and re.search(r"error|failed|syntax|timeout|refused|traceback", line, re.I)
        ][-20:]
        lines.extend(
            [
                "",
                "This is an infrastructure retry. Preserve prior work and choose a different strategy from the failed attempt.",
                "Previous failure evidence:",
                "\n".join(relevant) if relevant else "No concise failure lines were captured; inspect the existing conversation and files.",
            ]
        )
    return "\n".join(lines)


def restart_browser() -> str:
    command = ["systemctl", "--user", "restart", BROWSER_SERVICE]
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=90, check=False)
        return "$ " + " ".join(command) + "\n" + (result.stdout + result.stderr).strip()
    except Exception as exc:  # pragma: no cover - operational fallback
        return f"$ {' '.join(command)}\nrestart error: {exc!r}"


def log_reference(job_id: str, detail: str = "") -> str:
    prefix = compact(detail, 8000).strip()
    pointer = "Log: " + str(job_log_path(job_id))
    return pointer if not prefix else prefix + "\n\n" + pointer


def update_result(
    job_id: str,
    status: str,
    last_error: str,
    detail: str = "",
    verification_result: str | None = None,
) -> None:
    path = "/api/jobs/" + parse.quote(job_id, safe="") + "/result"
    current = get_job(job_id) or {}
    api_json(
        "POST",
        path,
        {
            "status": status,
            "lastError": compact(last_error, 20_000),
            "workerLog": log_reference(job_id, detail),
            "finalAnswer": str(current.get("finalAnswer", "")),
            "executionResult": str(current.get("executionResult", "")),
            "verificationResult": (
                str(current.get("verificationResult", ""))
                if verification_result is None
                else compact(verification_result, 20_000)
            ),
        },
    )


def update_progress(
    job_id: str,
    stage: str,
    message: str,
    session_id: str,
    pid: int,
    phase: str = "",
) -> None:
    path = "/api/jobs/" + parse.quote(job_id, safe="") + "/progress"
    api_json(
        "POST",
        path,
        {
            "stage": stage,
            "message": message,
            "workerId": WORKER_ID,
            "sessionId": session_id,
            "pid": pid,
            "leaseSeconds": LEASE_SECONDS,
            "phase": phase,
        },
    )


def heartbeat(job_id: str, session_id: str, pid: int) -> None:
    path = "/api/jobs/" + parse.quote(job_id, safe="") + "/heartbeat"
    api_json(
        "POST",
        path,
        {
            "workerId": WORKER_ID,
            "sessionId": session_id,
            "pid": pid,
            "leaseSeconds": LEASE_SECONDS,
        },
    )


def get_job(job_id: str) -> dict[str, Any] | None:
    status, payload = api_json("GET", "/api/jobs/" + parse.quote(job_id, safe=""))
    return payload if status == 200 and isinstance(payload, dict) else None


def agent_result_is_saved(job_id: str) -> bool:
    job = get_job(job_id)
    return bool(job and job.get("status") in {"done", "completed"})


def parse_timestamp(value: Any, fallback: float) -> float:
    if not isinstance(value, str) or not value:
        return fallback
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return fallback


def process_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return False
    return "chatgpt-browser-agent" in cmdline or "agent.js" in cmdline


def recover_running_jobs() -> None:
    status, payload = api_json("GET", "/api/jobs")
    if status != 200 or not isinstance(payload, dict):
        return
    now = time.time()
    for job in payload.get("jobs", []):
        if job.get("status") != "running" or job.get("kind") == "test" or job.get("isTest") is True:
            continue
        job_id = str(job["id"])
        if process_alive(job.get("pid")):
            LOG.warning("leaving live interrupted job untouched job=%s pid=%s", job_id, job.get("pid"))
            continue
        lease_expiry = parse_timestamp(job.get("leaseExpiresAt"), 0)
        if lease_expiry > now:
            LOG.info("waiting for lease expiry job=%s lease=%s", job_id, job.get("leaseExpiresAt"))
            continue
        update_result(job_id, "queued", "Recovered after dispatcher restart; no live agent process or lease remained.")
        LOG.warning("requeued orphaned job=%s", job_id)


def terminate_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=10)


def read_log_tail(path: Path, limit: int = 200_000) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            return handle.read().decode("utf-8", "replace").replace("\x00", "")
    except OSError:
        return ""


def run_auto_deploy(
    job: dict[str, Any],
    workspace: Path,
    session_id: str,
    pid: int,
    project_config: dict[str, Any] | None = None,
) -> tuple[bool, str]:
    project_name = str(job.get("project", ""))
    project_config = project_config or get_project_config(project_name)
    if not project_config.get("requiresDeployment", False):
        return True, "AUTO_DEPLOY_NOT_REQUIRED project=" + project_name
    deploy_command = str(project_config.get("deployCommand", ""))
    if not deploy_command:
        return False, "AUTO_DEPLOY_CONFIG_ERROR deployCommand is required for project=" + project_name
    job_id = str(job["id"])
    update_progress(job_id, "verifying", "本番環境へ自動配備中", session_id, pid, "DEPLOY")
    outputs: list[str] = []
    for attempt in range(1, 3):
        try:
            deploy_environment = os.environ.copy()
            deploy_workspace = workspace
            sync_output = ""
            if is_github_first_project(project_name):
                source_workspace = project_path(project_name)
                sync_ok, sync_output = sync_workspace_to_origin_main(project_name, source_workspace)
                if not sync_ok:
                    outputs.append(sync_output)
                    return False, "\n\n".join(outputs)
                deploy_workspace = source_workspace
            deploy_environment["PSEUDO_CODEX_JOB_WORKSPACE"] = str(deploy_workspace)
            result = subprocess.run(
                [deploy_command],
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=AUTO_DEPLOY_TIMEOUT_SECONDS,
                env=deploy_environment,
                check=False,
            )
            output = compact((result.stdout or "") + (result.stderr or ""), 20_000)
            if sync_output:
                output = sync_output + "\n" + output
            outputs.append(f"auto-deploy attempt={attempt} exit={result.returncode}\n{output}".strip())
            if result.returncode != 0:
                if attempt == 1:
                    time.sleep(10)
                continue

            verify_command = str(project_config.get("verifyCommand", ""))
            if verify_command:
                verify = subprocess.run(
                    [verify_command],
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    capture_output=True,
                    timeout=AUTO_DEPLOY_TIMEOUT_SECONDS,
                    env=deploy_environment,
                    check=False,
                )
                verify_output = compact((verify.stdout or "") + (verify.stderr or ""), 20_000)
                outputs.append(f"verifyCommand exit={verify.returncode}\n{verify_output}".strip())
                if verify.returncode != 0:
                    if attempt == 1:
                        time.sleep(10)
                    continue

            health_url = str(project_config.get("healthUrl", ""))
            if health_url:
                try:
                    with request.urlopen(health_url, timeout=20) as response:
                        health_body = compact(response.read().decode("utf-8", "replace"), 4000)
                        outputs.append(f"healthUrl status={response.status}\n{health_body}".strip())
                        if response.status < 200 or response.status >= 300:
                            raise RuntimeError(f"unexpected health status {response.status}")
                except Exception as exc:
                    outputs.append(f"healthUrl failed: {exc}")
                    if attempt == 1:
                        time.sleep(10)
                    continue

            service = str(project_config.get("service", ""))
            if service:
                service_result = subprocess.run(
                    ["systemctl", "is-active", service],
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    capture_output=True,
                    timeout=30,
                    check=False,
                )
                service_output = compact((service_result.stdout or "") + (service_result.stderr or ""), 4000)
                outputs.append(f"service {service} exit={service_result.returncode}\n{service_output}".strip())
                if service_result.returncode != 0 or service_result.stdout.strip() != "active":
                    if attempt == 1:
                        time.sleep(10)
                    continue

            deployed_sha = ""
            probe = run_git(workspace, ["rev-parse", "HEAD"])
            if probe.returncode == 0:
                deployed_sha = probe.stdout.strip()
            outputs.append(
                "\n".join(
                    [
                        f"deployed SHA: {deployed_sha or 'unknown'}",
                        "本番検証結果: ok",
                    ]
                )
            )
            return True, "\n\n".join(outputs)
        except subprocess.TimeoutExpired as exc:
            stdout = exc.stdout if isinstance(exc.stdout, str) else ""
            stderr = exc.stderr if isinstance(exc.stderr, str) else ""
            outputs.append(
                f"auto-deploy attempt={attempt} timed out after {AUTO_DEPLOY_TIMEOUT_SECONDS}s\n" +
                compact(stdout + stderr, 20_000)
            )
            if attempt == 1:
                time.sleep(10)
    return False, "\n\n".join(outputs)


def run_job(job: dict[str, Any]) -> None:
    job_id = str(job["id"])
    attempts = int(job.get("attempts", 0))
    session_id = uuid.uuid4().hex
    try:
        project_config = get_project_config(str(job["project"]))
        source_workspace = project_path(str(job["project"]), project_config)
        cwd, git_context = prepare_job_workspace(job, source_workspace, project_config)
        ensure_host_native_workspace(cwd)
    except Exception as exc:
        update_result(job_id, "needs_human", str(exc), "Dispatcher rejected the project path.")
        return

    try:
        verify_agent_launcher()
    except RuntimeError as exc:
        message = str(exc)
        update_result(
            job_id,
            "needs_human",
            message,
            "Dispatcher preflight failed before ChatGPT was started. No retry was scheduled.\n" + message,
        )
        LOG.error("job=%s launcher preflight failed: %s", job_id, message)
        return

    session_path = job_session_path(job_id)
    if job.get("forceNewConversation") and session_path.exists():
        session_path.unlink()

    command = [
        AGENT,
        "run",
        "--auto",
        "--job-id",
        job_id,
        "--console-url",
        CONSOLE_URL,
        "--session-file",
        str(session_path),
        "--session-key",
        job_id,
        "--cwd",
        str(cwd),
        "--task-stdin",
        "--host-native",
    ]
    execution_mode = str(project_config.get("executionMode", "local"))
    git_config = project_config.get("git", {})
    command.extend(["--execution-mode", execution_mode])
    if execution_mode == "github_direct" and isinstance(git_config, dict):
        command.extend(
            [
                "--github-repository", str(git_config.get("repository", "")),
                "--github-base-branch", str(git_config.get("baseBranch", "main")),
                "--github-branch", str(git_context["branch"] if git_context else ""),
            ]
        )
    path = job_log_path(job_id)
    LOG.info("starting job=%s project=%s attempt=%s session=%s", job_id, cwd.name, attempts, session_id)
    started = time.time()
    last_activity = parse_timestamp(job.get("activityAt"), started)
    failure = ""
    manually_stopped = False
    deployment_failed = False

    with path.open("w", encoding="utf-8", errors="replace") as log_handle:
        try:
            process = subprocess.Popen(
                command,
                text=True,
                encoding="utf-8",
                errors="replace",
                stdin=subprocess.PIPE,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as exc:
            message = f"AGENT_LAUNCH_FAILED: {exc}"
            log_handle.write(message + "\n")
            log_handle.flush()
            update_result(
                job_id,
                "needs_human",
                message,
                "Dispatcher could not start the ChatGPT agent. No retry was scheduled.\n" + message,
            )
            LOG.error("job=%s agent launch failed: %s", job_id, message)
            return
        assert process.stdin is not None
        process.stdin.write(task_for(job, project_config))
        process.stdin.close()
        update_progress(job_id, "sending_to_chatgpt", "Dispatcher agent起動 pid=" + str(process.pid), session_id, process.pid)
        last_heartbeat = 0.0

        while process.poll() is None:
            now = time.time()
            if now - last_heartbeat >= HEARTBEAT_SECONDS:
                current = get_job(job_id)
                if current and (current.get("stage") == "stopped" or current.get("status") == "stopped"):
                    manually_stopped = True
                    terminate_process(process)
                    break
                if current:
                    last_activity = max(last_activity, parse_timestamp(current.get("activityAt"), last_activity))
                try:
                    heartbeat(job_id, session_id, process.pid)
                except Exception as exc:
                    LOG.warning("heartbeat failed job=%s: %r", job_id, exc)
                last_heartbeat = now
            if now - started > TOTAL_TIMEOUT_SECONDS:
                failure = f"Dispatcher total timeout after {TOTAL_TIMEOUT_SECONDS} seconds."
                terminate_process(process)
                break
            if now - last_activity > IDLE_TIMEOUT_SECONDS:
                failure = f"Dispatcher idle timeout after {IDLE_TIMEOUT_SECONDS} seconds without progress."
                terminate_process(process)
                break
            time.sleep(2)

        return_code = process.poll()

    output = read_log_tail(path)
    if manually_stopped:
        LOG.info("stopped job=%s by user", job_id)
        return
    current_after_agent = get_job(job_id)
    if current_after_agent and current_after_agent.get("status") == "blocked":
        LOG.warning("job=%s blocked by deterministic controller", job_id)
        return
    changed_files = current_after_agent.get("changedFiles", []) if current_after_agent else []
    has_file_changes = bool(changed_files)
    if not failure:
        failure = "" if return_code == 0 and COMPLETE_MARKER in output else (
            f"Agent exited {return_code}; completion marker missing." if return_code == 0 else f"Agent exited {return_code}."
        )
    if not failure:
        current = get_job(job_id)
        if current and current.get("stage") == "stopped":
            LOG.info("job=%s was stopped before deployment", job_id)
            return

        publish_output = ""
        deploy_output = ""
        if execution_mode == "verify_only":
            publish_ok = True
            deploy_ok = True
            publish_output = "VERIFY_ONLY_NO_PUBLISH"
            deploy_output = "VERIFY_ONLY_NO_DEPLOY"
        elif not has_file_changes:
            publish_ok = True
            deploy_ok = True
            publish_output = "NO_FILE_CHANGES"
            deploy_output = "AUTO_DEPLOY_SKIPPED_NO_CHANGES"
        elif git_context is None:
            publish_ok, publish_output = publish_git_changes(job, git_context, project_config)
            if publish_ok:
                deploy_ok, deploy_output = run_auto_deploy(
                    job, cwd, session_id, process.pid, project_config
                )
            else:
                deploy_ok = False
        else:
            lock_path = STATE_DIR / "locks" / f"{job['project']}-publish.lock"
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            with lock_path.open("a+", encoding="utf-8") as lock_handle:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
                if git_context.get("mode") == "github_direct":
                    publish_ok, publish_output = publish_github_direct_changes(
                        job,
                        git_context,
                        output,
                        project_config,
                    )
                else:
                    publish_ok, publish_output = publish_git_changes(
                        job, git_context, project_config
                    )
                if publish_ok:
                    deploy_ok, deploy_output = run_auto_deploy(
                        job, source_workspace, session_id, process.pid, project_config
                    )
                else:
                    deploy_ok = False

        combined_output = "\n".join(item for item in (publish_output, deploy_output) if item)
        if not publish_ok:
            failure = publish_output
            deployment_failed = True
        elif not deploy_ok:
            failure = "Automatic production deployment or verification failed."
            deployment_failed = True

        with path.open("a", encoding="utf-8", errors="replace") as log_handle:
            log_handle.write("\n\nAuto deploy:\n" + combined_output + "\n")
        if not failure:
            completion_message = (
                "Ubuntuホスト上の読み取り処理完了（変更・配備なし）"
                if not has_file_changes
                else "本番health・実画面・Git差分検証完了"
            )
            update_progress(job_id, "verifying", completion_message, session_id, process.pid, "VERIFY")
            update_result(
                job_id,
                "done",
                "",
                "Completed by ChatGPT browser agent.\n" + combined_output,
                verification_result=combined_output,
            )
            cleanup_git_worktree(git_context)
            LOG.info("completed and deployed job=%s", job_id)
            return

    if deployment_failed:
        detail = compact(read_log_tail(path), 8000)
        update_result(job_id, "needs_human", failure, detail)
        LOG.error("job=%s deployment needs human review: %s", job_id, failure)
        return

    restart_log = restart_browser()
    detail = compact(output, 6000) + "\n\nBrowser restart:\n" + restart_log
    if attempts >= MAX_ATTEMPTS:
        update_result(job_id, "needs_human", failure, detail)
        LOG.error("job=%s needs human review: %s", job_id, failure)
    else:
        update_result(job_id, "queued", failure, detail)
        LOG.warning("job=%s queued for retry after %ss: %s", job_id, RETRY_DELAY_SECONDS, failure)
        time.sleep(RETRY_DELAY_SECONDS)


def claim_next_job(excluded_projects: set[str] | None = None) -> dict[str, Any] | None:
    session_id = uuid.uuid4().hex
    status, job = api_json(
        "POST",
        "/api/jobs/claim",
        {
            "workerId": WORKER_ID,
            "sessionId": session_id,
            "leaseSeconds": LEASE_SECONDS,
            "excludedProjects": sorted(excluded_projects or set()),
        },
    )
    return None if status == 204 else job


def project_allows_parallel(project: str) -> bool:
    config = refresh_project_configs().get(project, {})
    git_config = config.get("git", {})
    return isinstance(git_config, dict) and bool(git_config.get("enabled", False))


def main() -> int:
    LOG.info(
        "dispatcher started console=%s project_root=%s total_timeout=%s idle_timeout=%s max_workers=%s",
        CONSOLE_URL,
        PROJECT_ROOT,
        TOTAL_TIMEOUT_SECONDS,
        IDLE_TIMEOUT_SECONDS,
        MAX_WORKERS,
    )
    recover_running_jobs()
    active: dict[Future[None], str] = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="pseudo-codex") as executor:
        while True:
            try:
                for future in [item for item in active if item.done()]:
                    project = active.pop(future)
                    try:
                        future.result()
                    except Exception as exc:
                        LOG.exception("worker failed project=%s: %r", project, exc)

                if len(active) >= MAX_WORKERS:
                    time.sleep(0.5)
                    continue

                excluded_projects = {
                    project for project in active.values()
                    if not project_allows_parallel(project)
                }
                job = claim_next_job(excluded_projects)
                if job is None:
                    time.sleep(POLL_SECONDS)
                    continue
                refresh_project_configs()
                if job.get("kind") == "test" or job.get("isTest") is True:
                    LOG.error("console returned a test job; refusing job=%s", job.get("id"))
                    continue

                project = str(job.get("project", ""))
                active[executor.submit(run_job, job)] = project
                LOG.info(
                    "scheduled job=%s project=%s active=%s/%s",
                    job.get("id"),
                    project,
                    len(active),
                    MAX_WORKERS,
                )
            except KeyboardInterrupt:
                return 0
            except Exception as exc:
                LOG.exception("dispatcher loop error: %r", exc)
                time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
