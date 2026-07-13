"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

assert.match(source, /<details class="card settings-details">/);
assert.match(source, /<summary>プロジェクト設定を表示<\/summary>/);
assert.match(source, /<summary>プロジェクトを追加・更新<\/summary>/);
assert.match(source, /class="settings-content"/);
assert.match(source, /ChatGPTとのやり取り/);
assert.match(source, /name="executionMode"/);
assert.match(source, /Codex CLI.*専用 branch \/ PR/);
assert.match(source, /name="gitRepository"/);
assert.match(source, /Ubuntuホスト直接実行/);
assert.doesNotMatch(source, /sandboxWorkspace|Sandbox Workspace|\/mnt\/workspace/);

const renderStart = source.indexOf("function renderPage(jobs, message)");
const renderEnd = source.indexOf("function parseJobPath", renderStart);
const renderSource = source.slice(renderStart, renderEnd);
const jobsIndex = renderSource.indexOf("<h2>ジョブ一覧</h2>");
const settingsIndex = renderSource.indexOf("<summary>プロジェクト設定を表示</summary>");
assert.ok(jobsIndex >= 0 && settingsIndex > jobsIndex, "ジョブ一覧は設定より上に配置する");

assert.doesNotMatch(
  renderSource,
  /<details class="card settings-details"[^]*?<section class="card">[^]*?<\/details>/,
  "設定details内へ別カードsectionを誤って入れ子にしない"
);

assert.match(source, /sanitizeUserFacingText/);
assert.match(source, /turn\\d\+\(\?:file\|search\|view\|news\)/);

console.log("SETTINGS_DETAILS_AND_CHAT_UI_OK");
