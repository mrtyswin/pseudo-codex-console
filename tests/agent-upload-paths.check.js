"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { extractUploadPaths } = require("../agent/agent");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-agent-upload-paths-"));
const firstImage = path.join(root, "first-image.PNG");
const pdfFile = path.join(root, "reference.pdf");
const textFile = path.join(root, "notes.txt");
fs.writeFileSync(firstImage, "image");
fs.writeFileSync(pdfFile, "pdf");
fs.writeFileSync(textFile, "text");

try {
  const header = "参考ファイル（クリップボード貼り付け）:";
  assert.deepEqual(
    extractUploadPaths(`task\n\n${header}\n- ${firstImage}\n- ${pdfFile}\n- ${textFile}`),
    [firstImage, pdfFile, textFile]
  );
  assert.deepEqual(
    extractUploadPaths(`${header}\n- ${firstImage}\n- ${path.join(root, "missing.jpg")}\n- ${pdfFile}`),
    [firstImage, pdfFile]
  );
  assert.deepEqual(extractUploadPaths(`task\n- ${firstImage}`), []);
  console.log("AGENT_UPLOAD_PATHS_OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
