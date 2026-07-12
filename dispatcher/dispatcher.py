#!/usr/bin/env python3
"""Run queued local jobs through the sandboxed ChatGPT browser agent."""

from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
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


def project_path(project: str) -> Path:
    if not PROJECT_PATTERN.fullmatch(project):
        raise ValueError("project must be a lowercase slug")
    config = PROJECT_CONFIGS.get(project)
    if not config:
        raise ValueError(
            f"project is not configured: {project}; add it to {PROJECT_CONFIG_PATH} before submitting jobs"
        )
    candidate = Path(str(config["workspace"])).resolve()
    try:
        candidate.relative_to(PROJECT_ROOT)
    except ValueError as exc:
        raise ValueError("configured project is outside the allowed project root") from exc
    if not candidate.is_dir():
        raise ValueError(f"configured workspace does not exist: {candidate}")
    return candidate


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


def prepare_job_workspace(job: dict[str, Any], source_workspace: Path) -> tuple[Path, dict[str, Any] | None]:
    project_name = str(job["project"])
    git_config = PROJECT_CONFIGS[project_name].get("git", {})
    if not isinstance(git_config, dict) or not git_config.get("enabled", False):
        return source_workspace, None

    probe = run_git(source_workspace, ["rev-parse", "--show-toplevel"])
    if probe.returncode != 0:
        raise RuntimeError("Git publishing is enabled but the configured workspace is not a Git repository")

    remote = str(git_config.get("remote", "origin"))
    base_branch = str(git_config.get("baseBranch", "main"))
    branch_prefix = re.sub(r"[^a-zA-Z0-9._/-]+", "-", str(git_config.get("branchPrefix", "chatgpt-job"))).strip("-/")
    branch = f"{branch_prefix}/{job['id']}"
    worktree = STATE_DIR / "worktrees" / project_name / str(job["id"])
    worktree.parent.mkdir(parents=True, exist_ok=True)

    if (worktree / ".git").exists():
        return worktree, {
            "source": source_workspace,
            "worktree": worktree,
            "branch": branch,
            "remote": remote,
            "push": bool(git_config.get("push", False)),
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
        "push": bool(git_config.get("push", False)),
    }


def publish_git_changes(job: dict[str, Any], context: dict[str, Any] | None) -> tuple[bool, str]:
    if context is None:
        return True, "GIT_PUBLISH_NOT_CONFIGURED"
    worktree = Path(context["worktree"])
    status = run_git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])
    if status.returncode != 0:
        return False, "Cannot inspect Git changes: " + git_error(status)
    if not status.stdout.strip():
        return True, "GIT_PUBLISH_NO_CHANGES"

    add = run_git(worktree, ["add", "-A"])
    if add.returncode != 0:
        return False, "Cannot stage Git changes: " + git_error(add)
    title = compact(str(job.get("title", "job")), 120).replace("\n", " ").strip() or "job"
    commit = run_git(worktree, ["commit", "-m", f"Pseudo Codex: {title}"])
    if commit.returncode != 0:
        return False, "Cannot commit Git changes; configure a Git author on the Ubuntu host: " + git_error(commit)
    commit_id = run_git(worktree, ["rev-parse", "--short", "HEAD"])
    detail = "GIT_COMMIT_OK branch=" + str(context["branch"]) + " commit=" + commit_id.stdout.strip()
    if not context.get("push", False):
        return True, detail + " push=disabled"
    push = run_git(
        worktree,
        ["push", "--set-upstream", str(context["remote"]), str(context["branch"])],
        timeout=300,
    )
    if push.returncode != 0:
        return False, "Cannot push Git branch: " + git_error(push)
    return True, detail + " push=ok"


def cleanup_git_worktree(context: dict[str, Any] | None) -> None:
    if context is None:
        return
    source = Path(context["source"])
    worktree = Path(context["worktree"])
    result = run_git(source, ["worktree", "remove", "--force", str(worktree)], timeout=300)
    if result.returncode != 0:
        LOG.warning("could not remove completed worktree path=%s detail=%s", worktree, git_error(result))


def task_for(job: dict[str, Any]) -> str:
    project_name = str(job.get("project", ""))
    project_config = PROJECT_CONFIGS[project_name]
    lines = [
            "You are the sole implementation agent for this queued local task.",
            "Work only inside the provided project directory using the available sandbox tools.",
            "Inspect existing files before changing them. Run meaningful verification commands.",
            "Use standard unified PATCH blocks for existing-file edits; a complete FILE block may replace a file when patch context is unstable.",
            "Keep RUN blocks short. Do not embed base64, gzip payloads, or large scripts in RUN blocks.",
            "Never repeat a command that already failed; change strategy using the returned error.",
            "Do not claim success without command output that supports it.",
            "When verified, output ===TASK_COMPLETE=== on its own line.",
            "HOST DEPLOYMENT CONTRACT (authoritative):",
            json.dumps(project_config, ensure_ascii=False, sort_keys=True),
            "You are running inside a sandbox. Its only writable project path is /mnt/workspace.",
            "Host paths in the contract (including /home/ubuntu and /opt) are intentionally invisible in the sandbox.",
            "Never inspect or execute deployCommand, productionRoot, service, or the host workspace from RUN blocks.",
            "Implement and verify only in /mnt/workspace. Then output ===TASK_COMPLETE===.",
            "After that marker, the host dispatcher automatically runs deployCommand and production verification.",
            "If the user asks for production deployment, this role split still applies; do not attempt host deployment yourself.",
            "Task title: " + str(job.get("title", "")),
            "Task instruction:",
            str(job.get("instruction", "")),
    ]
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


def update_result(job_id: str, status: str, last_error: str, detail: str = "") -> None:
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
            "verificationResult": str(current.get("verificationResult", "")),
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


def run_auto_deploy(job: dict[str, Any], workspace: Path, session_id: str, pid: int) -> tuple[bool, str]:
    project_name = str(job.get("project", ""))
    project_config = PROJECT_CONFIGS.get(project_name, {})
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
            deploy_environment["PSEUDO_CODEX_JOB_WORKSPACE"] = str(workspace)
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
            outputs.append(f"auto-deploy attempt={attempt} exit={result.returncode}\n{output}".strip())
            if result.returncode == 0:
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
        source_workspace = project_path(str(job["project"]))
        cwd, git_context = prepare_job_workspace(job, source_workspace)
    except Exception as exc:
        update_result(job_id, "needs_human", str(exc), "Dispatcher rejected the project path.")
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
    ]
    project_config = PROJECT_CONFIGS[str(job["project"])]
    for flag, key in (
        ("--host-workspace", "workspace"),
        ("--host-production-root", "productionRoot"),
        ("--host-deploy-command", "deployCommand"),
    ):
        value = project_config.get(key)
        if isinstance(value, str) and value:
            command.extend([flag, value])
    path = job_log_path(job_id)
    LOG.info("starting job=%s project=%s attempt=%s session=%s", job_id, cwd.name, attempts, session_id)
    started = time.time()
    last_activity = parse_timestamp(job.get("activityAt"), started)
    failure = ""
    manually_stopped = False
    deployment_failed = False

    with path.open("w", encoding="utf-8", errors="replace") as log_handle:
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
        assert process.stdin is not None
        process.stdin.write(task_for(job))
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
    if not failure:
        failure = "" if return_code == 0 and COMPLETE_MARKER in output else (
            f"Agent exited {return_code}; completion marker missing." if return_code == 0 else f"Agent exited {return_code}."
        )
    if not failure:
        current = get_job(job_id)
        if current and current.get("stage") == "stopped":
            LOG.info("job=%s was stopped before deployment", job_id)
            return
        publish_ok, publish_output = publish_git_changes(job, git_context)
        deploy_output = publish_output
        if not publish_ok:
            failure = publish_output
            deployment_failed = True
        else:
            deploy_ok, deploy_output = run_auto_deploy(job, cwd, session_id, process.pid)
            deploy_output = publish_output + "\n" + deploy_output
            if not deploy_ok:
                failure = "Automatic production deployment failed and was rolled back."
                deployment_failed = True
        with path.open("a", encoding="utf-8", errors="replace") as log_handle:
            log_handle.write("\n\nAuto deploy:\n" + deploy_output + "\n")
        if not failure:
            update_progress(job_id, "verifying", "本番health・実画面・Git差分検証完了", session_id, process.pid, "VERIFY")
            update_result(job_id, "done", "", "Completed by ChatGPT browser agent.\n" + deploy_output)
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
    git_config = PROJECT_CONFIGS.get(project, {}).get("git", {})
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
