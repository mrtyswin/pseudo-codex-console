"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { extractUploadImagePath } = require("../agent/agent");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-agent-image-upload-"));
const firstImage = path.join(root, "first-image.PNG");
const secondImage = path.join(root, "second-image.webp");
const textFile = path.join(root, "notes.txt");
fs.writeFileSync(firstImage, "image");
fs.writeFileSync(secondImage, "image");
fs.writeFileSync(textFile, "text");

try {
  const header = "参考ファイル（クリップボード貼り付け）:";
  assert.equal(
    extractUploadImagePath(`task\n\n${header}\n- ${firstImage}`),
    firstImage
  );
  assert.equal(
    extractUploadImagePath(`${header}\n- ${firstImage}\n- ${secondImage}`),
    firstImage
  );
  assert.equal(extractUploadImagePath(`${header}\n- ${textFile}`), null);
  assert.equal(extractUploadImagePath(`task\n- ${firstImage}`), null);
  assert.equal(
    extractUploadImagePath(`${header}\n- ${path.join(root, "missing.jpg")}`),
    null
  );
  console.log("AGENT_IMAGE_UPLOAD_OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
