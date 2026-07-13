"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const agent = require("../agent/agent");

const root = path.join(__dirname, "..");
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
assert.equal(
  agent.cleanFinalAnswer("SSHは起動しています。\n===TASK_COMPLETE==="),
  "SSHは起動しています。"
);

const source = fs.readFileSync(path.join(root, "agent", "agent.js"), "utf8");
assert.doesNotMatch(source, /HOST_ONLY_COMMAND_DEFERRED: the sandbox/);

const launcher = fs.readFileSync(path.join(root, "scripts", "chatgpt-browser-agent"), "utf8");
assert.match(launcher, /run\|run-host\)[\s\S]*exec node "\$repo\/agent\.js"/);
assert.doesNotMatch(launcher, /libexec\/chatgpt-browser-agent-sandbox|\bbwrap\b|--unshare-all/);
const launcherIndex = childProcess.execFileSync(
  "git",
  ["ls-files", "--stage", "scripts/chatgpt-browser-agent"],
  { cwd: root, encoding: "utf8" }
);
assert.match(launcherIndex, /^100755 /, "launcher must be tracked as executable");
assert.equal(
  fs.existsSync(path.join(root, "scripts", "chatgpt-browser-agent-sandbox")),
  false,
  "legacy project sandbox launcher must be removed"
);
assert.match(source, /workerSessionId: process\.env\.PSEUDO_CODEX_WORKER_SESSION_ID/);
assert.match(source, /function workerIdentity\(args\)/);

console.log("AGENT_HOST_NATIVE_EXECUTION_OK");
