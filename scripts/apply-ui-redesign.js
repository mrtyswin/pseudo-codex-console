"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appPath = path.join(root, "app.js");
const fragmentPath = path.join(__dirname, "ui-render-section.jsfrag");
const source = fs.readFileSync(appPath, "utf8");

if (source.includes("const CONSOLE_UI_SCRIPT = String.raw`<script>")) {
  console.log("UI redesign already applied");
  process.exit(0);
}

const startMarker = "function renderPage(jobs, message) {";
const endMarker = "function parseJobPath(pathname, suffix) {";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

if (start === -1 || end === -1 || end <= start) {
  throw new Error("renderPage replacement markers were not found");
}

const fragment = fs.readFileSync(fragmentPath, "utf8").trimEnd();
const next = source.slice(0, start) + fragment + "\n\n" + source.slice(end);
fs.writeFileSync(appPath, next, "utf8");
console.log("Applied Figma-based console UI redesign");
