#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const deploy = fs.readFileSync(
  path.resolve(__dirname, "..", "deploy", "deploy-request-console"),
  "utf8",
);

assert.match(deploy, /systemctl --user daemon-reload/);
assert.match(deploy, /systemd-run --user --quiet --collect/);
assert.match(deploy, /--on-active=2s/);
assert.doesNotMatch(deploy, /nohup bash -lc/);
assert.match(deploy, /agent_update_pending/);
assert.match(deploy, /check-browser-restart-safe\.py/);
assert.match(deploy, /browser-restart\.lock/);
assert.match(deploy, /flock 8/);

console.log("DEPLOY_DISPATCHER_RESTART_TIMER_OK");
