"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "agent", "chatgpt.js");
const source = fs.readFileSync(script, "utf8");
const adapter = path.join(root, "agent", "fake-browser-client.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-chatgpt-test-"));
const env = Object.assign({}, process.env, {
  HOME: home,
  PSEUDO_CODEX_BROWSER_CLIENT: adapter,
});

assert.doesNotMatch(source, /bringToFront\(/, "parallel pages must not steal browser focus");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [script, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("exit", code => {
      if (code !== 0) return reject(new Error(output));
      const match = output.match(/--- RESPONSE ---\n([\s\S]*?)\n--- END ---/);
      if (!match) return reject(new Error("response wrapper missing: " + output));
      resolve(match[1].trim());
    });
  });
}

(async () => {
  childProcess.execFileSync(process.execPath, [script, "--start"], { env, stdio: "ignore" });
  const aFile = path.join(home, "sessions", "A.url");
  const bFile = path.join(home, "sessions", "B.url");
  const started = Date.now();
  const [a1, b1] = await Promise.all([
    run(["--session-key", "A", "--session-file", aFile, "--new", "A1"]),
    run(["--session-key", "B", "--session-file", bFile, "--new", "B1"]),
  ]);
  assert.ok(Date.now() - started < 1500, "different sessions should run concurrently");
  const aConversation = a1.split(":", 1)[0];
  const bConversation = b1.split(":", 1)[0];
  assert.notEqual(aConversation, bConversation);

  const [a2, b2] = await Promise.all([
    run(["--session-key", "A", "--session-file", aFile, "A2"]),
    run(["--session-key", "B", "--session-file", bFile, "B2"]),
  ]);
  assert.ok(a2.startsWith(aConversation + ":"));
  assert.ok(b2.startsWith(bConversation + ":"));
  assert.ok(a2.includes("Task: A2"));
  assert.ok(b2.includes("Task: B2"));
  assert.ok(!a2.includes(bConversation));
  assert.ok(!b2.includes(aConversation));

  const legacy1 = await run(["--new", "legacy1"]);
  const legacyConversation = legacy1.split(":", 1)[0];
  const legacy2 = await run(["legacy2"]);
  assert.ok(legacy2.startsWith(legacyConversation + ":"));
  assert.ok(legacy2.includes("Task: legacy2"));

  await new Promise(resolve => {
    const child = childProcess.spawn(process.execPath, [script, "--stop"], { env, stdio: "ignore" });
    child.on("exit", resolve);
  });
  fs.rmSync(home, { recursive: true, force: true });
  console.log("CHATGPT_PARALLEL_SESSIONS_OK");
})().catch(error => {
  console.error(error);
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(1);
});
