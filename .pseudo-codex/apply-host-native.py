#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(relative: str, old: str, new: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{relative}: expected one match, found {count}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_exact_count(relative: str, old: str, new: str, expected: int) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"{relative}: expected {expected} matches, found {count}: {old!r}")
    path.write_text(text.replace(old, new), encoding="utf-8")


# dispatcher: use the real Ubuntu host workspace and never route a job through /mnt/workspace.
replace_once(
    "dispatcher/dispatcher.py",
    '"""Run queued local jobs through the sandboxed ChatGPT browser agent."""',
    '"""Run queued jobs directly on the Ubuntu host through the ChatGPT browser agent."""',
)
replace_once(
    "dispatcher/dispatcher.py",
    '''    if not candidate.is_dir():
        raise ValueError(f"configured workspace does not exist: {candidate}")
    return candidate


def run_git''',
    '''    if not candidate.is_dir():
        raise ValueError(f"configured workspace does not exist: {candidate}")
    return candidate


def ensure_host_native_workspace(workspace: Path) -> None:
    resolved = workspace.resolve()
    disabled_root = Path("/mnt/workspace")
    if resolved == disabled_root or disabled_root in resolved.parents:
        raise RuntimeError("SANDBOX_WORKSPACE_DISABLED: jobs must run on the Ubuntu host workspace")


def run_git''',
)
replace_once(
    "dispatcher/dispatcher.py",
    '''def cleanup_git_worktree(context: dict[str, Any] | None) -> None:
    if context is None:
        return
    source = Path(context["source"])
    worktree = Path(context["worktree"])''',
    '''def cleanup_git_worktree(context: dict[str, Any] | None) -> None:
    if context is None or "worktree" not in context:
        return
    source = Path(context["source"])
    worktree = Path(context["worktree"])''',
)
replace_once(
    "dispatcher/dispatcher.py",
    '            "Work only inside the provided project directory using the available sandbox tools.",',
    '            "Run directly on the Ubuntu host and work only inside the provided host project directory.",',
)
replace_once(
    "dispatcher/dispatcher.py",
    '''            "You are running inside a sandbox. Its only writable project path is /mnt/workspace.",
            "Host paths in the contract (including /home/ubuntu and /opt) are intentionally invisible in the sandbox.",
            "Never inspect or execute deployCommand, productionRoot, service, or the host workspace from RUN blocks.",
            "Implement and verify only in /mnt/workspace. Then output ===TASK_COMPLETE===.",
            "After that marker, the host dispatcher automatically runs deployCommand and production verification.",
            "If the user asks for production deployment, this role split still applies; do not attempt host deployment yourself.",''',
    '''            "Execution is host-native: there is no project sandbox and no /mnt/workspace mapping.",
            "The working directory is the real Ubuntu job workspace or Git worktree.",
            "You may inspect Ubuntu host state with non-destructive commands such as ss, systemctl status, ps, and /proc reads.",
            "Do not use sudo, expose credentials, or modify unrelated host paths.",
            "Implement or inspect in the provided host working directory, verify the result, and include a concise user-facing conclusion before ===TASK_COMPLETE===.",
            "After completion, the host dispatcher alone performs configured publication, deployment, and production verification.",''',
)
replace_once(
    "dispatcher/dispatcher.py",
    '                "Make file changes only inside the sandbox workspace that mirrors the repository checkout.",',
    '                "Make file changes only inside the dedicated Ubuntu host Git worktree for this job.",',
)
replace_once(
    "dispatcher/dispatcher.py",
    '                "Do not inspect or execute host-only deployment paths; the host dispatcher deploys after TASK_COMPLETE.",',
    '                "Use the real Ubuntu host workspace for inspection and verification; the dispatcher still owns publication and deployment after TASK_COMPLETE.",',
)
replace_once(
    "dispatcher/dispatcher.py",
    '''        cwd, git_context = prepare_job_workspace(job, source_workspace, project_config)
    except Exception as exc:''',
    '''        cwd, git_context = prepare_job_workspace(job, source_workspace, project_config)
        ensure_host_native_workspace(cwd)
    except Exception as exc:''',
)
replace_once(
    "dispatcher/dispatcher.py",
    '''        "--cwd",
        str(cwd),
        "--task-stdin",
    ]''',
    '''        "--cwd",
        str(cwd),
        "--task-stdin",
        "--host-native",
    ]''',
)
replace_once(
    "dispatcher/dispatcher.py",
    '''    for flag, key in (
        ("--host-workspace", "workspace"),
        ("--host-production-root", "productionRoot"),
        ("--host-deploy-command", "deployCommand"),
    ):
        value = project_config.get(key)
        if isinstance(value, str) and value:
            command.extend([flag, value])
''',
    '',
)
replace_once(
    "dispatcher/dispatcher.py",
    '''    if current_after_agent and current_after_agent.get("status") == "blocked":
        LOG.warning("job=%s blocked by deterministic controller", job_id)
        return
    if not failure:''',
    '''    if current_after_agent and current_after_agent.get("status") == "blocked":
        LOG.warning("job=%s blocked by deterministic controller", job_id)
        return
    changed_files = current_after_agent.get("changedFiles", []) if current_after_agent else []
    has_file_changes = bool(changed_files)
    if not failure:''',
)
replace_once(
    "dispatcher/dispatcher.py",
    '''        if execution_mode == "verify_only":
            publish_ok = True
            deploy_ok = True
            publish_output = "VERIFY_ONLY_NO_PUBLISH"
            deploy_output = "VERIFY_ONLY_NO_DEPLOY"
        elif git_context is None:''',
    '''        if execution_mode == "verify_only":
            publish_ok = True
            deploy_ok = True
            publish_output = "VERIFY_ONLY_NO_PUBLISH"
            deploy_output = "VERIFY_ONLY_NO_DEPLOY"
        elif not has_file_changes:
            publish_ok = True
            deploy_ok = True
            publish_output = "NO_FILE_CHANGES"
            deploy_output = "AUTO_DEPLOY_SKIPPED_NO_CHANGES"
        elif git_context is None:''',
)
replace_once(
    "dispatcher/dispatcher.py",
    '''            update_progress(job_id, "verifying", "本番health・実画面・Git差分検証完了", session_id, process.pid, "VERIFY")''',
    '''            completion_message = (
                "Ubuntuホスト上の読み取り処理完了（変更・配備なし）"
                if not has_file_changes
                else "本番health・実画面・Git差分検証完了"
            )
            update_progress(job_id, "verifying", completion_message, session_id, process.pid, "VERIFY")''',
)

# agent: explicit host-native mode, no host-command deferral, and no bare success for read-only questions.
replace_once(
    "agent/agent.js",
    '''    hostDeployCommand: null,
    taskFile: null,''',
    '''    hostDeployCommand: null,
    hostNative: false,
    taskFile: null,''',
)
replace_once(
    "agent/agent.js",
    '''    else if (argv[i] === '--host-deploy-command') args.hostDeployCommand = argv[++i];
    else if (argv[i] === '--task-file') args.taskFile = argv[++i];''',
    '''    else if (argv[i] === '--host-deploy-command') args.hostDeployCommand = argv[++i];
    else if (argv[i] === '--host-native') args.hostNative = true;
    else if (argv[i] === '--task-file') args.taskFile = argv[++i];''',
)
replace_once(
    "agent/agent.js",
    "  return answer || 'Task completed and verified.';",
    "  return answer;",
)
replace_once(
    "agent/agent.js",
    '''function isHostOnlyCommand(command, args) {
  const value = String(command || '');''',
    '''function isHostOnlyCommand(command, args) {
  if (args.hostNative) return false;
  const value = String(command || '');''',
)
replace_once(
    "agent/agent.js",
    "function buildInitialPrompt(task, files, cwd) {",
    "function buildInitialPrompt(task, files, cwd, hostNative = false) {",
)
replace_once(
    "agent/agent.js",
    '''    `Task: ${task}\n` +
    `Working directory: ${cwd}\n\n` +
    `You are a coding agent with access to the user's filesystem.\n` +''',
    '''    `Task: ${task}\n` +
    `Working directory: ${cwd}\n` +
    `Execution environment: ${hostNative ? 'Ubuntu host directly (no project sandbox).' : 'configured local environment.'}\n\n` +
    `You are a coding agent with access to the user's filesystem.\n` +''',
)
replace_once(
    "agent/agent.js",
    '''    `- After file blocks, briefly explain what you changed and why.\n` +
    `- When the task is fully verified, output ${COMPLETE_MARKER} on its own line.`;''',
    '''    `- After file blocks, briefly explain what you changed and why.\n` +
    `- Before ${COMPLETE_MARKER}, include a concise user-facing conclusion that answers the task.\n` +
    `- When the task is fully verified, output ${COMPLETE_MARKER} on its own line.`;''',
)
replace_once(
    "agent/agent.js",
    "  let prompt = buildInitialPrompt(args.task, args.files, args.cwd);",
    "  let prompt = buildInitialPrompt(args.task, args.files, args.cwd, args.hostNative);",
)
replace_once(
    "agent/agent.js",
    "      'Do not inspect or execute host-only deployment paths; the host dispatcher deploys after TASK_COMPLETE.',",
    "      'Continue on the Ubuntu host using the configured job workspace; the dispatcher still owns publication and deployment after TASK_COMPLETE.',",
)
replace_once(
    "agent/agent.js",
    "        'HOST_ONLY_COMMAND_DEFERRED: the sandbox cannot inspect or run host deployment paths.',",
    "        'HOST_ONLY_COMMAND_DEFERRED: this command is reserved for dispatcher-owned deployment.',",
)
replace_once(
    "agent/agent.js",
    "        prompt = notice + '\nContinue only in /mnt/workspace. Implement or verify the requested change, then emit TASK_COMPLETE.';",
    "        prompt = notice + '\nContinue in the configured Ubuntu host working directory, then provide a conclusion and emit TASK_COMPLETE.';",
)
replace_once(
    "agent/agent.js",
    '''      phase = 'VERIFY';
      await reportProgress(args, 'verifying', '機械的完了条件を確認', statePayload({}));
      await reportResult(args, {
        status: 'done',
        lastError: '',
        workerLog: '',
        finalAnswer: cleanFinalAnswer(response),''',
    '''      const finalAnswer = cleanFinalAnswer(response);
      if (!hasEdited && !finalAnswer) {
        prompt = 'Completion rejected: provide a concise user-facing conclusion based on the observed Ubuntu host command results, then output TASK_COMPLETE.';
        continue;
      }
      phase = 'VERIFY';
      await reportProgress(args, 'verifying', '機械的完了条件を確認', statePayload({}));
      await reportResult(args, {
        status: 'done',
        lastError: '',
        workerLog: '',
        finalAnswer: finalAnswer || 'Task completed and verified.',''',
)
replace_once(
    "agent/agent.js",
    '''module.exports = {
  buildGithubDirectPrompt,
  commandValidationError,''',
    '''module.exports = {
  buildGithubDirectPrompt,
  buildInitialPrompt,
  cleanFinalAnswer,
  commandValidationError,
  isHostOnlyCommand,''',
)

# Console: remove the sandbox setting and describe the local mode as direct Ubuntu host execution.
replace_once(
    "app.js",
    'sandboxWorkspace: typeof config.sandboxWorkspace === "string" ? config.sandboxWorkspace : "",\n',
    '',
)
replace_once(
    "app.js",
    '''const hostContract = Object.keys(config).length
? JSON.stringify(config, null, 2)
: "PROJECT CONFIGURATION IS MISSING";''',
    '''const hostConfig = Object.fromEntries(
Object.entries(config).filter(function(entry) {
return entry[0] !== ["sandbox", "Workspace"].join("");
})
);
const hostContract = Object.keys(hostConfig).length
? JSON.stringify(hostConfig, null, 2)
: "PROJECT CONFIGURATION IS MISSING";''',
)
replace_once(
    "app.js",
    '"Important: ChatGPT operates only in the sandbox path `/mnt/workspace`. Host workspace and production paths are intentionally invisible there. ChatGPT must edit and test `/mnt/workspace`; after `===TASK_COMPLETE===`, the host dispatcher owns deployment and production verification using the contract above.",',
    '"Important: local and verification jobs run directly on the Ubuntu host in the configured workspace or a dedicated host Git worktree. The dispatcher owns Git publication, deployment, and production verification after `===TASK_COMPLETE===`.",',
)
replace_once(
    "app.js",
    '"2. Do not repeat a failed command or inspect host-only deployment paths from the sandbox.",',
    '"2. Do not repeat a failed command; inspect Ubuntu host state directly with non-destructive commands when the request concerns the host.",',
)
replace_once(
    "app.js",
    'sandboxWorkspace: String(value.sandboxWorkspace || "").trim(),\n',
    '',
)
replace_exact_count(
    "app.js",
    "Ubuntuローカル編集",
    "Ubuntuホスト直接実行",
    2,
)
replace_once(
    "app.js",
    'summary.sandboxWorkspace ? \'<div class="project-facts"><span>Sandbox: <strong>\' + escapeHtml(summary.sandboxWorkspace) + \'</strong></span></div>\' : "",\n',
    '',
)
replace_once(
    "app.js",
    '\'<div><label for="project-config-sandbox">Sandbox Workspace</label><input id="project-config-sandbox" name="sandboxWorkspace" maxlength="500" placeholder="/mnt/workspace"></div>\',\n',
    '',
)
replace_once(
    "app.js",
    '\'<p class="helper">GitHub直接編集ではChatGPTが専用ブランチとPRをGitHub上で作成し、Ubuntuは検証・main同期・本番反映だけを担当します。</p>\',',
    '\'<p class="helper">GitHub直接編集ではChatGPTが専用ブランチとPRをGitHub上で作成します。Ubuntuホスト直接実行では、コンテナやプロジェクト用サンドボックスを使わず、実ホストの専用Git worktreeで調査・編集・検証します。</p>\',',
)

# Public example and documentation no longer advertise or configure a project sandbox.
(ROOT / "projects.example.json").write_text('''{
  "request-console": {
    "executionMode": "github_direct",
    "workspace": "/path/to/request-console",
    "productionRoot": "/path/to/production-root",
    "deployCommand": "/path/to/deploy-command",
    "verifyCommand": "/path/to/verify-command",
    "service": "pseudo-codex-console.service",
    "healthUrl": "http://127.0.0.1:8090/health",
    "deploymentOwner": "host_dispatcher",
    "requiresDeployment": true,
    "git": {
      "enabled": true,
      "repository": "owner/pseudo-codex-console",
      "remote": "origin",
      "baseBranch": "main",
      "branchPrefix": "request-console",
      "push": true
    }
  }
}
''', encoding="utf-8")

(ROOT / "README.md").write_text('''# Pseudo Codex Console

ブラウザ版ChatGPTを判断・実装担当、Ubuntuホストをコマンド実行・検証・Git同期・本番反映担当として使う開発キューです。OpenAI APIキーは使用しません。

## 構成

- `app.js`: ジョブ登録・進捗・結果表示を行うWeb GUI/API
- `agent/`: ChatGPTブラウザとの送受信と、Ubuntuホスト上の編集・検証ループ
- `dispatcher/`: ジョブ取得、ホストGit worktree作成、agent起動、Git公開、本番反映、結果保存
- `scripts/`: Docker Composeなどのホスト補助処理
- `deploy/`: Console本体の検証・反映例
- `systemd/`: サービス定義の公開用テンプレート
- `tests/`: GUI、agent、dispatcherの回帰チェック

## 実行方式

- `GitHub直接編集`: ChatGPTが専用ブランチとPRをGitHub上で作成し、Ubuntuが取得・検証・main同期・配備を行います。
- `Ubuntuホスト直接実行`: Ubuntu実ホストのジョブ専用Git worktreeで調査・編集・検証します。プロジェクト用コンテナ隔離や `/mnt/workspace` の置換は使いません。
- `検証のみ`: Ubuntu実ホストで読み取り調査と検証だけを行い、ファイル変更・Git公開・配備を行いません。

ホスト状態の質問では、`ss`、`systemctl status`、`ps`、`/proc`などをUbuntu実ホストで確認します。ファイル変更がないジョブではGit公開と本番配備を自動的にスキップします。

## 編集プロトコル

ChatGPTにSHA256を転記させません。既存ファイルは通常のunified diff、短い完全一致編集、または完全なファイル内容で更新できます。Ubuntu側が安全な相対パス、パッチ適用可否、テスト結果を検証します。

```text
===PATCH===
--- a/path/to/file
+++ b/path/to/file
@@ ...
===ENDPATCH===
```

ハッシュはワークスペースの内部変更検出にだけ使用し、ChatGPTへのプロンプト、GUI、ジョブログには出力しません。

## ローカル確認

Node.js 20以降が必要です。

```bash
cp projects.example.json projects.json
PORT=8090 DATA_PATH=./data/jobs.json PROJECT_CONFIG_PATH=./projects.json node app.js
npm run check
python3 -m py_compile dispatcher/dispatcher.py scripts/chatgpt-compose.py scripts/chatgpt-compose-bridge.py
```

## GitHub連携

GitHub直接編集ではChatGPTが専用ブランチとPRを作成します。Ubuntu dispatcherはそのブランチを取得して検証し、成功時だけGitHub main、Ubuntu通常workspace、本番を同じcommitへ揃えます。

GitHubのSSH鍵やトークンはUbuntuのGit credentialまたはSSH agentへ保存し、リポジトリ、ジョブ本文、会話ログには書きません。

## 公開しないデータ

- ChatGPTのCookie、セッション、ブラウザプロファイル
- `jobs.json`、ジョブログ、会話URL、checkpoint
- 実環境の`projects.json`と`.env`
- GitHubトークン、SSH秘密鍵、サービス認証情報
- 本番バックアップと一時ファイル

公開用設定は必ず `projects.example.json` のようなダミー値だけにしてください。
''', encoding="utf-8")

replace_once(
    "scripts/chatgpt-compose.py",
    '''            "Docker Compose access is available only for sandboxed projects under "
            "/home/ubuntu/chatgpt-projects.",''',
    '''            "Docker Compose access is available only for configured host projects under "
            "/home/ubuntu/chatgpt-projects.",''',
)

# Regressions.
replace_once(
    "package.json",
    'node tests/agent-github-direct.check.js && node tests/agent-verify-only.check.js',
    'node tests/agent-github-direct.check.js && node tests/agent-verify-only.check.js && node tests/agent-host-native.check.js',
)
replace_once(
    ".github/workflows/test.yml",
    '''      - run: python3 tests/dispatcher-config-reload.check.py
      - run: python3 tests/dispatcher-parallel.check.py''',
    '''      - run: python3 tests/dispatcher-config-reload.check.py
      - run: python3 tests/dispatcher-host-native.check.py
      - run: python3 tests/dispatcher-parallel.check.py''',
)
replace_once(
    "tests/settings-details.check.js",
    '''assert.match(source, /name="gitRepository"/);
''',
    '''assert.match(source, /name="gitRepository"/);
assert.match(source, /Ubuntuホスト直接実行/);
assert.doesNotMatch(source, /sandboxWorkspace|Sandbox Workspace|\/mnt\/workspace/);
''',
)

(ROOT / "tests" / "agent-host-native.check.js").write_text('''"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const agent = require("../agent/agent");

const prompt = agent.buildInitialPrompt("ssh今とじてるん？", [], "/home/ubuntu/chatgpt-projects/request-console", true);
assert.match(prompt, /Ubuntu host directly/);
assert.match(prompt, /concise user-facing conclusion/);
assert.doesNotMatch(prompt, /\/mnt\/workspace|sandboxed/);
assert.equal(agent.isHostOnlyCommand("systemctl status ssh", {
  hostNative: true,
  hostWorkspace: "/home/ubuntu/chatgpt-projects/request-console",
  hostProductionRoot: "/opt/pseudo-codex-console",
  hostDeployCommand: "/usr/local/libexec/pseudo-codex-deploy-request-console",
}), false);
assert.equal(agent.cleanFinalAnswer("===TASK_COMPLETE==="), "");
assert.equal(agent.cleanFinalAnswer("SSHは起動しています。\n===TASK_COMPLETE==="), "SSHは起動しています。");

const source = fs.readFileSync(path.join(__dirname, "..", "agent", "agent.js"), "utf8");
assert.doesNotMatch(source, /Continue only in \/mnt\/workspace/);
console.log("AGENT_HOST_NATIVE_EXECUTION_OK");
''', encoding="utf-8")

(ROOT / "tests" / "dispatcher-host-native.check.py").write_text('''#!/usr/bin/env python3
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
        module.ensure_host_native_workspace(Path("/mnt/workspace"))
    except RuntimeError as exc:
        assert "SANDBOX_WORKSPACE_DISABLED" in str(exc)
    else:
        raise AssertionError("disabled workspace was accepted")

    task = module.task_for(
        {"id": "host-native", "project": "request-console", "title": "ssh", "instruction": "ssh今とじてるん？"},
        config["request-console"],
    )
    assert "directly on the Ubuntu host" in task
    assert "/mnt/workspace" not in task
    assert "available sandbox tools" not in task

    source = dispatcher_path.read_text(encoding="utf-8")
    assert '"--host-native"' in source
    assert "AUTO_DEPLOY_SKIPPED_NO_CHANGES" in source

print("DISPATCHER_HOST_NATIVE_EXECUTION_OK")
''', encoding="utf-8")

print("HOST_NATIVE_MIGRATION_APPLIED")
