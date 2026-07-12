#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8090";

function extractJobCard(page, jobId) {
const marker = '<article class="job" data-job-id="' + jobId + '"';
const start = page.indexOf(marker);
assert.notEqual(start, -1, "missing card for " + jobId);
const end = page.indexOf("</article>", start);
assert.notEqual(end, -1, "unterminated card for " + jobId);
return page.slice(start, end + 10);
}

async function main() {
const healthResponse = await fetch(baseUrl + "/health", { cache: "no-store" });
assert.equal(healthResponse.ok, true);
const health = await healthResponse.json();
assert.equal(health.status, "ok");

const jobsResponse = await fetch(baseUrl + "/api/jobs", { cache: "no-store" });
assert.equal(jobsResponse.ok, true);
const payload = await jobsResponse.json();
const pageResponse = await fetch(baseUrl + "/", { cache: "no-store" });
assert.equal(pageResponse.ok, true);
const page = await pageResponse.text();
const clientResponse = await fetch(baseUrl + "/client.js", { cache: "no-store" });
assert.equal(clientResponse.ok, true);
const clientScript = await clientResponse.text();
assert.ok(page.includes("現在の担当: "));
assert.ok(page.includes("button[data-job-action]"));
assert.ok(page.includes("data-copy-handoff"));
assert.ok(page.includes("ChatGPT用引き継ぎをコピー"));
assert.ok(page.includes('id="job-search"'));
assert.ok(page.includes('id="job-status-filter"'));
assert.ok(page.includes('id="job-result-count"'));
assert.ok(clientScript.includes("function applyFilters()"));
assert.ok(clientScript.includes("setInterval(refreshJobs, 3000)"));
assert.ok(!clientScript.includes("location.reload"));

for (const job of payload.jobs) {
const card = extractJobCard(page, job.id);
const badges = (card.match(/class="badge /g) || []).length;
const expected = ["completed", "failed", "stopped", "blocked"].includes(job.stage) ? 1 : 2;
assert.equal(badges, expected, "badge count mismatch for " + job.id + " stage=" + job.stage);
}

console.log(
"LIVE_CONSOLE_OK jobs=" + payload.jobs.length +
" queued=" + health.queued +
" running=" + health.running +
" orphaned=" + health.orphaned
);
}

main().catch(function(error) {
console.error(error);
process.exit(1);
});
