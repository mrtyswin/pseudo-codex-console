"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let baseUrl = "";

function delay(milliseconds) {
return new Promise(function(resolve) {
setTimeout(resolve, milliseconds);
});
}

async function fetchWithRetry(urlPath, options) {
let lastError;
for (let attempt = 0; attempt < 50; attempt += 1) {
try {
return await fetch(baseUrl + urlPath, options);
} catch (error) {
lastError = error;
await delay(100);
}
}
throw lastError;
}

async function requestJson(urlPath, options) {
const response = await fetchWithRetry(urlPath, options);
if (response.status === 204) {
return { statusCode: 204 };
}
const body = await response.text();
if (!response.ok) {
throw new Error((options.method || "GET") + " " + urlPath + " failed: " + response.status + " " + body);
}
return JSON.parse(body);
}

function postJson(urlPath, value) {
return requestJson(urlPath, {
method: "POST",
headers: { Accept: "application/json", "Content-Type": "application/json" },
body: JSON.stringify(value)
});
}

function extractJobCard(page, jobId) {
const marker = 'class="job" data-job-id="' + jobId + '"';
const start = page.indexOf(marker);
assert.notEqual(start, -1, "job card must exist");
const end = page.indexOf("</article>", start);
assert.notEqual(end, -1, "job card must end");
return page.slice(start, end + "</article>".length);
}

function countBadges(card) {
return (card.match(/class="badge /g) || []).length;
}

async function createJob(title, kind) {
return postJson("/jobs", {
project: "request-console",
title,
instruction: "isolated regression test",
kind: kind || "job"
});
}

async function claim(excludedProjects) {
return postJson("/api/jobs/claim", {
workerId: "check-worker",
sessionId: crypto.randomUUID(),
leaseSeconds: 120,
excludedProjects: excludedProjects || []
});
}

async function runChecks() {
const health = await requestJson("/health", { method: "GET" });
assert.equal(health.status, "ok");
assert.equal(health.queueMode, "dispatcher");

const token = crypto.randomUUID();
const testOnly = await createJob("Test-only " + token, "test");
assert.equal(testOnly.isTest, true);

const autoTitled = await postJson("/jobs", {
project: "request-console",
instruction: "\n  ## Auto title   " + token + "  \nsecond line",
kind: "test"
});
assert.equal(autoTitled.title, "Auto title " + token);
assert.equal(autoTitled.instruction, "## Auto title   " + token + "  \nsecond line");
assert.equal(autoTitled.isTest, true);

const completedCreated = await createJob("Completed display test " + token);
const completedClaimed = await claim();
assert.equal(completedClaimed.id, completedCreated.id, "test jobs must not be claimed");
assert.equal(completedClaimed.stage, "sending_to_chatgpt");
assert.equal(completedClaimed.workerId, "check-worker");
assert.ok(completedClaimed.leaseExpiresAt);

const verifying = await postJson("/api/jobs/" + completedCreated.id + "/progress", {
stage: "verifying",
message: "結果を検証 turn=3",
currentCommand: "node --check app.js",
chatConversationId: "conversation-check",
chatConversationUrl: "https://chatgpt.com/g/g-test/project/c/conversation-check",
workerSessionId: completedCreated.id
});
assert.equal(verifying.assignee, "Ubuntu");
assert.equal(verifying.currentTurn, 3);
assert.equal(verifying.currentCommand, "node --check app.js");
assert.equal(verifying.chatConversationId, "conversation-check");
assert.equal(verifying.workerSessionId, completedCreated.id);

const firstTurn = await postJson(
"/api/jobs/" + completedCreated.id + "/turn",
{
turn: 1,
sentAt: "2026-07-11T16:50:20.000Z",
responseReceivedAt: "2026-07-11T16:50:21.000Z",
prompt: "Task: isolated regression test",
response: "===RUN: node --check app.js===",
runCommands: ["node --check app.js"],
fileChanges: [],
commandResults: [],
checkResults: []
}
);
assert.equal(firstTurn.conversationTurns.length, 1);
assert.equal(
firstTurn.conversationTurns[0].prompt,
"Task: isolated regression test"
);

const updatedTurn = await postJson(
"/api/jobs/" + completedCreated.id + "/turn",
{
turn: 1,
sentAt: "2026-07-11T16:50:20.000Z",
responseReceivedAt: "2026-07-11T16:50:21.000Z",
prompt: "Task: isolated regression test",
response: "===RUN: node --check app.js===",
runCommands: ["node --check app.js"],
fileChanges: [],
commandResults: [
{
command: "node --check app.js",
exitStatus: 0,
timedOut: false,
rejected: false,
output: "(no output)"
}
],
checkResults: []
}
);
assert.equal(updatedTurn.conversationTurns.length, 1);
assert.equal(
updatedTurn.conversationTurns[0].commandResults[0].command,
"node --check app.js"
);

const completed = await postJson("/api/jobs/" + completedCreated.id + "/result", {
status: "done",
lastError: "",
workerLog: "DISPLAY_TEST_WORKER_LOG",
finalAnswer: "最終回答テスト",
executionResult: "実行結果テスト",
verificationResult: "検証結果テスト"
});
assert.equal(completed.stage, "completed");
assert.equal(completed.assignee, "完了");

const failedCreated = await createJob("Failed display test " + token);
assert.equal((await claim()).id, failedCreated.id);
const failed = await postJson("/api/jobs/" + failedCreated.id + "/result", {
status: "failed",
lastError: "DISPLAY_TEST_FAILURE",
workerLog: "",
finalAnswer: "",
executionResult: "",
verificationResult: ""
});
assert.equal(failed.stage, "failed");
assert.equal(failed.assignee, "失敗");
assert.ok(failed.continuationJobId, "failed job must create one continuation");
const continuation = await requestJson("/api/jobs/" + failed.continuationJobId, { method: "GET" });
assert.equal(continuation.parentJobId, failedCreated.id);
assert.equal(continuation.rootJobId, failedCreated.id);
assert.equal(continuation.autoHandoffDepth, 1);
assert.equal(continuation.forceNewConversation, true);
assert.ok(continuation.instruction.includes("# Pseudo Codex job handoff for ChatGPT"));
const duplicateFailure = await postJson("/api/jobs/" + failedCreated.id + "/result", {
status: "failed", lastError: "DISPLAY_TEST_FAILURE", workerLog: "",
finalAnswer: "", executionResult: "", verificationResult: ""
});
assert.equal(duplicateFailure.continuationJobId, failed.continuationJobId);
const manualContinuation = await postJson("/api/jobs/" + failedCreated.id + "/recover", {});
assert.equal(manualContinuation.id, failed.continuationJobId);
const claimedContinuation = await claim();
assert.equal(claimedContinuation.id, continuation.id);
const recoverActive = await fetchWithRetry("/api/jobs/" + continuation.id + "/recover", {
method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"
});
assert.equal(recoverActive.status, 409, "an active job must not create a parallel continuation");
const staleProgress = await postJson("/api/jobs/" + continuation.id + "/progress", {
stage: "writing_file",
message: "stale worker update",
workerId: "old-worker",
sessionId: "old-session",
pid: 999999,
leaseSeconds: 120
});
assert.equal(staleProgress.stage, "sending_to_chatgpt", "stale progress must not replace the active worker");
const staleResult = await postJson("/api/jobs/" + continuation.id + "/result", {
status: "needs_human",
lastError: "stale worker result",
workerLog: "",
finalAnswer: "",
executionResult: "",
verificationResult: "",
workerId: "old-worker",
sessionId: "old-session",
pid: 999999
});
assert.equal(staleResult.stage, "sending_to_chatgpt", "stale result must not finish the active worker");
const continuationFailed = await postJson("/api/jobs/" + continuation.id + "/result", {
status: "failed", lastError: "CONTINUATION_FAILURE", workerLog: "",
finalAnswer: "", executionResult: "", verificationResult: ""
});
assert.equal(continuationFailed.autoHandoffStatus, "自動再引き継ぎ上限に到達");
assert.equal(continuationFailed.continuationJobId, "");

const cascadeRoot = await createJob("Cascade stop test " + token);
assert.equal((await claim()).id, cascadeRoot.id);
const cascadeFailed = await postJson("/api/jobs/" + cascadeRoot.id + "/result", {
status: "failed", lastError: "CASCADE_FAILURE", workerLog: "",
finalAnswer: "", executionResult: "", verificationResult: ""
});
const cascadeChild = await requestJson("/api/jobs/" + cascadeFailed.continuationJobId, { method: "GET" });
assert.equal(cascadeChild.stage, "queued");
const cascadeStopped = await postJson("/api/jobs/" + cascadeRoot.id + "/stop", {
reason: "stop the full continuation chain"
});
assert.equal(cascadeStopped.stage, "stopped");
const cascadeChildStopped = await requestJson("/api/jobs/" + cascadeChild.id, { method: "GET" });
assert.equal(cascadeChildStopped.stage, "stopped", "stopping a parent must stop queued continuations");

const stoppedCreated = await createJob("Stopped display test " + token);
assert.equal((await claim()).id, stoppedCreated.id);
const stopped = await postJson("/api/jobs/" + stoppedCreated.id + "/stop", {
reason: "isolated manual stop"
});
assert.equal(stopped.stage, "stopped");
assert.equal(stopped.status, "stopped");
assert.equal(stopped.assignee, "停止");

const lateResult = await postJson("/api/jobs/" + stoppedCreated.id + "/result", {
status: "queued",
lastError: "late worker result",
workerLog: "",
finalAnswer: "",
executionResult: "",
verificationResult: ""
});
assert.equal(lateResult.stage, "stopped", "late worker result must not revive a stopped job");

const resumed = await postJson("/api/jobs/" + stoppedCreated.id + "/resume", {});
assert.equal(resumed.stage, "queued");
assert.equal((await claim()).id, stoppedCreated.id);
await postJson("/api/jobs/" + stoppedCreated.id + "/stop", { reason: "test cleanup" });

const excludedCreated = await createJob("Excluded project test " + token);
const excludedClaim = await claim(["request-console"]);
assert.equal(excludedClaim.statusCode, 204, "active project must be skipped by another worker");
await postJson("/api/jobs/" + excludedCreated.id + "/stop", { reason: "test cleanup" });

const noClaim = await claim();
assert.equal(noClaim.statusCode, 204, "test-only job must remain unclaimed");

const pageResponse = await fetchWithRetry("/", { method: "GET" });
const page = await pageResponse.text();
const clientResponse = await fetchWithRetry("/client.js", { method: "GET" });
assert.equal(clientResponse.status, 200);
const clientScript = await clientResponse.text();
assert.doesNotThrow(function() {
new Function(clientScript);
}, "rendered browser script must parse");
const completedCard = extractJobCard(page, completedCreated.id);
const failedCard = extractJobCard(page, failedCreated.id);
const stoppedCard = extractJobCard(page, stoppedCreated.id);
const continuationCard = extractJobCard(page, continuation.id);
assert.equal(countBadges(completedCard), 0);
assert.match(completedCard, /job-state stage-completed[^>]*>完了<\/span>/);
assert.equal(countBadges(failedCard), 0);
assert.match(failedCard, /job-state stage-failed[^>]*>失敗<\/span>/);
assert.equal(countBadges(stoppedCard), 0);
assert.match(stoppedCard, /job-state stage-stopped[^>]*>停止<\/span>/);
assert.ok(!failedCard.includes("data-recover-job"));
assert.ok(!failedCard.includes("継続ジョブへ"));
assert.ok(!continuationCard.includes("元ジョブへ"));
assert.ok(clientScript.includes("function renderJob(job)"));
assert.ok(clientScript.includes("['completed', 'failed', 'stopped', 'blocked'].includes(job.stage)"));
assert.ok(clientScript.includes("この結果の続きで指示"));
assert.ok(clientScript.includes("前回の結果を踏まえて、次にしてほしいことを書いてください。"));
assert.ok(clientScript.includes("JSON.stringify({ instruction: followUp })"));
assert.ok(clientScript.includes("追加指示は20,000文字以内にしてください"));
assert.ok(clientScript.includes("継続ジョブへ"));
assert.ok(clientScript.includes("元ジョブへ"));
assert.ok(page.includes('<script src="/client.js"></script>'));
assert.ok(page.includes('id="queue-summary"'));
assert.ok(page.includes('document.querySelectorAll("#jobs .job").forEach'));
assert.ok(page.includes('event.target.closest("button,a,input,select,textarea")'));
assert.ok(!page.includes('document.querySelectorAll("#jobs .job.is-selected").forEach'));
assert.ok(page.includes("function renderDetail(openOnMobile)"));
assert.ok(page.includes('panel.classList.add("is-mobile-open")'));
assert.ok(page.includes('document.body.classList.add("job-detail-open")'));
assert.ok(page.includes('closeButton.dataset.closeJobDetail = ""'));
assert.ok(page.includes("← 一覧へ戻る"));
assert.ok(page.includes("選択中のジョブ"));
assert.ok(page.includes(".detail-panel.is-mobile-open"));
assert.ok(page.includes('event.key === "Escape"'));
assert.ok(clientScript.includes("fetch('/api/jobs?view=summary'"));
assert.equal((clientScript.match(/setInterval\(refreshJobs/g) || []).length, 1);
assert.ok(clientScript.includes("setInterval(refreshJobs, 5000)"));
assert.ok(clientScript.includes("pseudo-codex:jobs-updated"));
assert.ok(page.includes("async function loadJobDetail(jobId)"));
assert.ok(page.includes('fetch("/api/jobs/" + encodeURIComponent(jobId)'));
assert.ok(!page.includes("new MutationObserver(scheduleSync)"));
assert.ok(page.includes("タイトルは指示の先頭行から自動生成します。"));
assert.ok(!page.includes('<input id="title" name="title"'));
assert.ok(clientScript.includes("textarea[name=\"instruction\"]"));
assert.ok(!clientScript.includes("input[name=\"title\"]"));
assert.ok(clientScript.includes('function updateQueueSummary'));
assert.ok(clientScript.includes("var detailStates = new Map()"));
assert.ok(clientScript.includes("button[data-job-action]"));
assert.ok(clientScript.includes("button[data-recover-job]"));
assert.ok(clientScript.includes("/recover"));
assert.ok(clientScript.includes("function scrollHistoryToBottom(detailsNode, state)"));
assert.ok(clientScript.includes("state.autoScrolling = true;"));
assert.ok(clientScript.includes("if (existing) restoreCard(existing);"));
assert.ok(clientScript.includes("event.target.closest('.history-log')"));
assert.ok(clientScript.includes("if (state.autoScrolling) return;"));
assert.ok(clientScript.includes("scrollHistoryToBottom(historyNode, state);"));
assert.ok(clientScript.includes("node.open && node.matches('details.history-details')"));
assert.ok(clientScript.includes("data-copy-handoff"));
assert.ok(clientScript.includes("ChatGPT用引き継ぎをコピー"));
assert.ok(page.includes("max-block-size:min(56dvh,32rem)"));
assert.ok(page.includes("Pseudo Codex Console v0.1.3</span> · deployed 1234567"));
assert.match(page, /作成 [0-9]{4}\/[0-9]{2}\/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} JST/);
assert.ok(clientScript.includes("登録: "));

const transcriptResponse = await fetchWithRetry(
"/api/jobs/" + completedCreated.id + "/transcript",
{ method: "GET" }
);
assert.equal(transcriptResponse.status, 200);
const transcript = JSON.parse(await transcriptResponse.text());
assert.equal(transcript.format, "pseudo-codex-job-transcript");
assert.equal(transcript.version, 2);
assert.equal(transcript.rallies.length, 1);
assert.equal(transcript.rallies[0].turn, 1);
assert.equal(
transcript.rallies[0].prompt,
"Task: isolated regression test"
);
assert.equal(
transcript.rallies[0].commandResults[0].output,
"(no output)"
);
assert.equal(
Object.hasOwn(transcript.job, "conversationTurns"),
false
);

const handoffResponse = await fetchWithRetry(
"/api/jobs/" + completedCreated.id + "/handoff",
{ method: "GET" }
);
assert.equal(handoffResponse.status, 200);
assert.match(handoffResponse.headers.get("content-type"), /text\/markdown/);
const handoff = await handoffResponse.text();
assert.ok(handoff.includes("# Pseudo Codex job handoff for ChatGPT"));
assert.ok(handoff.includes(completedCreated.id));
assert.ok(handoff.includes("## Original request"));
assert.ok(handoff.includes("最終回答テスト"));
assert.ok(handoff.includes("===RUN: node --check app.js==="));

const listed = await requestJson("/api/jobs", { method: "GET" });
assert.equal(listed.jobs.length, 9);
assert.equal(listed.jobs.find(function(job) { return job.id === testOnly.id; }).kind, "test");
const summaryResponse = await fetchWithRetry("/api/jobs?view=summary", { method: "GET" });
const summaryText = await summaryResponse.text();
const summary = JSON.parse(summaryText);
assert.equal(summary.jobs.length, listed.jobs.length);
const completedSummary = summary.jobs.find(function(job) { return job.id === completedCreated.id; });
assert.equal(completedSummary.title, completedCreated.title);
assert.equal(completedSummary.searchText, "isolated regression test");
for (const heavyField of ["history", "conversationTurns", "transactions", "workerLog", "result", "instruction"]) {
assert.equal(Object.hasOwn(completedSummary, heavyField), false, heavyField + " must not be in list summaries");
}
const fullListResponse = await fetchWithRetry("/api/jobs", { method: "GET" });
const fullListText = await fullListResponse.text();
assert.ok(summaryText.length < fullListText.length, "summary response must be smaller than the full job list");
console.log("REQUEST_CONSOLE_ISOLATED_REGRESSION_OK " + token);
}

async function main() {
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-console-check-"));
const dataPath = path.join(temporaryRoot, "jobs.json");
const deployRevisionPath = path.join(temporaryRoot, "deployed-revision");
fs.writeFileSync(deployRevisionPath, "1234567890abcdef\n", "utf8");
const port = 20000 + crypto.randomInt(20000);
baseUrl = "http://127.0.0.1:" + port;
const appPath = process.env.APP_PATH || path.join(__dirname, "app.js");
const child = childProcess.spawn(process.execPath, [appPath], {
env: Object.assign({}, process.env, {
PORT: String(port),
DATA_PATH: dataPath,
DEPLOY_REVISION_PATH: deployRevisionPath,
PSEUDO_CODEX_AUTO_HANDOFF_MAX: "1"
}),
stdio: ["ignore", "pipe", "pipe"]
});
let serviceOutput = "";
child.stdout.on("data", function(chunk) { serviceOutput += chunk; });
child.stderr.on("data", function(chunk) { serviceOutput += chunk; });
try {
await runChecks();
} catch (error) {
console.error(serviceOutput);
throw error;
} finally {
child.kill("SIGTERM");
await Promise.race([
new Promise(function(resolve) { child.once("exit", resolve); }),
delay(5000)
]);
if (child.exitCode === null) {
child.kill("SIGKILL");
}
fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
}

main().catch(function(error) {
console.error(error);
process.exit(1);
});
