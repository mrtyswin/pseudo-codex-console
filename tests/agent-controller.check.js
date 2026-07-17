"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const agentPath = process.env.AGENT_PATH ||
  path.join(__dirname, "..", "agent", "agent.js");
assert.ok(fs.existsSync(agentPath), "agent.js was not found: " + agentPath);
const agentSource = fs.readFileSync(agentPath, "utf8");
assert.match(
  agentSource,
  /CHATGPT_REQUEST_TIMEOUT_MS \|\| '600000'/,
  "outer request timeout must cover the browser recovery window plus in-call throttle waits"
);
assert.match(agentSource, /PSEUDO_CODEX_MESSAGE_LIMIT_WAIT_MS \|\| '1800000'/);
assert.match(agentSource, /CHATGPT_MESSAGE_LIMIT\/m\.test\(response\)/);
assert.match(agentSource, /errorClass: 'message_limit_wait'/);

const { parseRunBlocks } = require(agentPath);
assert.deepEqual(
  parseRunBlocks("===RUN: printf ok===ENDRUN==="),
  ["printf ok"],
  "hybrid inline RUN must not leak ENDRUN into the command"
);
assert.deepEqual(
  parseRunBlocks("===RUN: printf ok==="),
  ["printf ok"],
  "ordinary inline RUN must remain supported"
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-controller-check-"));
const workspace = path.join(root, "workspace");
const sessionFile = path.join(root, "session", "chat.url");
const stateFile = path.join(root, "fake-state.json");
const fakeChatGpt = path.join(root, "fake-chatgpt.js");
fs.mkdirSync(workspace, { recursive: true });

fs.writeFileSync(fakeChatGpt, `
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_STATE_FILE;
let state = { calls: 0, newChats: 0 };
try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch (_error) {}
state.calls += 1;
const isNew = args.includes("--new");
if (isNew) state.newChats += 1;
const sessionIndex = args.indexOf("--session-file");
if (sessionIndex >= 0) {
  const file = args[sessionIndex + 1];
  fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
  fs.writeFileSync(file, "https://example.invalid/fake-" + state.newChats);
}
fs.writeFileSync(statePath, JSON.stringify(state));
if (state.newChats < 2) {
  process.stdout.write("WAIT");
} else if (state.calls === 3) {
  process.stdout.write("===FILE: recovered.js===\\nmodule.exports = 'recovered';\\n===ENDFILE===");
} else if (state.calls === 4) {
  process.stdout.write("===RUN: test -f recovered.js && grep -q 'recovered' recovered.js===");
} else {
  process.stdout.write("Recovery strategy verified.\\n===TASK_COMPLETE===");
}
`, { mode: 0o700 });

try {
  const limitWorkspace = path.join(root, "limit-workspace");
  const limitStateFile = path.join(root, "limit-state.json");
  const limitFakeChatGpt = path.join(root, "fake-message-limit.js");
  fs.mkdirSync(limitWorkspace, { recursive: true });
  fs.writeFileSync(limitFakeChatGpt, `
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_LIMIT_STATE_FILE;
let calls = 0;
try { calls = JSON.parse(fs.readFileSync(statePath, "utf8")).calls; } catch (_error) {}
calls += 1;
fs.writeFileSync(statePath, JSON.stringify({ calls, isNew: args.includes("--new") }));
if (calls === 1) {
  process.stderr.write("CHATGPT_MESSAGE_LIMIT: メッセージの上限に到達しました");
  process.exit(1);
}
process.stdout.write("Message-limit retry verified.\\n===TASK_COMPLETE===");
`, { mode: 0o700 });
  const limitResult = childProcess.spawnSync(
    process.execPath,
    [agentPath, "--auto", "--cwd", limitWorkspace, "message limit wait check"],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        PSEUDO_CODEX_CHATGPT_SCRIPT: limitFakeChatGpt,
        PSEUDO_CODEX_MESSAGE_LIMIT_WAIT_MS: "5",
        FAKE_LIMIT_STATE_FILE: limitStateFile
      }
    }
  );
  const limitOutput = (limitResult.stdout || "") + (limitResult.stderr || "");
  assert.equal(limitResult.status, 0, limitOutput);
  assert.match(limitOutput, /\[message limit\]/);
  assert.match(limitOutput, /===TASK_COMPLETE===/);
  assert.equal(JSON.parse(fs.readFileSync(limitStateFile, "utf8")).calls, 2);

  const result = childProcess.spawnSync(
    process.execPath,
    [agentPath, "--auto", "--cwd", workspace, "--session-file", sessionFile, "controller recovery check"],
    {
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        PSEUDO_CODEX_CHATGPT_SCRIPT: fakeChatGpt,
        PSEUDO_CODEX_MAX_NO_PROGRESS_TURNS: "2",
        PSEUDO_CODEX_MAX_TURNS: "12",
        FAKE_STATE_FILE: stateFile
      }
    }
  );
  const output = (result.stdout || "") + (result.stderr || "");
  assert.equal(result.status, 0, output);
  assert.match(output, /strategy reset 2/);
  assert.match(output, /===TASK_COMPLETE===/);
  assert.equal(
    fs.readFileSync(path.join(workspace, "recovered.js"), "utf8"),
    "module.exports = 'recovered';\n"
  );
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.newChats, 2);
  const history = JSON.parse(fs.readFileSync(path.join(root, "session", "chat-history.json"), "utf8"));
  assert.equal(history.length, 1);
  console.log("AGENT_CONTROLLER_RECOVERY_OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
