#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8090";

function extractJobCard(page, jobId) {
const marker = 'data-job-id="' + jobId + '"';
const start = page.indexOf(marker);
assert.notEqual(start, -1, "missing card for " + jobId);
const articleStart = page.lastIndexOf("<article", start);
assert.notEqual(articleStart, -1, "missing article start for " + jobId);
const end = page.indexOf("</article>", start);
assert.notEqual(end, -1, "unterminated card for " + jobId);
return page.slice(articleStart, end + 10);
}

function countRenderedCards(page) {
return (page.match(/<article\b[^>]*\bdata-job-id="/g) || []).length;
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
assert.ok(page.includes('id="jobs"'));
assert.ok(clientScript.includes("function applyFilters()"));
assert.ok(clientScript.includes("setInterval(refreshJobs, 3000)"));
assert.ok(!clientScript.includes("location.reload"));
assert.ok(clientScript.includes('document.getElementById("jobs")') || clientScript.includes("document.getElementById('jobs')"));

const renderedCardCount = countRenderedCards(page);
if (renderedCardCount > 0) {
for (const job of payload.jobs.slice(0, renderedCardCount)) {
const card = extractJobCard(page, job.id);
const badges = (card.match(/class="badge /g) || []).length;
const expected = ["completed", "failed", "stopped", "blocked"].includes(job.stage) ? 1 : 2;
assert.equal(badges, expected, "badge count mismatch for " + job.id + " stage=" + job.stage);
}
} else {
assert.ok(
page.includes('<div id="jobs" class="jobs"></div>') ||
page.includes('<div class="jobs" id="jobs"></div>'),
"client-rendered jobs container must be present"
);
}

console.log(
"LIVE_CONSOLE_OK jobs=" + payload.jobs.length +
" queued=" + health.queued +
" running=" + health.running +
" orphaned=" + health.orphaned +
" rendered=" + renderedCardCount
);
}

main().catch(function(error) {
console.error(error);
process.exit(1);
});
