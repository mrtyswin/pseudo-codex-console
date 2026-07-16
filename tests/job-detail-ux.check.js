"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

const requiredFragments = [
"--job-detail-content-height:clamp(22rem,52dvh,31rem)",
"max-block-size:var(--job-detail-content-height)",
"function scrollDetailToBottom(detailsNode)",
"detailViewStates = new Map()",
"userScrolled: false",
"rememberDetailView(detailsNode, true)",
'detailsNode.dataset.detailScrollRestoring === "true"',
"現在の工程:",
"ChatGPTとの残り往復:",
"実装方針: <strong>第",
"まだ実装方針の切り替えはありません。",
"Ubuntuの正規ワークスペースに未完了の変更が残っているため",
'class="chat-row chat-row-user"',
'class="chat-row chat-row-assistant"',
'class="chat-bubble"',
"実行・変更の詳細",
"function extractRequesterMessage(value)",
"function extractAssistantMessage(value)",
"Array.isArray(turn.commandResults)",
"Array.isArray(turn.checkResults)",
"chat-avatar",
"依頼者 ↔ ChatGPT",
'data-conversation-style="slack"',
"Slack風のスレッドで会話を表示",
'class="conversation-details"',
'role="log" aria-label="ChatGPTとの会話"',
'[data-conversation-style="slack"] .chat-row-user',
'[data-conversation-style="slack"] .chat-row-assistant{justify-content:flex-start',
'[data-conversation-style="slack"] .chat-row-user{background:#faf5ff;border-left:4px solid #7c3aed}',
'[data-conversation-style="slack"] .chat-row-assistant{background:#eff6ff;border-left:4px solid #1264a3}',
'[data-conversation-style="slack"] .chat-row-user:hover{background:#f3e8ff}',
'[data-conversation-style="slack"] .chat-row-assistant:hover{background:#dbeafe}',
'[data-conversation-style="slack"] .chat-row-user .chat-speaker{color:#581c87}',
'[data-conversation-style="slack"] .chat-row-assistant .chat-speaker{color:#0c4a6e}',
'[data-conversation-style="slack"] .chat-row-user .chat-bubble::after',
'[data-conversation-style="slack"] .chat-row-assistant .chat-bubble::before{content:none}',
'[data-conversation-style="slack"] .chat-thread{',
"background:#fff",
"background-image:none",
'[data-conversation-style="slack"] .chat-avatar{',
"border-radius:8px",
"background:transparent;box-shadow:none",
"minmax(440px,1.1fr)",
".chat-row-user{justify-content:flex-end}",
".chat-row-assistant{justify-content:flex-start}",
".chat-row-user .chat-avatar{background:#06c755",
"border-radius:50%;background:#fff",
".chat-row-user .chat-bubble{background:#91e85f",
'.chat-row-user .chat-bubble::after{content:"";position:absolute;top:0;right:-7px',
'.chat-row-assistant .chat-bubble::before{content:"";position:absolute;top:0;left:-7px',
".stage-failed{background:#dc2626;color:#fff;border:1px solid #991b1b;box-shadow:0 0 0 2px #fee2e2;font-weight:850}",
".chat-thread{padding:16px 13px 22px;background-color:#b7cbe0;background-image:linear-gradient",
];

for (const fragment of requiredFragments) {
assert.ok(
source.includes(fragment),
"Missing expected source fragment: " + fragment
);
}

assert.ok(!source.includes("LINE風の左右吹き出しで会話を表示"));

console.log("JOB_DETAIL_UX_OK");
