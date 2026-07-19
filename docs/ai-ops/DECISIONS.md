# 設計判断の記録（Architecture Decision Log）

後継モデルが**再検討し直さない**ための記録。消さない。覆ったら「却下/上書き」を追記する。

## 記録フォーマット

```
## ADR-NNN: <タイトル>  (YYYY-MM-DD, status: adopted | superseded | rejected)
- 背景: <なぜ判断が必要になったか>
- 決定: <何を決めたか>
- 理由: <なぜ>
- 却下した案: <検討して捨てた案とその理由>
- 影響: <どこに効くか。既定挙動への影響>
- 将来見直す条件: <この判断を再考すべきトリガ>
```

---

## ADR-001: ブラウザ版 ChatGPT を課金 API でなく WebSocket 受信で使う  (2026-07-19, status: adopted)
- 背景: ユーザーが「ブラウザの内部 API を叩けば速く安定するのでは」と提案。課金 API は使わない前提。
- 決定: **純内部 API 直叩きは採用しない。** 送信は GUI（正規ページ）に任せ、受信だけ CDP で
  WebSocket フレームを捕捉して `ws-decode.js` で復元する「送信=GUI・受信=WS」ハイブリッドを採用。
- 理由: 実測で純 API は `/backend-api/sentinel/chat-requirements` が proof-of-work + Cloudflare Turnstile
  を要求し、会話 POST が 403「Unusual activity」。Turnstile 突破はいたちごっこ。一方、応答は
  per-tab WebSocket（`wss://.../p16/ws/user/…`）で配送され、CDP `Network.webSocketFrameReceived` で
  全フレームが取れることを実測確認。フレームの `payload.payload.encoded_item` に元 SSE（delta_encoding v1）が
  トンネルされている。
- 却下した案: (a) 純 backend-api 直叩き → Turnstile で 403。(b) ページの `window.fetch` フック →
  送信 `/backend-api/f/conversation` はメインスレッド fetch に現れず捕捉不可（当初「Service Worker」と
  誤断、正確には別スレッド/別経路。観測方法の限界だった）。
- 影響: 受信の markdown/コード/差分が崩れなくなる（DOM の innerText はコードフェンスを落とす）。
  完了タイミングは DOM 継続。`PSEUDO_CODEX_WS_CAPTURE=off/shadow/on` で段階制御。既定 off は挙動不変。
- 将来見直す条件: ChatGPT が WS 封筒/delta 形式を変えたら decoder を追随。完了検出も WS 化したくなったら
  ADR を追加（`finished_successfully` が中間で多発するため真の turn 終了検出の作り込みが要る）。

## ADR-002: 受信の完了タイミングは DOM が持ち、内容だけ WS を採用  (2026-07-19, status: adopted)
- 背景: 完了検出を WS の `done` ポーリングで行ったら、中間の `finished_successfully`（1 ターンに多数）で
  早期に切れて応答が途中で途切れ、ジョブが MALFORMED を出して 16 ターンもループした。
- 決定: DOM の完了待ち（`waitWithRecovery`）でターン終了を待ち、その後に**全フレームを一括デコード**して
  内容を採用する。`on` モードもこの順序（= shadow と同じタイミング）。
- 理由: 全フレームを揃えてからデコードすれば正しい全文が出る（shadow で DOM とバイト一致を実証、
  カスタム指示 preamble の多メッセージ turn も一致）。早期 done ポーリングは不正確。
- 却下した案: WS の done で早期リターン → 途中切れ。
- 影響: 「Waiting failed」等の DOM タイムアウトは残るが、それは infra-retry で吸収済み。
- 将来見直す条件: 真の turn 終了シグナルを WS 側で確実に検出できるようになったら DOM 依存を外せる。

## ADR-003: インフラ障害は attempt を消費せず自動再キュー  (2026-07-18, status: adopted)
- 背景: ブラウザ無応答・タイムアウトで、実装の失敗でないのに attempt を食い尽くしジョブが全滅していた。
- 決定: ブラウザ/接続系の失敗（`ETIMEDOUT`/`Waiting failed:`/`socket hang up`/`Protocol error`/
  `browser remained unresponsive` 等）は attempt を返金し、別枠 `infraRetries`（上限既定 10）で再キュー。
  連続インフラ失敗でブラウザ強制再起動。手動再実行は attempt/infraRetries をリセット。
- 却下した案: 失敗一律で attempt 消費 → 全滅。
- 影響: 深夜の不安定でもジョブが死なず粘る。分類漏れ（`Waiting failed`/`socket hang up`）は後から実障害で
  発見して追加した → 「分類は実データで育てる」。
- 将来見直す条件: 新しいインフラ失敗語が出たら `INFRA_FAILURE_MARKERS` に追加。

## ADR-004: 同一リポジトリのジョブは直列実行を既定に  (2026-07-18, status: adopted)
- 背景: 並列 worktree が同じ base branch へ rebase して、遅い方が必ず `GIT_REBASE_CONFLICT` で死んでいた。
- 決定: 同一プロジェクトのジョブは直列。`git.allowParallelJobs: true` で明示オプトイン時のみ並列。
- 影響: rebase 衝突の激減。
- 将来見直す条件: プロジェクトが真に独立並列可能な構成になったら再考。

## ADR-005: ブラウザエージェントの変更は request-console/agent 正典へ + manifest 追加  (2026-07-19, status: adopted)
- 背景: `/home/ubuntu/chatgpt-browser-agent/chatgpt.js` を直接編集したが、デプロイが正典から上書きして
  変更が消えた。新規モジュールは配備されず require で即死しうる。
- 決定: 変更は必ず `request-console/agent/` に入れる。新規ファイルは `deploy/deploy-request-console` の
  ファイルリストと `node --check` 検証にも追加する。PR → deploy で永続化。
- 影響: 変更がデプロイ後も残る。配備漏れによる起動失敗を防ぐ。
- 将来見直す条件: 配備方式が rsync 全同期等に変わったら manifest 追記は不要になる。

## ADR-006: 添付は最初のターンだけ ChatGPT にアップロードする（複数・全種類）  (2026-07-19, status: adopted; PR #59 → #61 で複数対応)
- 背景: コンソールは添付をディスク保存し、指示テキストに「参考ファイル」ブロックとしてパスを
  埋め込むだけだった。`agent.js` が `chatgpt.js` に `--upload` を渡さず、visual アップロード
  されず（`upload=none`）、ChatGPT が画像を見ずに位置を推測して外していた。
- 決定: `agent.js` の `extractUploadPaths(taskText)` が「参考ファイル」ブロックから**全ての読取可能な
  ファイル（種別不問・複数・順序保持）**を拾い、run ループの **turns===1 の時だけ** `ask(..., uploadPaths)` →
  繰り返し `--upload` を渡す。`chatgpt.js` の `uploadFileToChatGPT(page, uploadPaths, log)` が
  `inputHandle.uploadFile(...abses)` で一括アップロード（存在しないものは skip、ジョブは落とさない）。
- 理由: 送信側だけ繋げば済む最小変更。2 ターン目以降（RUN 出力の往復）で再アップロードしないため
  turns===1 に限定。`inputHandle.uploadFile` は元々複数引数可・種別制限なしだったので拡張は自然。
  実機で画像2枚＋テキスト1枚を全て正確に読めることを検証（`upload=` に全パスが並び、回答が全内容と一致）。
- 経緯の教訓: 初版(#59)は Claude の判断で「先頭1枚・画像のみ」に絞ったが、それはユーザー要件ではなく
  実装上の勝手な制約だった。ユーザー指摘で #61 にて複数・全種類へ拡張。**「賢い既定」でスコープを
  勝手に狭めない**——ユーザーが制約を付けていないなら能力どおり実装する。
- 却下した案: (a) dispatcher から明示 --upload を渡す → dispatcher は添付を知らず、パスは instruction 内に
  しかない。(b) 全ターンでアップロード → 無駄・誤爆。
- 影響: 添付ジョブで ChatGPT が実際に全ファイルを見る。添付が無ければ挙動不変。
- 将来見直す条件: ChatGPT 側の同時アップロード枚数/サイズ上限に当たる場合は分割等が要る。
