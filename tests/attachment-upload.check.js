"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const temporaryRoot = fs.mkdtempSync(
path.join(projectRoot, ".attachment-upload-check-")
);
const dataDirectory = path.join(temporaryRoot, "data");
const blockedResultRoot = path.join(temporaryRoot, "blocked-result-root");
const dataPath = path.join(dataDirectory, "jobs.json");
const port = 20000 + (process.pid % 20000);

fs.mkdirSync(dataDirectory, { recursive: true });
fs.writeFileSync(blockedResultRoot, "not a directory");

const child = spawn(process.execPath, ["app.js"], {
cwd: projectRoot,
env: {
...process.env,
PORT: String(port),
DATA_PATH: dataPath,
PROJECT_CONFIG_PATH: path.join(projectRoot, "projects.example.json"),
RESULT_LOG_ROOT: blockedResultRoot
},
stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", function(chunk) {
output += chunk;
});
child.stderr.on("data", function(chunk) {
output += chunk;
});

function request(method, pathname, body) {
return new Promise(function(resolve, reject) {
const requestOptions = {
hostname: "127.0.0.1",
port,
path: pathname,
method,
headers: {
Accept: "application/json"
}
};

if (body !== undefined) {
requestOptions.headers["Content-Type"] = "application/json";
requestOptions.headers["Content-Length"] = Buffer.byteLength(body);
}

const requestInstance = http.request(requestOptions, function(response) {
const chunks = [];
response.on("data", function(chunk) {
chunks.push(chunk);
});
response.on("end", function() {
resolve({
statusCode: response.statusCode,
body: Buffer.concat(chunks).toString("utf8")
});
});
});

requestInstance.on("error", reject);
requestInstance.end(body);
});
}

async function waitForServer() {
for (let attempt = 0; attempt < 50; attempt += 1) {
if (child.exitCode !== null) {
throw new Error("server exited before becoming ready\n" + output);
}

try {
const response = await request("GET", "/health");
if (response.statusCode === 200) return;
} catch (_error) {
await new Promise(function(resolve) {
setTimeout(resolve, 100);
});
}
}

throw new Error("server did not become ready\n" + output);
}

async function stopServer() {
if (child.exitCode !== null) return;

child.kill("SIGTERM");
await Promise.race([
new Promise(function(resolve) {
child.once("exit", resolve);
}),
new Promise(function(resolve) {
setTimeout(resolve, 5000);
})
]);

if (child.exitCode === null) {
child.kill("SIGKILL");
}
}

async function main() {
await waitForServer();

const attachment = Buffer.alloc(1572864, 120);
const response = await request(
"POST",
"/jobs",
JSON.stringify({
project: "request-console",
instruction: "1.5MB画像の添付登録テスト",
attachments: [
{
name: "test-image.png",
type: "image/png",
data: attachment.toString("base64")
}
]
})
);

assert.equal(response.statusCode, 201, response.body);

const job = JSON.parse(response.body);
const attachmentDirectory = path.join(
dataDirectory,
"attachments",
job.id
);
const attachmentPath = path.join(
attachmentDirectory,
"01-test-image.png"
);

assert.deepEqual(
fs.readdirSync(attachmentDirectory),
["01-test-image.png"]
);
assert.equal(fs.statSync(attachmentPath).size, attachment.length);
assert.ok(
job.instruction.includes(attachmentPath),
"job instruction must include the stored attachment path"
);

console.log("ATTACHMENT_UPLOAD_OK");
}

main()
.catch(function(error) {
console.error(output);
console.error(error);
process.exitCode = 1;
})
.finally(async function() {
await stopServer();
fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
