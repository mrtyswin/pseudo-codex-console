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

// 3. A normal implementation failure must still create exactly one continuation.
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
