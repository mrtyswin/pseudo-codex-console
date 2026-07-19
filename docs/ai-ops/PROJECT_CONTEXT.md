# プロジェクト文脈（後継モデルが会話履歴なしで理解するための正典）

最終更新: 2026-07-19。事実が変わったら該当行を書き換えること。

---

## 目的

**Pseudo Codex Console** — ブラウザ版 ChatGPT を「頭脳」、Ubuntu ホストを「実行係」にした
開発ジョブキュー。ユーザーがコンソール（Web UI）からタスクを登録すると、dispatcher が
ChatGPT ブラウザエージェント経由でコードを書かせ、Ubuntu 上で実行・テスト・Git 公開・
本番デプロイまで自動で回す。課金 API を使わず、ログイン済みブラウザ版 ChatGPT を使うのが肝。

GitHub: `mrtyswin/pseudo-codex-console`。

---

## 技術構成・主要ディレクトリ（正典は request-console リポジトリ）

- `app.js` — コンソール本体（HTTP サーバ、ジョブ状態管理、Web UI 描画）。Node、単一ファイル巨大。
- `dispatcher/dispatcher.py` — ジョブを取り出し ChatGPT エージェントを起動、公開・デプロイを統括。
- `agent/` — ブラウザエージェントの**正典**:
  - `agent/chatgpt.js` — ChatGPT ブラウザ常駐デーモン（puppeteer-extra + stealth）。送信・受信。
  - `agent/agent.js` — ジョブ実行コントローラ（ターン制御、プロトコル）。
  - `agent/ws-decode.js` — 応答 WebSocket フレームの delta_encoding v1 デコーダ。
  - `agent/fake-browser-client.js`, `agent/mcp-server.js`。
- `tests/*.check.js`(Node) / `tests/*.check.py`(Python) — テスト。`tests/fixtures/` に実キャプチャ等。
- `deploy/deploy-request-console` — **デプロイ manifest**（どのファイルをどこへ配るかの明示リスト）。
- `scripts/deploy-request-console-main` — デプロイ入口（テスト→配備→検証まで）。

---

## 実行・テスト・デプロイ

- **テスト**: `npm run check`（= `check:console` + `check:agent` + `check:dispatcher`）。構文は `check:syntax`。
  新テストは `tests/` に置き、`package.json` の該当 `check:*` に追記して初めて回る。
- **本番稼働**: サービス 3 つ。すべて active が正常。
  - `pseudo-codex-console.service`（system）: コンソール、`http://127.0.0.1:8090/`。
  - `pseudo-codex-dispatcher.service`（--user）: ジョブ実行。
  - `chatgpt-browser-agent.service`（--user）: ChatGPT ブラウザ。
- **デプロイ**: `scripts/deploy-request-console-main`。main がクリーン & GitHub と一致している前提で、
  テスト全実行 → manifest に従い本番へ配備 → デーモン再起動 → health/実挙動検証。
- **改修フロー**: `agent/<機能名>` ブランチ → PR → merge → deploy。**main へ直接コミット禁止**。

---

## 既知の制約・地雷（触る前に必ず読む）

1. **【最重要】デプロイは正典を配備物に上書きコピーする。** ブラウザエージェントの正典は
   `request-console/agent/*.js`。デプロイが `deploy/deploy-request-console` の**明示ファイルリスト**に
   従って `/home/ubuntu/chatgpt-browser-agent/` へコピー & デーモン再起動する。
   → **`/home/ubuntu/chatgpt-browser-agent/*.js` を直接編集してもデプロイで消える。** 変更は必ず
   `request-console/agent/` に入れ、**新規モジュールは manifest のリストにも追加**しないと配備されず
   `require` で即死する。（2026-07-19 に実際にハマった。）
2. **添付画像のアップロードは修正済み（2026-07-19, PR #59）。** かつては添付スクショが
   コンソール側ディスクに保存されても指示テキストにパスが埋まるだけで、`agent.js` が
   `chatgpt.js` に `--upload` を渡さず、ChatGPT が画像を見ずに位置を推測して外していた（`upload=none`）。
   現在は `agent.js` の `extractUploadImagePath` が指示の「参考ファイル」ブロックから最初の画像を拾い、
   最初のターンだけ `--upload` で渡す。実機で固有文字画像を正確に読めることを確認済み。
   **残る注意点**: `--upload` は単一のため、添付が複数でも先頭 1 枚のみ visual アップロード
   （残りはパス参照のまま）。詳細は `DECISIONS.md` ADR-006。
3. **ChatGPT ブラウザは不安定。** 無応答・接続断・タイムアウトが起きる。これらは「ジョブの失敗」でなく
   インフラ障害として扱い、attempt を消費せず自動再キューする仕組みが入っている（`infraRetries`）。
   分類語: `ETIMEDOUT` / `Waiting failed:` / `socket hang up` / `Protocol error` / `browser remained unresponsive` 等。
4. **同一リポジトリのジョブは直列実行。** 並列 worktree が同じ base へ rebase して衝突するため
   （`git.allowParallelJobs` でのみ並列許可）。
5. **深夜は ChatGPT 応答が遅い。** ジョブが長引く。急ぎでなければ日中。
6. **agent/chatgpt.js・agent/agent.js は origin/master 比で大量の未コミット差分**が別リポジトリ
   （browser-agent 実体）側にある。安易な `git checkout` は破壊的。正典操作は request-console 側で行う。

---

## ユーザーの優先事項（作業方針）

- **検証を強く重視。「嘘の環境で成功と言うな」。** 前任（Codex CLI）が「完了」と過大報告して信頼を失い
   引き継いだ経緯がある。実行結果を自分の目で見て報告すること。
- **「できたことにして放置」を嫌う。** 動くまで責任を持って面倒を見る。委任しても完了責任は Claude。
- **トークンを無駄にしたくない。** 状況確認の往復や実送信の乱発を避ける。放置してよい所は放置し、
   確定時に 1 回報告する。
- **許可プロンプトの乱発を嫌う。** 確認コマンドは集約し、allowlist / bypass を活用。
- **実機・実データでの確認**を、テストだけの緑より信頼する。

---

## 現在の未完了事項（2026-07-19 時点）

- 受信 WS 化の v2: 完了タイミングも WS で検出して DOM 依存を外す（今は DOM 完了待ち + infra-retry で実用十分）。
- 添付が複数画像の場合、先頭 1 枚しか visual アップロードされない（残りはパス参照）。複数画像対応は未着手。
- 旧い失敗ジョブ（7/17 分）の一部が UI 上「失敗」表示のまま（実体は解決済み）。
- 添付/コード/差分のテストフィクスチャ拡充。

---

## 変更してはいけない仕様（既定挙動の保護）

- `PSEUDO_CODEX_WS_CAPTURE` 未設定（off）時の受信は従来 DOM 経路と完全一致であること。
- デプロイは「main push → 検証」の順序（検証失敗でも main が進む構造課題は認識済み。勝手に作り替えない）。
- ジョブの完了マーカー `===TASK_COMPLETE===` は単独行判定（引用による偽 done 防止）。
