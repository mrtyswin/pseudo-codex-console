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
assert.match(source, /function findUsageLimitText\(candidates\)/);
assert.match(source, /!node\.closest\('\[data-turn\], \[data-message-author-role\]'\)/);
assert.doesNotMatch(source, /document\.body\?\.innerText/);
assert.match(source, /waitUntil: 'domcontentloaded'/);
assert.match(source, /waitForSelector\('#prompt-textarea', \{ timeout: 20_000 \}\)/);
assert.match(source, /async function reloadForRecovery\(page, log\)/);
assert.match(source, /Recovery reload did not settle: .*checking the composer/);
assert.match(source, /await interact\(\(\) => reloadForRecovery\(page, log\)\)/);
assert.match(source, /function responseAppearedAfterReload\(beforeState, afterState\)/);
assert.match(source, /if \(afterState\.userCount <= beforeState\.userCount\) return false/);
const recoveryReloadSource = source.slice(
  source.indexOf("async function reloadForRecovery"),
  source.indexOf("async function waitWithRecovery")
);
assert.match(recoveryReloadSource, /catch \(error\)/);
assert.match(recoveryReloadSource, /await page\.waitForSelector\('#prompt-textarea'/);
const navigationSource = source.slice(
  source.indexOf("async function navigateWithRetry"),
  source.indexOf("function conversationDetails")
);
assert.doesNotMatch(navigationSource, /waitUntil: 'networkidle2'/);

const responseDetectionSource = source.slice(
  source.indexOf("function responseAppearedAfterReload"),
  source.indexOf("async function waitForStreamingDone")
);
const responseAppearedAfterReload = new Function(
  `${responseDetectionSource}\nreturn responseAppearedAfterReload;`
)();
assert.equal(responseAppearedAfterReload(
  { count: 1, lastText: "original", userCount: 1 },
  { count: 1, lastText: "reformatted original", userCount: 1 }
), false, "reformatted old answers must not be mistaken for a new response");
assert.equal(responseAppearedAfterReload(
  { count: 1, lastText: "original", userCount: 1 },
  { count: 2, lastText: "new response", userCount: 2 }
), true, "a persisted user turn followed by a new assistant turn is a response");
assert.equal(responseAppearedAfterReload(
  { count: 1, lastText: "original", userCount: 1 },
  { count: 2, lastText: "", userCount: 2 }
), false, "an empty assistant placeholder must trigger a resend after reload");

const usageDetectionSource = source.slice(
  source.indexOf("function findUsageLimitText"),
  source.indexOf("async function throwIfUsageLimited")
);
const usageDetection = new Function(
  `${usageDetectionSource}\nreturn { findUsageLimitText, detectUsageLimit };`
)();
assert.match(
  usageDetection.findUsageLimitText(["You have reached the usage limit. Try again later."]),
  /usage limit/i
);
assert.equal(
  usageDetection.findUsageLimitText(["Ordinary conversation without a system notice."]),
  ""
);
(async () => {
  const fromConversationOnly = await usageDetection.detectUsageLimit({
    evaluate: async () => [],
  });
  assert.equal(fromConversationOnly, "", "conversation history is not a usage-limit signal");
})();

const loadRecoveryReload = new Function(
  "setTimeout",
  `${recoveryReloadSource}\nreturn reloadForRecovery;`
);
const immediateTimeout = callback => {
  callback();
  return 0;
};

(async () => {
  const reloadForRecovery = loadRecoveryReload(immediateTimeout);
  const events = [];
  await reloadForRecovery({
    reload: async () => {
      events.push("reload");
      throw new Error("Navigation timeout of 30000 ms exceeded");
    },
    waitForSelector: async selector => {
      events.push(`composer:${selector}`);
      return {};
    },
  }, message => events.push(message));
  assert.deepEqual(events.slice(0, 2), [
    "reload",
    "Recovery reload did not settle: Navigation timeout of 30000 ms exceeded; checking the composer.",
  ]);
  assert.equal(events[2], "composer:#prompt-textarea");

  await assert.rejects(
    () => reloadForRecovery({
      reload: async () => { throw new Error("reload failed"); },
      waitForSelector: async () => { throw new Error("composer missing"); },
    }, () => {}),
    /Recovery reload failed and the ChatGPT composer did not return: reload failed/
  );

  console.log("CHATGPT_NEW_CHAT_ROUTE_OK");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
