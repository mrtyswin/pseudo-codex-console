# Pseudo Codex Console

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
- `Ubuntuホスト直接実行`: Ubuntu実ホストのジョブ専用Git worktreeで調査・編集・検証します。隔離用ワークスペースへの置換は行いません。
- `検証のみ`: Ubuntu実ホストで読み取り調査と検証だけを行い、ファイル変更・Git公開・配備を行いません。

ホスト状態の質問では、`ss`、`systemctl status`、`ps`、`/proc`などをUbuntu実ホストで確認します。ファイル変更がないジョブではGit公開と本番配備を自動的にスキップします。

dispatcher は2 workerで動作し、異なるプロジェクトまたはGitの専用worktreeを持つジョブを並列処理します。各ジョブは専用のChatGPT page、session key、conversation fileを持ちます。同じ非Git workspaceのジョブは競合防止のため直列のままです。

Git設定の `workspaceMode` は既定で `worktree` です。`primary` を指定すると、ChatGPTは設定されたUbuntuの正規workspaceを直接使用し、開始前にcleanなbase branchとGitHub同期を確認します。このモードのプロジェクトは競合防止のため常に直列実行されます。

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

## Request-Console Self-Update

`request-console` 自身の改修もブラウザ queue から登録できます。dispatcher は通常 workspace の `main` を直接編集せず、ジョブ専用の Git worktree と branch で変更・検証・公開を行います。GitHub `main` への反映後、Ubuntu `main` は `pull --ff-only` とテストと deploy だけを担当します。

実運用の `request-console` 例:

```json
{
  "executionMode": "local",
  "workspace": "/home/ubuntu/chatgpt-projects/request-console",
  "deployCommand": "/usr/local/libexec/pseudo-codex-deploy-request-console",
  "verifyCommand": "/usr/local/lib/pseudo-codex-console-deploy/verify-live.js",
  "git": {
    "enabled": true,
    "repository": "owner/pseudo-codex-console",
    "remote": "origin",
    "baseBranch": "main",
    "branchPrefix": "request-console",
    "push": true
  }
}
```

一度だけ必要な bootstrap:

- `/usr/local/libexec/pseudo-codex-deploy-request-console` を `deploy/deploy-request-console` へ向ける
- `/usr/local/bin/chatgpt-browser-agent` を `scripts/chatgpt-browser-agent` へ向ける
- `/usr/local/lib/pseudo-codex-console-deploy/check.js` を `check.js` へ向ける
- `/usr/local/lib/pseudo-codex-console-deploy/verify-live.js` を `deploy/verify-live.js` へ向ける
- `ubuntu` に `pseudo-codex-console.service` の `restart` と `is-active` だけ passwordless sudo を許可する

この bootstrap が済んでいれば、以後は pull request の merge 後に `scripts/deploy-request-console-main` を実行します。このコマンドは Ubuntu workspace が clean な `main` で `origin/main` と同一であることを確認し、全テスト後に本番へ反映します。

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
