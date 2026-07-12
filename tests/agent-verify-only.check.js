"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "agent", "agent.js"), "utf8");
assert.match(source, /VERIFICATION-ONLY MODE/);
assert.match(source, /Verification-only mode refused a file mutation request/);
assert.match(source, /verification-only mode requires at least one successful verification command/);
assert.doesNotMatch(
  source.slice(source.indexOf("async function runGithubDirect"), source.indexOf("// ─── Parsers")),
  /status: 'done'/,
  "GitHub-direct agent must not mark the job done before host validation and deployment"
);
console.log("AGENT_VERIFY_ONLY_AND_HOST_OWNERSHIP_OK");
