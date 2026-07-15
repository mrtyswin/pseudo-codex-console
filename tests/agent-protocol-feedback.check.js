#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const agent = require(path.join(__dirname, "..", "agent", "agent.js"));

// The exact malformed shapes observed in the failed production job: bare
// keywords and apply-patch format must trigger the exact-syntax correction.
assert.match(
  agent.protocolFormatHint("PATCH\n*** Begin Patch\n*** Update File: app.js\n*** End Patch"),
  /PROTOCOL_FORMAT_ERROR/
);
assert.match(
  agent.protocolFormatHint("RUN\ncd /tmp && ls\nnl -ba app.js"),
  /===RUN===/
);
assert.match(
  agent.protocolFormatHint("RUN: cd /tmp && ls"),
  /PROTOCOL_FORMAT_ERROR/
);
assert.match(
  agent.protocolFormatHint("--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-x\n+y"),
  /===PATCH===/
);

// Prose without any action intent must not trigger the correction.
assert.equal(agent.protocolFormatHint("I inspected the file and it looks fine."), "");
assert.equal(agent.protocolFormatHint(""), "");
// A mid-sentence mention of the keywords must not trigger either.
assert.equal(agent.protocolFormatHint("The previous RUN command succeeded."), "");

// Well-formed blocks are parsed elsewhere; the single-line plain RUN form is
// executed by parseRunBlocks, so the hint never sees it in the main loop.
assert.deepEqual(agent.parseRunBlocks("RUN\nls -la"), ["ls -la"]);
assert.deepEqual(agent.parseRunBlocks("===RUN===\nls -la\n===ENDRUN==="), ["ls -la"]);

console.log("AGENT_PROTOCOL_FEEDBACK_OK");
