"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

assert.match(source, /--job-detail-content-height:clamp\(14rem,42dvh,22rem\)/);
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
assert.match(source, /role=\"log\" aria-label=\"ChatGPTとの会話\"/);
assert.match(source, /\.chat-row-user\{justify-content:flex-end\}/);
assert.match(source, /\.chat-row-assistant\{justify-content:flex-start\}/);

console.log("JOB_DETAIL_UX_OK");
