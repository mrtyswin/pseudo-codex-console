"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

assert.match(source, /--job-detail-content-height:clamp\(22rem,52dvh,31rem\)/);
assert.match(source, /\.detail-job>details>pre,[^']*block-size:var\(--job-detail-content-height\)/);
assert.match(source, /function scrollDetailToBottom\(detailsNode\)/);
assert.match(source, /detailViewStates = new Map\(\)/);
assert.match(source, /userScrolled: false/);
assert.match(source, /rememberDetailView\(detailsNode, true\)/);
assert.match(source, /detailsNode\.dataset\.detailScrollRestoring === "true"/);

assert.match(source, /現在の工程:/);
assert.match(source, /ChatGPTとの残り往復:/);
assert.match(source, /実装方針: <strong>第/);
assert.match(source, /まだ実装方針の切り替えはありません。/);
assert.match(source, /Ubuntuの正規ワークスペースに未完了の変更が残っているため/);

assert.match(source, /class=\"chat-row chat-row-user\"/);
assert.match(source, /class=\"chat-row chat-row-assistant\"/);
assert.match(source, /class=\"chat-bubble\"/);
assert.match(source, /実行・変更の詳細/);
assert.match(source, /function extractRequesterMessage\(value\)/);
assert.match(source, /function extractAssistantMessage\(value\)/);
assert.match(source, /\.replace\(\/===RUN:\[\\s\\S\]\*\?===\/g, \"\"\)/);
assert.match(source, /\.replace\(\/===RUN===\[\\s\\S\]\*\?===ENDRUN===\/g, \"\"\)/);
assert.match(source, /Array\.isArray\(turn\.commandResults\)/);
assert.match(source, /Array\.isArray\(turn\.checkResults\)/);
assert.match(source, /chat-avatar/);
assert.match(source, /依頼者 ↔ ChatGPT/);
assert.match(source, /data-conversation-style="line"/);
assert.match(source, /LINE風の左右吹き出しで会話を表示/);
assert.doesNotMatch(source, /Slack風のスレッドで会話を表示/);
assert.match(source, /class=\"conversation-details\"[^\n]+\n[^\n]+\n'\" open>'/);
assert.match(source, /role=\"log\" aria-label=\"ChatGPTとの会話\"/);
assert.match(source, /\[data-conversation-style="slack"\] \.chat-row-user/);
assert.match(source, /\[data-conversation-style="slack"\] \.chat-row-assistant\{justify-content:flex-start/);
assert.match(source, /\[data-conversation-style="slack"\] \.chat-row-user \.chat-bubble::after/);
assert.match(source, /\[data-conversation-style="slack"\] \.chat-row-assistant \.chat-bubble::before\{content:none\}/);
assert.match(source, /\[data-conversation-style="slack"\] \.chat-thread\{[^}]*background:#fff;[^}]*background-image:none/);
assert.match(source, /\[data-conversation-style="slack"\] \.chat-avatar\{[^}]*border-radius:8px/);
assert.match(source, /\[data-conversation-style="slack"\] \.chat-bubble,[^}]*background:transparent;box-shadow:none/);
assert.match(source, /minmax\(440px,1\.1fr\)/);

console.log("JOB_DETAIL_UX_OK");
