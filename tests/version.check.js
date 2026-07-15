#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

const currentVersion = "0.1.3";
const previousVersion = "0.1.2";

assert.strictEqual(packageJson.version, currentVersion);
assert.ok(
  app.includes(`<span>Port 8090 · v${currentVersion}</span>`),
);
assert.ok(
  app.includes(`<span>Pseudo Codex Console v${currentVersion}</span>`),
);
assert.ok(
  !app.includes(`Pseudo Codex Console v${previousVersion}`),
);
assert.ok(
  !app.includes(`Port 8090 · v${previousVersion}`),
);

console.log("CONSOLE_VERSION_OK");
