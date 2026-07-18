"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const agentSource = fs.readFileSync(path.join(root, "agent", "agent.js"), "utf8");
const dispatcherSource = fs.readFileSync(path.join(root, "dispatcher", "dispatcher.py"), "utf8");

// Terminal updates must have one owner. The browser agent emits facts and exits;
// the dispatcher chooses success, retry, or the one continuation path.
assert.match(agentSource, /const BLOCKED_MARKER = '===AGENT_BLOCKED===';/);
assert.match(agentSource, /const DEFERRED_MARKER = '===AGENT_DEFERRED===';/);
assert.match(agentSource, /const FATAL_MARKER = '===AGENT_FATAL===';/);
assert.doesNotMatch(agentSource, /await reportResult\(args, \{/);
assert.match(dispatcherSource, /def agent_protocol_tail\(output: str\)/);
assert.match(dispatcherSource, /def agent_marker\(output: str, marker: str\)/);
assert.match(dispatcherSource, /blocked_hint = agent_marker\(protocol_output, BLOCKED_MARKER\)/);
assert.match(dispatcherSource, /deferred_hint = agent_marker\(protocol_output, DEFERRED_MARKER\)/);
assert.match(dispatcherSource, /fatal_hint = agent_marker\(protocol_output, FATAL_MARKER\)/);
assert.match(dispatcherSource, /\^===TASK_COMPLETE===\[ \\t\]\*\$/);
assert.match(dispatcherSource, /update_result\(job_id, "needs_human", reason, detail/);
assert.match(dispatcherSource, /"deferred"/);

console.log("AGENT_TERMINAL_OWNER_OK");
