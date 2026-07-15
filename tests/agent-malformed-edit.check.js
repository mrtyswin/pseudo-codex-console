"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const agentPath = path.join(__dirname, "..", "agent", "agent.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-malformed-edit-"));
const workspace = path.join(root, "workspace");
const fakeChatGpt = path.join(root, "fake-chatgpt.js");
const stateFile = path.join(root, "state.json");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "app.js"), "module.exports = 'before';\n");

fs.writeFileSync(fakeChatGpt, `
"use strict";
const fs = require("node:fs");
const statePath = process.env.FAKE_STATE_FILE;
let calls = 0;
try { calls = JSON.parse(fs.readFileSync(statePath, "utf8")).calls; } catch (_error) {}
calls += 1;
fs.writeFileSync(statePath, JSON.stringify({ calls }));
if (calls === 1) {
  process.stdout.write("===PATCH===\\n--- a/app.js\\n+++ b/app.js\\n@@ -1 +1 @@\\n-module.exports = 'before';\\n+module.exports = 'broken';\\n***ENDPATCH===\\n===RUN: true===");
} else if (calls === 2) {
  process.stdout.write("===FILE: app.js===\\nmodule.exports = 'after';\\n===ENDFILE===");
} else if (calls === 3) {
  process.stdout.write("===RUN: node --check app.js && grep -q after app.js===");
} else {
  process.stdout.write("Malformed edit recovery verified.\\n===TASK_COMPLETE===");
}
`, { mode: 0o700 });

try {
  const result = childProcess.spawnSync(
    process.execPath,
    [agentPath, "--auto", "--cwd", workspace, "malformed edit check"],
    {
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        PSEUDO_CODEX_CHATGPT_SCRIPT: fakeChatGpt,
        PSEUDO_CODEX_MAX_TURNS: "8",
        FAKE_STATE_FILE: stateFile,
      },
    }
  );
  const output = (result.stdout || "") + (result.stderr || "");
  assert.equal(result.status, 0, output);
  assert.match(output, /MALFORMED_STRUCTURED_EDIT_REFUSED/);
  assert.doesNotMatch(output, /^\$ true$/m, "RUN beside a malformed edit must not execute");
  assert.equal(fs.readFileSync(path.join(workspace, "app.js"), "utf8"), "module.exports = 'after';\n");
  assert.match(output, /===TASK_COMPLETE===/);
  console.log("AGENT_MALFORMED_EDIT_RECOVERY_OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
