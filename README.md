# Pseudo Codex Console

ブラウザ版ChatGPTを修正案生成担当、Ubuntuをファイル操作・テスト・Git反映担当として使うローカル開発キューです。OpenAI APIキーは使用しません。

## 構成

- `app.js`: ジョブ登録・進捗・結果表示を行うWeb GUI/API
- `agent/`: ChatGPTブラウザとの送受信と、サンドボックス内の編集ループ
- `dispatcher/`: ジョブ取得、agent起動、本番反映、結果保存
- `scripts/`: サンドボックスと限定Docker Composeブリッジ
- `deploy/`: Console本体の検証・反映例
- `systemd/`: サービス定義の公開用テンプレート
- `tests/`: GUIとagentの回帰チェック

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

ChatGPTはGitHub上のコードを読み、修正内容を生成します。Ubuntu側はジョブ専用ブランチで変更を適用し、テスト成功後だけpushします。GitHubのSSH鍵やトークンはUbuntuのGit credentialまたはSSH agentへ保存し、リポジトリやジョブ本文には書きません。

標準のChatGPT GitHub連携は読み取り用途です。GitHubへの書き込みはdispatcherを動かすUbuntuが担当します。

## 公開しないデータ

- ChatGPTのCookie、セッション、ブラウザプロファイル
- `jobs.json`、ジョブログ、会話URL、checkpoint
- 実環境の`projects.json`と`.env`
- GitHubトークン、SSH秘密鍵、サービス認証情報
- 本番バックアップと一時ファイル

公開用設定は必ず `projects.example.json` のようなダミー値だけにしてください。
