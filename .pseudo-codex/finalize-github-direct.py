from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:120]!r}")
    file_path.write_text(text.replace(old, new, 1), encoding="utf-8")


# Agent: keep the job running until host-side validation/deployment is complete.
replace_once(
    "agent/agent.js",
    """      await reportResult(args, {
        status: 'done',
        lastError: '',
        workerLog: '',
        finalAnswer: result.summary || 'GitHub direct changes are ready for Ubuntu verification.',
        executionResult: JSON.stringify(result, null, 2),
        verificationResult: 'GitHub branch and pull request created; host-side verification is pending.',
      });
""",
    """      await reportProgress(args, 'verifying', 'GitHub側の作業完了。Ubuntu検証・main同期・本番確認を待機', {
        phase: 'TEST',
        changedFiles: result.changedFiles,
      });
""",
)

# Agent: verification-only is a hard read-only mode, not merely a prompt preference.
replace_once(
    "agent/agent.js",
    """  let prompt = buildInitialPrompt(args.task, args.files, args.cwd);
  let isNew = args.sessionFile ? !fs.existsSync(args.sessionFile) : !args.reuseChat;
""",
    """  let prompt = buildInitialPrompt(args.task, args.files, args.cwd);
  if (args.executionMode === 'verify_only') {
    prompt = [
      'VERIFICATION-ONLY MODE.',
      'Do not modify, create, delete, rename, stage, commit, or push any file.',
      'Use only read-only inspection commands and the smallest relevant verification commands.',
      'At least one verification command must succeed before TASK_COMPLETE.',
      prompt,
    ].join('\\n\\n');
  }
  let isNew = args.sessionFile ? !fs.existsSync(args.sessionFile) : !args.reuseChat;
""",
)
replace_once(
    "agent/agent.js",
    """    if (edits.length || replacements.length || patches.length || changes.length) {
      if (phase === 'INSPECT') phase = 'PLAN';
""",
    """    if (
      args.executionMode === 'verify_only' &&
      (edits.length || replacements.length || patches.length || changes.length)
    ) {
      await blockJob(
        'Verification-only mode refused a file mutation request.',
        'verify_only_mutation'
      );
      return;
    }

    if (edits.length || replacements.length || patches.length || changes.length) {
      if (phase === 'INSPECT') phase = 'PLAN';
""",
)
replace_once(
    "agent/agent.js",
    """    if (completed) {
      if (hasEdited && !verificationPassed) {
""",
    """    if (completed) {
      if (args.executionMode === 'verify_only' && !verificationPassed) {
        prompt = 'Completion rejected: verification-only mode requires at least one successful verification command.';
        continue;
      }
      if (hasEdited && !verificationPassed) {
""",
)

# Dispatcher: each running job uses one project-config snapshot.
replace_once(
    "dispatcher/dispatcher.py",
    """def project_path(project: str) -> Path:
    if not PROJECT_PATTERN.fullmatch(project):
        raise ValueError("project must be a lowercase slug")
    config = get_project_config(project)
""",
    """def project_path(project: str, project_config: dict[str, Any] | None = None) -> Path:
    if not PROJECT_PATTERN.fullmatch(project):
        raise ValueError("project must be a lowercase slug")
    config = project_config or get_project_config(project)
""",
)
replace_once(
    "dispatcher/dispatcher.py",
    """        project_config = get_project_config(str(job["project"]))
        source_workspace = project_path(str(job["project"]))
        cwd, git_context = prepare_job_workspace(job, source_workspace, project_config)
""",
    """        project_config = get_project_config(str(job["project"]))
        source_workspace = project_path(str(job["project"]), project_config)
        cwd, git_context = prepare_job_workspace(job, source_workspace, project_config)
""",
)

# Dispatcher: verification-only never creates a worktree, publishes, or deploys.
replace_once(
    "dispatcher/dispatcher.py",
    """    config = project_config or get_project_config(project_name)
    git_config = config.get("git", {})
    if not isinstance(git_config, dict) or not git_config.get("enabled", False):
        return source_workspace, None
""",
    """    config = project_config or get_project_config(project_name)
    execution_mode = str(config.get("executionMode", "local"))
    if execution_mode == "verify_only":
        return source_workspace, None
    git_config = config.get("git", {})
    if not isinstance(git_config, dict) or not git_config.get("enabled", False):
        return source_workspace, None
""",
)
replace_once(
    "dispatcher/dispatcher.py",
    """    git_config = project_config.get("git", {})
    if project_config.get("executionMode") == "github_direct":
""",
    """    git_config = project_config.get("git", {})
    if project_config.get("executionMode") == "verify_only":
        return "\\n".join(
            [
                "Verification-only task. Do not modify files or Git state.",
                "Run read-only inspection and the smallest relevant tests, then report the results.",
                "Task title: " + str(job.get("title", "")),
                "Task instruction:",
                str(job.get("instruction", "")),
            ]
        )
    if project_config.get("executionMode") == "github_direct":
""",
)
replace_once(
    "dispatcher/dispatcher.py",
    """        publish_output = ""
        deploy_output = ""
        if git_context is None:
            publish_ok, publish_output = publish_git_changes(job, git_context)
""",
    """        publish_output = ""
        deploy_output = ""
        if execution_mode == "verify_only":
            publish_ok = True
            deploy_ok = True
            publish_output = "VERIFY_ONLY_NO_PUBLISH"
            deploy_output = "VERIFY_ONLY_NO_DEPLOY"
        elif git_context is None:
            publish_ok, publish_output = publish_git_changes(job, git_context, project_config)
""",
)

# Dispatcher: validate that the PR belongs to the configured repository and block sensitive paths.
replace_once(
    "dispatcher/dispatcher.py",
    """    pull_request_url = str(result.get("pullRequestUrl", ""))
    expected_branch = str(context["branch"])
    if (
        repository != str(context["repository"])
        or branch != expected_branch
        or base_branch != str(context["baseBranch"])
        or not re.fullmatch(r"[0-9a-fA-F]{40}", commit_sha)
    ):
        return False, "GITHUB_COMPLETE_RESULT_MISMATCH"
""",
    """    pull_request_url = str(result.get("pullRequestUrl", ""))
    changed_files = [str(item) for item in result.get("changedFiles", []) if isinstance(item, str)]
    expected_branch = str(context["branch"])
    expected_pr_prefix = f"https://github.com/{repository}/pull/"
    sensitive_path = re.compile(
        r"(^|/)(?:\\.env(?:\\.|$)|id_[rd]sa(?:\\.|$)|.*\\.(?:pem|key|p12|pfx)|credentials(?:\\.|$)|secrets?(?:\\.|$))",
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
""",
)

# User-facing text: strip legacy H-number/internal markers as well.
for marker in [
    '.replace(/\\bfile_[0-9a-f]{16,}\\b/gi, "")',
    ".replace(/\\bfile_[0-9a-f]{16,}\\b/gi, '')",
]:
    replacement = marker + ("\n.replace(/\\bH\\d{2,}\\b/g, \"\")" if marker.endswith('\"\")') else "\n    .replace(/\\bH\\d{2,}\\b/g, '')")
    replace_once("app.js", marker, replacement)

# Static regression for read-only mode and host-side completion ownership.
Path("tests/agent-verify-only.check.js").write_text(
    '''"use strict";\n\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\n\nconst source = fs.readFileSync(path.join(__dirname, "..", "agent", "agent.js"), "utf8");\nassert.match(source, /VERIFICATION-ONLY MODE/);\nassert.match(source, /Verification-only mode refused a file mutation request/);\nassert.match(source, /verification-only mode requires at least one successful verification command/);\nassert.doesNotMatch(\n  source.slice(source.indexOf("async function runGithubDirect"), source.indexOf("// ─── Parsers")),\n  /status: 'done'/,\n  "GitHub-direct agent must not mark the job done before host validation and deployment"\n);\nconsole.log("AGENT_VERIFY_ONLY_AND_HOST_OWNERSHIP_OK");\n''',
    encoding="utf-8",
)

# Dynamic config reload regression.
Path("tests/dispatcher-config-reload.check.py").write_text(
    '''#!/usr/bin/env python3\nfrom __future__ import annotations\n\nimport importlib.util\nimport json\nimport os\nfrom pathlib import Path\nimport tempfile\nimport time\n\nwith tempfile.TemporaryDirectory() as temporary:\n    root = Path(temporary)\n    projects = root / "projects"\n    workspace = projects / "request-console"\n    workspace.mkdir(parents=True)\n    config_path = root / "projects.json"\n    initial = {"request-console": {"workspace": str(workspace), "executionMode": "local"}}\n    config_path.write_text(json.dumps(initial), encoding="utf-8")\n    os.environ["PSEUDO_CODEX_PROJECT_ROOT"] = str(projects)\n    os.environ["PSEUDO_CODEX_PROJECT_CONFIG"] = str(config_path)\n    os.environ["PSEUDO_CODEX_STATE_DIR"] = str(root / "state")\n\n    dispatcher_path = Path(__file__).resolve().parents[1] / "dispatcher" / "dispatcher.py"\n    spec = importlib.util.spec_from_file_location("dispatcher_config_reload_check", dispatcher_path)\n    module = importlib.util.module_from_spec(spec)\n    assert spec.loader is not None\n    spec.loader.exec_module(module)\n    assert module.get_project_config("request-console")["executionMode"] == "local"\n\n    updated = {"request-console": {"workspace": str(workspace), "executionMode": "verify_only"}}\n    time.sleep(0.01)\n    config_path.write_text(json.dumps(updated), encoding="utf-8")\n    assert module.get_project_config("request-console")["executionMode"] == "verify_only"\n\n    time.sleep(0.01)\n    config_path.write_text("{broken", encoding="utf-8")\n    assert module.get_project_config("request-console")["executionMode"] == "verify_only"\n\nprint("DISPATCHER_DYNAMIC_CONFIG_RELOAD_OK")\n''',
    encoding="utf-8",
)

# Add regressions to the normal npm suite.
replace_once(
    "package.json",
    "node tests/settings-details.check.js && node tests/agent-github-direct.check.js",
    "node tests/settings-details.check.js && node tests/agent-github-direct.check.js && node tests/agent-verify-only.check.js",
)
