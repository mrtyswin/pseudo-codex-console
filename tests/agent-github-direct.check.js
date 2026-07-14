"use strict";

const assert = require("node:assert/strict");
const agent = require("../agent/agent.js");

const sha = "a".repeat(64);
const edits = agent.parseEditBlocks([
  "===EDIT: app.js SHA256:" + sha + "===",
  "===OLD===",
  "before",
  "===NEW===",
  "after",
  "===ENDEDIT==="
].join("\n"));
assert.equal(edits.length, 1);
assert.equal(edits[0].path, "app.js");
assert.equal(edits[0].expectedSha, sha);

const patches = agent.parsePatchBlocks([
  "===PATCH SHA256:" + sha + "===",
  "--- a/app.js",
  "+++ b/app.js",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "===ENDPATCH==="
].join("\n"));
assert.equal(patches.length, 1);
assert.equal(patches[0].expectedSha, sha);

assert.match(
  agent.commandValidationError("python3 -c 'from pathlib import Path; Path(\"app.js\").write_text(\"x\")'"),
  /Refused direct file mutation/
);
assert.match(
  agent.commandValidationError("sed -i 's/a/b/' app.js"),
  /Refused direct file mutation/
);
assert.equal(
  agent.commandValidationError(
    "python3 -c 'from pathlib import Path; Path(\"app.js\").write_text(\"x\")'",
    true
  ),
  ""
);

const result = {
  repository: "mrtyswin/pseudo-codex-console",
  branch: "chatgpt-job/example",
  baseBranch: "main",
  commitSha: "b".repeat(40),
  pullRequestUrl: "https://github.com/mrtyswin/pseudo-codex-console/pull/123",
  changedFiles: ["app.js"],
  summary: "done"
};
const response = [
  "===GITHUB_COMPLETE===",
  JSON.stringify(result),
  "===END_GITHUB_COMPLETE==="
].join("\n");
assert.deepEqual(agent.parseGithubCompletion(response), result);

const prompt = agent.buildGithubDirectPrompt({
  githubRepository: result.repository,
  githubBaseBranch: result.baseBranch,
  githubBranch: result.branch,
  task: "change the UI"
});
assert.match(prompt, /Use the connected GitHub tool/);
assert.match(prompt, /Do not output RUN, PATCH, EDIT/);
assert.match(prompt, /Required working branch: chatgpt-job\/example/);

console.log("AGENT_GITHUB_DIRECT_PROTOCOL_OK");
