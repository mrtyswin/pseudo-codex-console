#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Regression: ChatGPT patches routinely carry wrong @@ hunk counts and lose
// the leading space of context lines in browser rendering (observed on job
// 145b50b6: every pass died with "corrupt patch"). git apply --recount plus
// normalizeUnifiedDiff must absorb both defects.

const agentPath = path.join(__dirname, "..", "agent", "agent.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-recount-"));
const workspace = path.join(root, "workspace");
const fakeChatGpt = path.join(root, "fake-chatgpt.js");
const stateFile = path.join(root, "state.json");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(
  path.join(workspace, "app.js"),
  "function first() {\n  return 1;\n}\n\nfunction second() {\n  return 2;\n}\n"
);

// The patch: wrong hunk counts (@@ -1,2 +1,2 @@ for a 7/9-line hunk) and
// context lines with their leading space stripped, exactly as the browser
// mangles them.
fs.writeFileSync(fakeChatGpt, `
"use strict";
const fs = require("node:fs");
const statePath = process.env.FAKE_STATE_FILE;
let calls = 0;
try { calls = JSON.parse(fs.readFileSync(statePath, "utf8")).calls; } catch (_error) {}
calls += 1;
fs.writeFileSync(statePath, JSON.stringify({ calls }));
if (calls === 1) {
  process.stdout.write([
    "===PATCH===",
    "--- a/app.js",
    "+++ b/app.js",
    "@@ -1,2 +1,2 @@",
    "function first() {",
    "-  return 1;",
    "+  return 100;",
    "}",
    "===ENDPATCH==="
  ].join("\\n"));
} else if (calls === 2) {
  process.stdout.write("===RUN: node --check app.js && grep -q 'return 100' app.js===");
} else {
  process.stdout.write("Recount patch verified.\\n===TASK_COMPLETE===");
}
`, { mode: 0o700 });

try {
  const result = childProcess.spawnSync(
    process.execPath,
    [agentPath, "--auto", "--cwd", workspace, "recount patch check"],
    {
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        PSEUDO_CODEX_CHATGPT_SCRIPT: fakeChatGpt,
        PSEUDO_CODEX_MAX_TURNS: "6",
        FAKE_STATE_FILE: stateFile,
      },
    }
  );
  const output = (result.stdout || "") + (result.stderr || "");
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /corrupt patch/, "recount must absorb wrong hunk counts");
  assert.match(
    fs.readFileSync(path.join(workspace, "app.js"), "utf8"),
    /return 100;/
  );
  assert.match(output, /===TASK_COMPLETE===/);
  console.log("AGENT_PATCH_RECOUNT_OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
