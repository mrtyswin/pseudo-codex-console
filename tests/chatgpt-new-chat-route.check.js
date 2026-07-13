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
assert.match(source, /button\[data-testid="send-button"\]/);
assert.match(source, /Submitted via send button/);
assert.match(source, /CHATGPT_SEND_BUTTON_UNAVAILABLE after prompt input/);
assert.doesNotMatch(source, /keyboard\.press\(['"]Enter['"]\)/);
assert.match(source, /keyboard\.type\(text, \{ delay: 0 \}\)/);
assert.match(source, /range\.selectNodeContents\(composer\)/);
assert.match(source, /selection\.addRange\(range\)/);
assert.doesNotMatch(source, /keyboard\.press\(['"]Control\+A['"]\)/);
assert.match(source, /CHATGPT_PROMPT_INPUT_FAILED composer remained empty or incomplete/);
assert.doesNotMatch(source, /execCommand\(['"]insertText['"]/);
assert.match(source, /page\.createCDPSession\(\)/);
assert.match(source, /cdpSession\.send\(['"]Input\.insertText['"]/);
assert.match(source, /cdpSession\.detach\(\)/);
assert.match(source, /too many requests/i);
assert.match(source, /temporarily limited access/i);
assert.match(source, /wait a few minutes/i);
assert.match(source, /await throwIfUsageLimited\(page, log\)/);

console.log("CHATGPT_NEW_CHAT_ROUTE_OK");
