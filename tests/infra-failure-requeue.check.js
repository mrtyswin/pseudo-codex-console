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
instruction: "infra failure requeue regression test",
kind: "job"
});
}

function claim() {
return postJson("/api/jobs/claim", {
workerId: "infra-check-worker",
sessionId: crypto.randomUUID(),
leaseSeconds: 120,
excludedProjects: []
});
}

function postResult(id, extra) {
return postJson("/api/jobs/" + id + "/result", Object.assign({
status: "queued",
lastError: "",
workerLog: "",
finalAnswer: "",
executionResult: "",
verificationResult: ""
}, extra));
}

async function runChecks() {
const token = crypto.randomUUID();

// 1. An infra failure refunds the strategy attempt and counts infraRetries.
const job = await createJob("Infra requeue " + token);
const claimed = await claim();
assert.equal(claimed.id, job.id);
assert.equal(claimed.attempts, 1);
const requeued = await postResult(job.id, {
lastError: "ChatGPT browser request failed: [ERROR] spawnSync node ETIMEDOUT",
infraFailure: true
});
assert.equal(requeued.stage, "queued");
assert.equal(requeued.attempts, 0, "infra failure must not consume an attempt");
assert.equal(requeued.infraRetries, 1, "infra failure must count separately");

// 2. Repeated infra failures keep refunding attempts.
await claim();
const requeuedAgain = await postResult(job.id, {
lastError: "ChatGPT browser request failed: [ERROR] spawnSync node ETIMEDOUT",
infraFailure: true
});
assert.equal(requeuedAgain.attempts, 0);
assert.equal(requeuedAgain.infraRetries, 2);

// 3. A plain (strategy) requeue still consumes the attempt.
await claim();
const strategyRequeue = await postResult(job.id, {
lastError: "Agent exited 1."
});
assert.equal(strategyRequeue.attempts, 1);
assert.equal(strategyRequeue.infraRetries, 2);

// 4. Completion clears the infra counter.
await claim();
const done = await postResult(job.id, {
status: "done",
finalAnswer: "done"
});
assert.equal(done.stage, "completed");
assert.equal(done.infraRetries, 0);

// 5. A manual rerun resets both counters so the job gets a real fresh start.
const failed = await createJob("Manual rerun reset " + token);
await claim();
const failedResult = await postResult(failed.id, {
status: "needs_human",
lastError: "Agent exited 1."
});
assert.equal(failedResult.stage, "failed");
assert.equal(failedResult.attempts >= 1, true);
const resumed = await postJson("/api/jobs/" + failed.id + "/resume", {});
assert.equal(resumed.stage, "queued");
assert.equal(resumed.attempts, 0, "manual rerun must reset attempts");
assert.equal(resumed.infraRetries, 0, "manual rerun must reset infraRetries");

console.log("INFRA_FAILURE_REQUEUE_OK");
}

async function main() {
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-infra-check-"));
const dataPath = path.join(temporaryRoot, "jobs.json");
const port = 20000 + crypto.randomInt(20000);
baseUrl = "http://127.0.0.1:" + port;
const appPath = process.env.APP_PATH || path.join(__dirname, "..", "app.js");
const child = childProcess.spawn(process.execPath, [appPath], {
env: Object.assign({}, process.env, {
PORT: String(port),
DATA_PATH: dataPath,
PSEUDO_CODEX_AUTO_HANDOFF_MAX: "0"
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
