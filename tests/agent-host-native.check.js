"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const agent = require("../agent/agent");

const prompt = agent.buildInitialPrompt("ssh今とじてるん？", [], "/home/ubuntu/chatgpt-projects/request-console", true);
assert.match(prompt, /Ubuntu host directly/);
assert.match(prompt, /concise user-facing conclusion/);
assert.doesNotMatch(prompt, /sandboxed/);
assert.equal(agent.isHostOnlyCommand("systemctl status ssh", {
  hostNative: true,
  hostWorkspace: "/home/ubuntu/chatgpt-projects/request-console",
  hostProductionRoot: "/opt/pseudo-codex-console",
  hostDeployCommand: "/usr/local/libexec/pseudo-codex-deploy-request-console",
}), false);
assert.equal(agent.cleanFinalAnswer("===TASK_COMPLETE==="), "");
assert.equal(agent.cleanFinalAnswer("SSHは起動しています。
===TASK_COMPLETE==="), "SSHは起動しています。");

const source = fs.readFileSync(path.join(__dirname, "..", "agent", "agent.js"), "utf8");
assert.doesNotMatch(source, /HOST_ONLY_COMMAND_DEFERRED: the sandbox/);
console.log("AGENT_HOST_NATIVE_EXECUTION_OK");
