"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "agent", "chatgpt.js"), "utf8");

assert.match(source, /const DEFAULT_CHATGPT_PROJECT_URL =/);
assert.match(source, /process\.env\.CHATGPT_PROJECT_URL/);
assert.match(source, /function newChatUrl\(\)/);
assert.match(source, /return CHATGPT_PROJECT_URL \|\| CHATGPT_URL;/);
assert.match(source, /async function enterConfiguredProjectChat\(page, log\)/);
assert.match(source, /CHATGPT_PROJECT_CHAT_BUTTON_UNAVAILABLE/);
assert.match(source, /label === 'Chat' \|\| label === 'チャット'/);
assert.match(source, /await navigateWithRetry\(/);
assert.match(source, /if \(!browserClient\)/);
assert.match(source, /if \(!browserClient\)[\s\S]*await enterConfiguredProjectChat\(page, log\)/);
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
const hardLimit = usageDetection.findUsageLimitText([
  "You have reached the usage limit. It resets at 5:00 PM.",
]);
assert.equal(hardLimit.kind, "limit", "an exhausted account limit is terminal");
assert.match(hardLimit.text, /usage limit/i);
const throttle = usageDetection.findUsageLimitText([
  "Too many requests You’re making requests too quickly. We’ve temporarily limited access to your conversations to protect your data. Please wait a few minutes before trying again. Got it",
]);
assert.equal(throttle.kind, "throttle", "a transient request throttle must be retryable, not terminal");
assert.equal(
  usageDetection.findUsageLimitText(["Ordinary conversation without a system notice."]),
  null
);
(async () => {
  const fromConversationOnly = await usageDetection.detectUsageLimit({
    evaluate: async () => [],
  });
  assert.equal(fromConversationOnly, null, "conversation history is not a usage-limit signal");
})();

// A throttle dialog keeps the send button disabled; the submit path must
// check the throttle (and honor the shared backoff) instead of failing as
// CHATGPT_SEND_BUTTON_UNAVAILABLE, and navigation must honor it too.
const submitSource = source.slice(
  source.indexOf("async function submitPrompt"),
  source.indexOf("async function pageIsStreaming")
);
assert.match(submitSource, /respectThrottleBackoff\(log\)/);
assert.match(submitSource, /throwIfUsageLimited\(page, log\)/);
const navigateStart = source.indexOf("async function navigateWithRetry");
assert.ok(navigateStart >= 0, "navigateWithRetry must exist");
const navigateSource = source.slice(navigateStart, navigateStart + 2000);
assert.match(source, /let throttleBackoffUntil = 0;/);
assert.match(navigateSource, /respectThrottleBackoff\(log\)/);

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
