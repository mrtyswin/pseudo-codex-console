"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "agent", "chatgpt.js"), "utf8");

assert.match(source, /function newChatUrl\(\)/);
assert.match(source, /return CHATGPT_URL;/);
assert.doesNotMatch(source, /function projectHomeUrl\(/);
assert.doesNotMatch(source, /'\/project'/);
assert.match(source, /activeSessionFile === SESSION_FILE \? CHATGPT_URL : newChatUrl\(\)/);

console.log("CHATGPT_NEW_CHAT_ROUTE_OK");
