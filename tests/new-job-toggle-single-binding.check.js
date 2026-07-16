#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Regression: two jobs independently bound the new-job toggle in client.js
// AND in the page's inline script. Both handlers flipped `hidden` on a single
// click (net zero) and the 新規ジョブ button appeared completely dead with no
// console output. Exactly one delegated binding may exist across the page and
// the client script.

function delay(ms) {
return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function fetchText(url) {
let lastError;
for (let attempt = 0; attempt < 50; attempt += 1) {
try {
const response = await fetch(url);
return await response.text();
} catch (error) {
lastError = error;
await delay(100);
}
}
throw lastError;
}

function countToggleBindings(source) {
return (source.match(/closest\(['"]\[data-new-job-toggle\]['"]\)/g) || []).length;
}

async function main() {
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-toggle-check-"));
const port = 20000 + crypto.randomInt(20000);
const appPath = process.env.APP_PATH || path.join(__dirname, "..", "app.js");
const child = childProcess.spawn(process.execPath, [appPath], {
env: Object.assign({}, process.env, {
PORT: String(port),
DATA_PATH: path.join(temporaryRoot, "jobs.json")
}),
stdio: ["ignore", "pipe", "pipe"]
});
try {
const page = await fetchText("http://127.0.0.1:" + port + "/");
const client = await fetchText("http://127.0.0.1:" + port + "/client.js");
const pageBindings = countToggleBindings(page);
const clientBindings = countToggleBindings(client);
assert.equal(
pageBindings + clientBindings,
1,
"exactly one new-job toggle binding may exist (page=" + pageBindings + " client=" + clientBindings + ")"
);
assert.ok(page.includes("data-new-job-toggle"), "the toggle button itself must render");
console.log("NEW_JOB_TOGGLE_SINGLE_BINDING_OK page=" + pageBindings + " client=" + clientBindings);
} finally {
child.kill("SIGTERM");
await Promise.race([
new Promise(function(resolve) { child.once("exit", resolve); }),
delay(5000)
]);
fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
}

main().catch(function(error) {
console.error(error);
process.exit(1);
});
