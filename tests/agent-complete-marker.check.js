#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const agentPath = path.join(__dirname, "..", "agent", "agent.js");
const { hasCompletionMarker } = require(agentPath);

// Unit: the marker only counts on its own line. The mid-sentence case is the
// exact refusal observed on job 8f0a2204, which was wrongly marked done.
assert.equal(
  hasCompletionMarker("成功確認なしに ===TASK_COMPLETE=== を出力できません。"),
  false,
  "a quoted marker inside a refusal must not complete the job"
);
assert.equal(
  hasCompletionMarker("When verified, output ===TASK_COMPLETE=== on its own line."),
  false
);
assert.equal(hasCompletionMarker("done.\n===TASK_COMPLETE===\n"), true);
assert.equal(hasCompletionMarker("done.\r\n===TASK_COMPLETE===  \r\n"), true);
assert.equal(hasCompletionMarker(""), false);

// Behavioral: a refusal quoting the marker must not end the run; the agent
// must keep prompting until a real own-line completion arrives.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-marker-"));
const workspace = path.join(root, "workspace");
const fakeChatGpt = path.join(root, "fake-chatgpt.js");
const stateFile = path.join(root, "state.json");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "app.js"), "module.exports = 'x';\n");

fs.writeFileSync(fakeChatGpt, `
"use strict";
const fs = require("node:fs");
const statePath = process.env.FAKE_STATE_FILE;
let calls = 0;
try { calls = JSON.parse(fs.readFileSync(statePath, "utf8")).calls; } catch (_error) {}
calls += 1;
fs.writeFileSync(statePath, JSON.stringify({ calls }));
if (calls === 1) {
  process.stdout.write("実行できないため、成功確認なしに ===TASK_COMPLETE=== を出力できません。");
} else if (calls === 2) {
  process.stdout.write("===RUN: node --check app.js===");
} else {
  process.stdout.write("Verified fine.\\n===TASK_COMPLETE===");
}
`, { mode: 0o700 });

try {
  const result = childProcess.spawnSync(
    process.execPath,
    [agentPath, "--auto", "--cwd", workspace, "completion marker check"],
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
  const calls = JSON.parse(fs.readFileSync(stateFile, "utf8")).calls;
  assert.ok(calls >= 3, `agent must keep going past the quoted-marker refusal (calls=${calls})`);
  // The user-facing conclusion must be handed to the dispatcher so question
  // jobs show their answer in the job result instead of only in the chat log.
  assert.match(output, /===AGENT_FINAL===.*Verified fine/);
  console.log("AGENT_COMPLETE_MARKER_OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
