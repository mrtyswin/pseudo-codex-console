"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const agentPath = process.env.AGENT_PATH ||
  path.join(__dirname, "..", "agent", "agent.js");
assert.ok(fs.existsSync(agentPath), "agent.js was not found: " + agentPath);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-no-sha-check-"));
const workspace = path.join(root, "workspace");
const stateFile = path.join(root, "state.json");
const fakeChatGpt = path.join(root, "fake-chatgpt.js");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "sample.js"), "alpha\nbeta\n");

fs.writeFileSync(fakeChatGpt, `
"use strict";
const fs = require("node:fs");
const statePath = process.env.FAKE_STATE_FILE;
let calls = 0;
try { calls = JSON.parse(fs.readFileSync(statePath, "utf8")).calls; } catch (_error) {}
calls += 1;
fs.writeFileSync(statePath, JSON.stringify({ calls }));
if (calls === 1) {
  process.stdout.write("===EDIT: sample.js===\\n===OLD===\\nalpha\\n===NEW===\\nfirst\\n===ENDEDIT===");
} else if (calls === 2) {
  process.stdout.write("===PATCH===\\n--- a/sample.js\\n+++ b/sample.js\\n@@ -1,2 +1,2 @@\\n first\\n-beta\\n+second\\n===ENDPATCH===");
} else if (calls === 3) {
  process.stdout.write("===FILE: sample.js===\\nconst finalValue = true;\\n===ENDFILE===");
} else if (calls === 4) {
  process.stdout.write("===RUN: test -f sample.js && grep -q 'finalValue = true' sample.js===");
} else {
  process.stdout.write("No-SHA editing verified.\\n===TASK_COMPLETE===");
}
`, { mode: 0o700 });

try {
  const result = childProcess.spawnSync(
    process.execPath,
    [agentPath, "--auto", "--cwd", workspace, "no SHA editing check"],
    {
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        PSEUDO_CODEX_CHATGPT_SCRIPT: fakeChatGpt,
        PSEUDO_CODEX_MAX_TURNS: "10",
        FAKE_STATE_FILE: stateFile
      }
    }
  );
  const output = (result.stdout || "") + (result.stderr || "");
  assert.equal(result.status, 0, output);
  assert.equal(
    fs.readFileSync(path.join(workspace, "sample.js"), "utf8"),
    "const finalValue = true;\n"
  );
  assert.match(output, /Exact edit applied/);
  assert.match(output, /Patch applied/);
  assert.match(output, /Replaced: sample\.js/);
  assert.match(output, /===TASK_COMPLETE===/);
  assert.doesNotMatch(output, /PATCH_PRECONDITION/);
  assert.doesNotMatch(output, /\b[a-f0-9]{64}\b/i);
  console.log("AGENT_NO_SHA_PROTOCOL_OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
