#!/usr/bin/env node
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
const response = await fetchWithRetry(urlPath, options || { method: "GET" });
const body = await response.text();
if (!response.ok) {
throw new Error(((options || {}).method || "GET") + " " + urlPath + " failed: " + response.status + " " + body);
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

function createJob(title) {
return postJson("/jobs", {
project: "request-console",
title,
instruction: "isolated preflight regression test",
kind: "job"
});
}

function claim() {
return postJson("/api/jobs/claim", {
workerId: "preflight-check-worker",
sessionId: crypto.randomUUID(),
leaseSeconds: 120,
excludedProjects: []
});
}

function failJob(id, extra) {
return postJson("/api/jobs/" + id + "/result", Object.assign({
status: "needs_human",
lastError: "",
workerLog: "",
finalAnswer: "",
executionResult: "",
verificationResult: ""
}, extra));
}

async function continuationsOf(id) {
const payload = await requestJson("/api/jobs");
const jobs = Array.isArray(payload) ? payload : payload.jobs;
return jobs.filter(function(job) {
return job.parentJobId === id;
});
}

async function recover(id, instruction) {
return postJson("/api/jobs/" + id + "/recover", { instruction });
}

async function runChecks() {
const token = crypto.randomUUID();

// 1. An explicitly flagged preflight failure must not spawn a continuation.
const flagged = await createJob("Preflight flagged " + token);
await claim();
const flaggedFailed = await failJob(flagged.id, {
lastError: "UBUNTU_WORKSPACE_DIRTY",
preflight: true
});
assert.equal(flaggedFailed.stage, "failed");
assert.equal((await continuationsOf(flagged.id)).length, 0,
"preflight-flagged failure must not create a continuation job");
assert.match(flaggedFailed.autoHandoffStatus, /自動継続なし/);

// 2. A preflight signature in lastError must be caught even without the flag.
const signature = await createJob("Preflight signature " + token);
await claim();
await failJob(signature.id, {
lastError: "Cannot start: UBUNTU_WORKSPACE_NOT_ON_MAIN"
});
assert.equal((await continuationsOf(signature.id)).length, 0,
"preflight signature failure must not create a continuation job");

// 3. A model usage limit failure must not spawn continuations: they would
// all hit the same exhausted limit.
const usageLimit = await createJob("Usage limit " + token);
await claim();
const usageLimitFailed = await failJob(usageLimit.id, {
lastError: "Model usage limit detected. Automatic retry is disabled."
});
assert.equal(usageLimitFailed.stage, "failed");
assert.equal((await continuationsOf(usageLimit.id)).length, 0,
"usage limit failure must not create a continuation job");
assert.match(usageLimitFailed.autoHandoffStatus, /自動継続なし/);

// 4. Deployment configuration failures cannot be repaired by rerunning the
// implementation in a new conversation.
const deploymentConfig = await createJob("Deployment config " + token);
await claim();
const deploymentConfigFailed = await failJob(deploymentConfig.id, {
lastError: "GIT_PUBLISH_NOT_CONFIGURED"
});
assert.equal(deploymentConfigFailed.stage, "failed");
assert.equal((await continuationsOf(deploymentConfig.id)).length, 0,
"deployment configuration failure must not create a continuation job");
assert.match(deploymentConfigFailed.autoHandoffStatus, /自動継続なし/);

// 5. A message-cap wait must release the worker, preserve the retry budget,
// and remain unclaimable until its scheduled retry time.
const delayed = await createJob("Deferred message limit " + token);
const delayedClaim = await claim();
assert.equal(delayedClaim.id, delayed.id);
assert.ok(delayedClaim.executionStartedAt, "the first claim must start the overall job clock");
const ready = await createJob("Ready behind deferred " + token);
const futureRetryAt = new Date(Date.now() + 60_000).toISOString();
const deferred = await failJob(delayed.id, {
status: "deferred",
lastError: "ChatGPT message limit wait scheduled.",
retryAt: futureRetryAt,
messageLimitWaits: 1
});
assert.equal(deferred.stage, "queued");
assert.equal(deferred.attempts, 0, "capacity waits must not consume real retry attempts");
assert.equal(deferred.retryAt, futureRetryAt);
assert.equal(deferred.messageLimitWaits, 1);
const summary = await requestJson("/api/jobs?view=summary");
const summaryDeferred = summary.jobs.find(function(job) { return job.id === delayed.id; });
assert.equal(summaryDeferred.retryAt, futureRetryAt,
"the list summary must expose the scheduled message-cap retry time");
assert.equal(summaryDeferred.messageLimitWaits, 1,
"the list summary must expose the scheduled message-cap wait count");
const readyClaim = await claim();
assert.equal(readyClaim.id, ready.id, "a future deferred job must not block the next ready job");

const pastRetryAt = new Date(Date.now() - 1_000).toISOString();
await failJob(delayed.id, {
status: "deferred",
lastError: "Retry window opened.",
retryAt: pastRetryAt,
messageLimitWaits: 2
});
const resumedClaim = await claim();
assert.equal(resumedClaim.id, delayed.id, "the deferred job must become claimable after retryAt");
assert.equal(resumedClaim.retryAt, "", "claiming clears the scheduled wait timestamp");
assert.equal(resumedClaim.messageLimitWaits, 2);
assert.equal(resumedClaim.executionStartedAt, delayedClaim.executionStartedAt,
"a deferred retry must retain the original overall job clock");

// 6. Exhausting the message-cap wait budget is an account-capacity problem,
// not an alternative implementation opportunity, so it must not fan out.
const exhausted = await createJob("Message limit exhausted " + token);
const exhaustedClaim = await claim();
assert.equal(exhaustedClaim.id, exhausted.id);
const exhaustedFailed = await failJob(exhausted.id, {
lastError: "ChatGPT message limit persisted after 4 deferred waits.",
workerLog: "message_limit_wait_exhausted"
});
assert.equal(exhaustedFailed.stage, "failed");
assert.equal((await continuationsOf(exhausted.id)).length, 0,
"exhausted message-cap waits must not create a fresh continuation budget");
assert.match(exhaustedFailed.autoHandoffStatus, /自動継続なし/);

// 7. A normal implementation failure must still create exactly one continuation.
const normal = await createJob("Normal failure " + token);
await claim();
const normalFailed = await failJob(normal.id, {
lastError: "No acceptance progress for 6 consecutive turns."
});
assert.equal(normalFailed.stage, "failed");
const continuations = await continuationsOf(normal.id);
assert.equal(continuations.length, 1,
"a normal failure must still create one continuation job");
assert.match(continuations[0].title, /別の手で継続 1/);

// 8. The GUI deliberately offers follow-up work for completed jobs.  The API
// must accept that same terminal state and preserve the user's new request.
const completed = await createJob("Completed follow-up " + token);
await claim();
const completedResult = await postJson("/api/jobs/" + completed.id + "/result", {
status: "done",
lastError: "",
workerLog: "",
finalAnswer: "completed result",
executionResult: "",
verificationResult: ""
});
assert.equal(completedResult.stage, "completed");
const completedContinuation = await recover(completed.id, "結果を確認したので、表示文言だけ直して再検証して。");
assert.equal(completedContinuation.parentJobId, completed.id);
assert.match(completedContinuation.instruction, /表示文言だけ直して再検証して/);
assert.equal(completedContinuation.forceNewConversation, true);

console.log("PREFLIGHT_NO_CONTINUATION_OK");
}

async function main() {
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-preflight-check-"));
const dataPath = path.join(temporaryRoot, "jobs.json");
const port = 20000 + crypto.randomInt(20000);
baseUrl = "http://127.0.0.1:" + port;
const appPath = process.env.APP_PATH || path.join(__dirname, "..", "app.js");
const child = childProcess.spawn(process.execPath, [appPath], {
env: Object.assign({}, process.env, {
PORT: String(port),
DATA_PATH: dataPath,
PSEUDO_CODEX_AUTO_HANDOFF_MAX: "3"
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
