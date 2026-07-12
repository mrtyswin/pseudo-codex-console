#!/usr/bin/env node
/**
 * agent.js — Codex-style agentic loop using chatgpt.com via chatgpt.js daemon
 *
 * ChatGPT can explore the codebase itself by requesting shell commands:
 *   ===RUN: ls cmd/api/===
 *   ===RUN: cat internal/data/users.go===
 * The agent executes them automatically and feeds the output back.
 * File writes use ===FILE=== blocks and ask for approval (unless --auto).
 *
 * Usage:
 *   node agent.js [options] "task description"
 *
 * Options:
 *   --files  f1,f2,...   Seed files to include upfront (optional)
 *   --check  "cmd"       Command to run after applying changes (e.g. "go build ./...")
 *   --cwd    /path       Working directory (default: process.cwd())
 *   --auto               Apply file changes without confirmation prompts
 *   --reuse-chat         Send the task to the currently selected ChatGPT chat
 *
 * Example:
 *   node agent.js --check "go build ./..." --cwd ~/GolandProjects/steroidCycleTracker \
 *     "add input validation to createUserHandler"
 */

'use strict';

const { spawnSync } = require('child_process');
const crypto        = require('crypto');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const readline      = require('readline');
const http          = require('http');
const https         = require('https');

const SCRIPT    = process.env.PSEUDO_CODEX_CHATGPT_SCRIPT || path.join(__dirname, 'chatgpt.js');
const MAX_TURNS = Number.parseInt(process.env.PSEUDO_CODEX_MAX_TURNS || '30', 10);
const MAX_IDENTICAL_ERRORS = Number.parseInt(process.env.PSEUDO_CODEX_MAX_IDENTICAL_ERRORS || '3', 10);
const MAX_NO_PROGRESS_TURNS = Number.parseInt(process.env.PSEUDO_CODEX_MAX_NO_PROGRESS_TURNS || '6', 10);
const MAX_STRATEGY_RESETS = Number.parseInt(process.env.PSEUDO_CODEX_MAX_STRATEGY_RESETS || '3', 10);
const MAX_INSPECT_TURNS = Number.parseInt(process.env.PSEUDO_CODEX_MAX_INSPECT_TURNS || '8', 10);
const MAX_CONTEXT_CHARS = Number.parseInt(process.env.PSEUDO_CODEX_MAX_CONTEXT_CHARS || '200000', 10);
const COMPLETE_MARKER = '===TASK_COMPLETE===';
const CHATGPT_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.CHATGPT_REQUEST_TIMEOUT_MS || '180000',
  10
);
const COMMAND_OUTPUT_LIMIT = Number.parseInt(
  process.env.PSEUDO_CODEX_COMMAND_OUTPUT_LIMIT || '20000',
  10
);
const COMMAND_LENGTH_LIMIT = Number.parseInt(
  process.env.PSEUDO_CODEX_COMMAND_LENGTH_LIMIT || '12000',
  10
);

// ─── CLI parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    files: [],
    check: null,
    cwd: process.cwd(),
    auto: false,
    reuseChat: false,
    task: null,
    jobId: process.env.PSEUDO_CODEX_JOB_ID || null,
    consoleUrl: process.env.PSEUDO_CODEX_CONSOLE_URL || null,
    sessionFile: process.env.PSEUDO_CODEX_SESSION_FILE || null,
    sessionKey: process.env.PSEUDO_CODEX_SESSION_KEY || null,
    hostWorkspace: null,
    hostProductionRoot: null,
    hostDeployCommand: null,
    taskFile: null,
    taskStdin: false
  };
  for (let i = 0; i < argv.length; i++) {
    if      (argv[i] === '--files') args.files = argv[++i].split(',').map(s => s.trim());
    else if (argv[i] === '--check') args.check = argv[++i];
    else if (argv[i] === '--cwd')   args.cwd   = path.resolve(argv[++i]);
    else if (argv[i] === '--auto')  args.auto  = true;
    else if (argv[i] === '--reuse-chat') args.reuseChat = true;
    else if (argv[i] === '--job-id') args.jobId = argv[++i];
    else if (argv[i] === '--console-url') args.consoleUrl = argv[++i];
    else if (argv[i] === '--session-file') args.sessionFile = argv[++i];
    else if (argv[i] === '--session-key') args.sessionKey = argv[++i];
    else if (argv[i] === '--host-workspace') args.hostWorkspace = argv[++i];
    else if (argv[i] === '--host-production-root') args.hostProductionRoot = argv[++i];
    else if (argv[i] === '--host-deploy-command') args.hostDeployCommand = argv[++i];
    else if (argv[i] === '--task-file') args.taskFile = argv[++i];
    else if (argv[i] === '--task-stdin') args.taskStdin = true;
    else                            args.task  = argv[i];
  }
  return args;
}

// ─── ChatGPT call ─────────────────────────────────────────────────────────────

function ask(prompt, isNew = false, sessionFile = null, sessionKey = null) {
  // Keep large command output out of argv so the OS argument-size limit cannot
  // terminate a job. The browser client reads this file before making its HTTP request.
  const promptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pseudo-codex-prompt-'));
  const promptFile = path.join(promptDirectory, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });
  const flags = [];
  if (isNew) flags.push('--new');
  if (sessionFile) flags.push('--session-file', sessionFile);
  if (sessionKey) flags.push('--session-key', sessionKey);
  flags.push('--prompt-file', promptFile);

  try {
    const result = spawnSync('node', [SCRIPT, ...flags], {
      encoding:  'utf8',
      timeout:   CHATGPT_REQUEST_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();
    if (result.status !== 0 || result.error) {
      return `[ERROR] ${stderr || stdout || result.error?.message || 'ChatGPT client failed'}`;
    }
    return stdout || stderr || '(no response)';
  } finally {
    fs.rmSync(promptDirectory, { recursive: true, force: true });
  }
}

// ─── Request-console reporting ───────────────────────────────────────────────

function postJson(urlString, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10_000,
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        responseBody += chunk;
      });
      response.on('end', () => {
        if (
          response.statusCode >= 200 &&
          response.statusCode < 300
        ) {
          resolve(responseBody);
          return;
        }
        reject(new Error(
          'request-console ' +
          response.statusCode +
          ': ' +
          responseBody
        ));
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('request-console timeout'));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function jobEndpoint(args, suffix) {
  if (!args.consoleUrl || !args.jobId) return null;
  return (
    args.consoleUrl.replace(/\/$/, '') +
    '/api/jobs/' +
    encodeURIComponent(args.jobId) +
    '/' +
    suffix
  );
}

async function reportProgress(args, stage, message, extra = {}) {
  const endpoint = jobEndpoint(args, 'progress');
  if (!endpoint) return;

  try {
    await postJson(endpoint, { stage, message, ...extra });
  } catch (error) {
    console.error('[progress warning] ' + error.message);
  }
}

async function reportResult(args, payload) {
  const endpoint = jobEndpoint(args, 'result');
  if (!endpoint) return;

  try {
    await postJson(endpoint, payload);
  } catch (error) {
    console.error('[result warning] ' + error.message);
  }
}

function conversationMetadata(args) {
  if (!args.sessionFile || !fs.existsSync(args.sessionFile)) {
    return { workerSessionId: args.sessionKey || args.jobId || '' };
  }
  const chatConversationUrl = fs.readFileSync(args.sessionFile, 'utf8').trim();
  const match = chatConversationUrl.match(/\/c\/([^/?#]+)/);
  return {
    chatConversationId: match ? match[1] : '',
    chatConversationUrl,
    workerSessionId: args.sessionKey || args.jobId || '',
  };
}

async function reportTurn(args, payload) {
  const endpoint = jobEndpoint(args, 'turn');
  if (!endpoint) return;
  try {
    await postJson(endpoint, payload);
  } catch (error) {
    console.error('[turn warning] ' + error.message);
  }
}

function cleanFinalAnswer(response) {
  const answer = String(response || '')
    .replace(COMPLETE_MARKER, '')
    .replace(/^--- RESPONSE ---\s*/i, '')
    .replace(/\s*--- END ---$/i, '')
    .trim();
  return answer || 'Task completed and verified.';
}

function isVerificationCommand(command) {
  return /(^|[;&|]\s*)(test\b|node\s+--check\b|npm\s+test\b|pytest\b|python\d*\s+-m\s+pytest\b|curl\b.*\/health\b|grep\b|git\s+diff\s+--check\b)/i.test(
    String(command)
  );
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walkWorkspace(root, limit = 500) {
  const ignored = new Set(['.git', 'node_modules', 'backups', 'recovery', '.restart-test']);
  const files = [];
  const visit = directory => {
    if (files.length >= limit) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= limit || ignored.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(root);
  return files.sort();
}

function workspaceSnapshot(cwd) {
  const files = {};
  for (const fullPath of walkWorkspace(cwd)) {
    const relative = path.relative(cwd, fullPath).split(path.sep).join('/');
    const stat = fs.statSync(fullPath);
    files[relative] = stat.size <= 5 * 1024 * 1024
      ? sha256File(fullPath)
      : `large:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { digest, files };
}

function changedFilesBetween(before, after) {
  const names = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...names].filter(name => before.files[name] !== after.files[name]).sort();
}

function classifyError(result) {
  const text = String(result.output || '').toLowerCase();
  if (result.timedOut || text.includes('timed_out=true')) return 'command_timeout';
  if (text.includes('exact old text must occur once')) return 'edit_context_mismatch';
  if (text.includes('corrupt patch')) return 'patch_apply';
  if (text.includes('patch') && (text.includes('does not apply') || text.includes('failed'))) return 'patch_apply';
  if (text.includes('syntax error near unexpected token') || text.includes('shell syntax check failed')) return 'shell_syntax';
  if (text.includes('syntaxerror') || text.includes('indentationerror')) return 'code_syntax';
  if (text.includes('no such file or directory') || text.includes('cannot access')) return 'path_not_found';
  if (text.includes('auto_deploy_rolled_back') || text.includes('deployment failed')) return 'deploy_failure';
  if (text.includes('refused command containing')) return 'command_policy';
  if (text.includes('command not found') || text.includes('enoent')) return 'command_not_found';
  if (text.includes('permission denied') || text.includes('operation not permitted')) return 'permission_denied';
  if (/test.*fail|assertionerror|expected .* actual/.test(text)) return 'test_failure';
  if (text.includes('duplicate_failed_command_refused')) return 'command_failure';
  return 'command_failure';
}

function errorFingerprint(result) {
  const errorClass = classifyError(result);
  const normalized = String(result.output || '')
    .toLowerCase()
    .replace(/\/tmp\/[^\s:]+/g, '/tmp/<temp>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .slice(0, 800);
  return `${errorClass}:${normalized}`;
}

function isHostOnlyCommand(command, args) {
  const value = String(command || '');
  const hostPaths = [args.hostWorkspace, args.hostProductionRoot]
    .filter(item => typeof item === 'string' && item.startsWith('/'));
  if (args.hostDeployCommand && value.includes(args.hostDeployCommand)) return true;
  return hostPaths.some(item => value.includes(item));
}

function compactContext(value) {
  const text = String(value || '');
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return `[context truncated; ${text.length} characters total]\n` + text.slice(-MAX_CONTEXT_CHARS);
}

// ─── Build initial prompt ─────────────────────────────────────────────────────

function buildInitialPrompt(task, files, cwd) {
  let prompt = '';

  if (files.length > 0) {
    prompt += `Here are some relevant files to start with:\n\n`;
    for (const f of files) {
      const fullPath = path.isAbsolute(f) ? f : path.join(cwd, f);
      const content  = fs.readFileSync(fullPath, 'utf8');
      prompt += `===FILE: ${f}===\n${content}\n===ENDFILE===\n\n`;
    }
  }

  prompt +=
    `Task: ${task}\n` +
    `Working directory: ${cwd}\n\n` +
    `You are a coding agent with access to the user's filesystem.\n` +
    `Use these plain-text formats — no markdown, no code fences:\n\n` +
    `To run one shell command:\n` +
    `===RUN: <command>===\n` +
    `For a multi-line shell command:\n` +
    `===RUN===\n<command>\n===ENDRUN===\n\n` +
    `To modify an existing text file, prefer a standard unified diff:\n` +
    `===PATCH===\n--- a/path/to/file\n+++ b/path/to/file\n@@ ...\n===ENDPATCH===\n\n` +
    `For one small exact replacement, use:\n` +
    `===EDIT: path/to/file===\n===OLD===\n<exact old text>\n===NEW===\n<replacement text>\n===ENDEDIT===\n\n` +
    `If exact editing failed, use an exact one-occurrence replacement:\n` +
    `===REPLACE: path/to/file===\n===OLD===\n<exact old text>\n===NEW===\n<replacement text>\n===ENDREPLACE===\n\n` +
    `To create or modify a text file (output COMPLETE file content):\n` +
    `===FILE: path/to/file===\n` +
    `<complete content>\n` +
    `===ENDFILE===\n` +
    `For files where whitespace must be exact, use UTF-8 base64:\n` +
    `===FILE_BASE64: path/to/file===\n<base64>\n===ENDFILE===\n\n` +
    `Rules:\n` +
    `- Start by exploring if you need more context (ls, cat, grep).\n` +
    `- You will receive the output of each RUN command automatically.\n` +
    `- Only output FILE blocks when you are ready to make changes.\n` +
    `- Never put base64, gzip payloads, or large scripts inside RUN blocks.\n` +
    `- Never repeat a failed command. Change tool or narrow the target instead.\n` +
    `- You can mix RUN, EDIT, REPLACE, PATCH, and FILE blocks in one response.\n` +
    `- After file blocks, briefly explain what you changed and why.\n` +
    `- When the task is fully verified, output ${COMPLETE_MARKER} on its own line.`;

  return prompt;
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseRunBlocks(response) {
  response = String(response || '').replace(/\r\n?/g, '\n');
  const commands = [];
  const blockRegex = /===RUN===\n([\s\S]*?)\n===ENDRUN===/g;
  const inlineRegex = /===RUN:\s*([^\n=][^\n]*)===/g;
  let match;
  while ((match = blockRegex.exec(response)) !== null) {
    const command = match[1].replace(/^\n|\n$/g, '');
    if (command) commands.push(command);
  }
  while ((match = inlineRegex.exec(response)) !== null) {
    commands.push(match[1].trim());
  }
  return commands;
}

function parseFileBlocks(response) {
  const changes = [];
  const base64Regex = /===FILE_BASE64:\s*([^\n=]+)===\n([A-Za-z0-9+/=\s]+?)===ENDFILE===/g;
  const regex = /===FILE:\s*([^\n=]+)===\n([\s\S]*?)===ENDFILE===/g;
  let match;
  while ((match = base64Regex.exec(response)) !== null) {
    const encoded = match[2].replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) continue;
    changes.push({ path: match[1].trim(), content: Buffer.from(encoded, 'base64').toString('utf8') });
  }
  while ((match = regex.exec(response)) !== null) {
    changes.push({ path: match[1].trim(), content: match[2] });
  }
  return changes;
}

function parsePatchBlocks(response) {
  const normalized = String(response || '').replace(/\r\n?/g, '\n');
  const patches = [];
  const regex = /===PATCH===\n([\s\S]*?)\n===ENDPATCH===/gi;
  let match;
  while ((match = regex.exec(normalized)) !== null) {
    const content = match[1].replace(/^\n|\n$/g, '');
    if (content) patches.push({ content });
  }
  return patches;
}

function parseEditBlocks(response) {
  const normalized = String(response || '').replace(/\r\n?/g, '\n');
  const edits = [];
  const regex = /===EDIT:\s*([^\n=]+)===\n===OLD===\n([\s\S]*?)\n===NEW===\n([\s\S]*?)\n===ENDEDIT===/g;
  let match;
  while ((match = regex.exec(normalized)) !== null) {
    edits.push({
      path: match[1].trim(),
      oldText: match[2],
      newText: match[3],
    });
  }
  return edits;
}

function parseReplaceBlocks(response) {
  const normalized = String(response || '').replace(/\r\n?/g, '\n');
  const replacements = [];
  const regex = /===REPLACE:\s*([^\n=]+)===\n===OLD===\n([\s\S]*?)\n===NEW===\n([\s\S]*?)\n===ENDREPLACE===/g;
  let match;
  while ((match = regex.exec(normalized)) !== null) {
    replacements.push({
      path: match[1].trim(),
      oldText: match[2],
      newText: match[3],
    });
  }
  return replacements;
}

// ─── User input helper ────────────────────────────────────────────────────────

function askUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// ─── Execute RUN commands ─────────────────────────────────────────────────────

function compactOutput(value) {
  const clean = String(value || '').replace(/\0/g, '');
  if (clean.length <= COMMAND_OUTPUT_LIMIT) return clean;
  return `[output truncated; ${clean.length} characters total]\n` + clean.slice(-COMMAND_OUTPUT_LIMIT);
}

function commandValidationError(command) {
  const unsafeTypography = command.match(/[\u2018\u2019\u201c\u201d\u2013\u2014\u2212\uff0d\uff5c]/u);
  if (unsafeTypography) {
    return `Refused command containing typographic shell character U+${unsafeTypography[0].codePointAt(0).toString(16).toUpperCase()}. Resend it with ASCII quotes, hyphens, or pipes.`;
  }
  if (command.includes('\0')) return 'Refused command containing a NUL byte.';
  if (command.length > COMMAND_LENGTH_LIMIT) {
    return `Refused ${command.length}-character command. Limit is ${COMMAND_LENGTH_LIMIT}; use PATCH or FILE blocks.`;
  }
  if (/base64\s+(?:--decode|-d)\b|gzip\s+(?:--decompress|-d)\b|\.gz\.b64\b/i.test(command)) {
    return 'Refused encoded patch payload in RUN block. Use a unified PATCH block instead.';
  }
  return '';
}

function normalizedCommandKey(command) {
  return String(command).trim().replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n');
}

async function execCommands(commands, cwd, auto, onCommand, commandFailures) {
  const results = [];
  for (const cmd of commands) {
    console.log(`\n$ ${cmd}`);
    let run = 'y';
    if (!auto) {
      run = await askUser('Run this command? [y/n] ');
    }
    if (run === 'y' || run === '') {
      if (onCommand) await onCommand(cmd);
      const commandKey = normalizedCommandKey(cmd);
      if (commandFailures.has(commandKey)) {
        const output = 'DUPLICATE_FAILED_COMMAND_REFUSED: this exact command already failed. Change strategy; prefer PATCH for existing files.';
        console.log(output);
        results.push({ cmd, output, status: 2 });
        continue;
      }
      const validationError = commandValidationError(cmd);
      if (validationError) {
        console.log(validationError);
        results.push({ cmd, output: validationError, status: 2 });
        commandFailures.add(commandKey);
        continue;
      }
      const composeAction = /^chatgpt-compose\s+(pull|build|up)\b/.test(cmd);
      const scriptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pseudo-codex-run-'));
      const scriptPath = path.join(scriptDirectory, 'command.sh');
      try {
        fs.writeFileSync(scriptPath, cmd + '\n', { encoding: 'utf8', mode: 0o700 });
        const syntax = spawnSync('/bin/bash', ['-n', scriptPath], {
          encoding: 'utf8', cwd, timeout: 30_000,
        });
        if (syntax.status !== 0) {
          const output = compactOutput((syntax.stdout || '') + (syntax.stderr || '')).trim() || 'Shell syntax check failed.';
          console.log(output);
          results.push({ cmd, output, status: syntax.status });
          commandFailures.add(commandKey);
          continue;
        }
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', scriptPath], {
          encoding: 'utf8',
          cwd,
          timeout: composeAction ? 900_000 : 60_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const output = compactOutput((result.stdout || '') + (result.stderr || '')).trim() || '(no output)';
        console.log(output);
        results.push({ cmd, output, status: result.status, timedOut: result.error?.code === 'ETIMEDOUT' });
        if (result.status !== 0 || result.error) commandFailures.add(commandKey);
      } finally {
        fs.rmSync(scriptDirectory, { recursive: true, force: true });
      }
    } else {
      console.log('  ✗ Skipped');
      results.push({ cmd, output: '(skipped by user)' });
    }
  }
  return results;
}

function patchValidationError(patchContent) {
  const paths = patchTargetPaths(patchContent);
  if (paths.length === 0) return 'Patch has no file headers.';
  if (paths.length !== 1) return 'One PATCH block must target exactly one file.';
  for (const candidate of paths) {
    if (!safeRelativePath(candidate)) {
      return `Patch path is outside the working directory: ${candidate}`;
    }
  }
  return '';
}

function patchTargetPaths(patchContent) {
  const paths = [];
  for (const line of patchContent.split('\n')) {
    const match = line.match(/^(?:---|\+\+\+)\s+([^\t ]+)/);
    if (!match || match[1] === '/dev/null') continue;
    const candidate = match[1].replace(/^[ab]\//, '');
    if (!paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

function normalizeUnifiedDiff(patchContent) {
  const lines = patchContent.replace(/\r\n?/g, '\n').split('\n');
  let inHunk = false;
  return lines.map(line => {
    if (line.startsWith('@@')) {
      inHunk = true;
      return line;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ')) {
      inHunk = false;
      return line;
    }
    if (inHunk && line === '') return ' ';
    if (inHunk && !/^[ +\\-]/.test(line)) return ' ' + line;
    return line;
  }).join('\n');
}

function safeRelativePath(candidate) {
  return Boolean(
    candidate &&
    !path.isAbsolute(candidate) &&
    !candidate.split(/[\\/]/).includes('..')
  );
}

function writeTextFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.pseudo-codex-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode : 0o644;
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

async function applyEdits(edits, cwd) {
  const results = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    const label = `EDIT ${index + 1}: ${edit.path}`;
    if (!safeRelativePath(edit.path)) {
      results.push({ cmd: label, output: 'Edit path is outside the working directory.', status: 2 });
      continue;
    }
    const fullPath = path.resolve(cwd, edit.path);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      results.push({ cmd: label, output: 'Edit target is not a file.', status: 2 });
      continue;
    }
    const beforeSha = sha256File(fullPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const occurrences = content.split(edit.oldText).length - 1;
    if (occurrences !== 1) {
      results.push({ cmd: label, output: `Exact old text must occur once; found ${occurrences}.`, status: 2 });
      continue;
    }
    writeTextFileAtomic(fullPath, content.replace(edit.oldText, edit.newText));
    const afterSha = sha256File(fullPath);
    console.log(`\n${label}\nExact edit applied.`);
    results.push({ cmd: label, output: 'Exact edit applied.', status: 0, file: edit.path, beforeSha, afterSha });
  }
  return results;
}

async function applyReplacements(replacements, cwd) {
  const results = [];
  for (let index = 0; index < replacements.length; index++) {
    const replacement = replacements[index];
    const label = `REPLACE ${index + 1}: ${replacement.path}`;
    if (!safeRelativePath(replacement.path)) {
      results.push({ cmd: label, output: 'Replacement path is outside the working directory.', status: 2 });
      continue;
    }
    const fullPath = path.resolve(cwd, replacement.path);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      results.push({ cmd: label, output: 'Replacement target is not a file.', status: 2 });
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const occurrences = content.split(replacement.oldText).length - 1;
    if (occurrences !== 1) {
      results.push({ cmd: label, output: `Exact old text must occur once; found ${occurrences}. Re-read a smaller unique range.`, status: 2 });
      continue;
    }
    const beforeSha = sha256File(fullPath);
    writeTextFileAtomic(fullPath, content.replace(replacement.oldText, replacement.newText));
    const afterSha = sha256File(fullPath);
    console.log(`\n${label}\nExact replacement applied.`);
    results.push({ cmd: label, output: 'Exact replacement applied.', status: 0, file: replacement.path, beforeSha, afterSha });
  }
  return results;
}

async function applyPatches(patches, cwd) {
  const results = [];
  for (let index = 0; index < patches.length; index++) {
    const patch = patches[index];
    const content = normalizeUnifiedDiff(patch.content);
    const label = `PATCH ${index + 1}`;
    const validationError = patchValidationError(content);
    if (validationError) {
      results.push({ cmd: label, output: validationError, status: 2 });
      continue;
    }
    const target = patchTargetPaths(content)[0];
    const targetPath = path.resolve(cwd, target);
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      results.push({ cmd: label, output: `Patch target is not a file: ${target}`, status: 2 });
      continue;
    }
    const beforeSha = sha256File(targetPath);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pseudo-codex-patch-'));
    const patchPath = path.join(directory, 'change.diff');
    try {
      fs.writeFileSync(patchPath, content + '\n', { encoding: 'utf8', mode: 0o600 });
      const check = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', patchPath], {
        cwd, encoding: 'utf8', timeout: 60_000,
      });
      if (check.status !== 0) {
        results.push({
          cmd: label,
          output: compactOutput((check.stdout || '') + (check.stderr || '')).trim() || 'git apply --check failed',
          status: check.status,
        });
        continue;
      }
      const applied = spawnSync('git', ['apply', '--whitespace=nowarn', patchPath], {
        cwd, encoding: 'utf8', timeout: 60_000,
      });
      const output = compactOutput((applied.stdout || '') + (applied.stderr || '')).trim() || 'Patch applied.';
      console.log(`\n${label}\n${output}`);
      const afterSha = applied.status === 0 ? sha256File(targetPath) : beforeSha;
      results.push({ cmd: label, output, status: applied.status, file: target, beforeSha, afterSha });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  return results;
}

function buildCommandResults(results) {
  return results
    .map(r => {
      const output = String(r.output).replace(/\0/g, '');
      return `$ ${r.cmd}\nexit_status=${r.status ?? 'unknown'}${r.timedOut ? ' timed_out=true' : ''}\n${output}`;
    })
    .join('\n\n');
}

// ─── Apply file changes to disk ───────────────────────────────────────────────

async function applyChanges(changes, cwd, auto) {
  const results = [];
  if (changes.length === 0) return results;

  for (const change of changes) {
    const fullPath = path.resolve(cwd, change.path);
    const cwdPrefix = `${path.resolve(cwd)}${path.sep}`;
    if (!fullPath.startsWith(cwdPrefix)) {
      console.log(`  ✗ Refused path outside working directory: ${change.path}`);
      results.push({ cmd: `FILE: ${change.path}`, output: 'Path is outside working directory.', status: 2 });
      continue;
    }
    const existed = fs.existsSync(fullPath);
    const beforeSha = existed && fs.statSync(fullPath).isFile() ? sha256File(fullPath) : '';
    if (existed && !fs.statSync(fullPath).isFile()) {
      results.push({ cmd: `FILE: ${change.path}`, output: 'File target is not a regular file.', status: 2 });
      continue;
    }

    console.log(`\n─── ${change.path} (${change.content.split('\n').length} lines) ───`);

    let apply = 'y';
    if (!auto) {
      const lines     = change.content.split('\n');
      const preview   = lines.slice(0, 20).join('\n');
      const truncated = lines.length > 20;
      console.log(preview + (truncated ? '\n  ...(truncated — type "show" to see all)' : ''));

      apply = await askUser('Apply? [y/n/show] ');
      if (apply === 'show') {
        console.log('\n' + change.content);
        apply = await askUser('Apply? [y/n] ');
      }
    }

    if (apply === 'y' || apply === '') {
      writeTextFileAtomic(fullPath, change.content);
      console.log(`  ✓ ${existed ? 'Replaced' : 'Written'}: ${change.path}`);
      const afterSha = sha256File(fullPath);
      results.push({ cmd: `FILE: ${change.path}`, output: existed ? 'Complete file replaced.' : 'New file written.', status: 0, file: change.path, beforeSha, afterSha });
    } else {
      console.log(`  ✗ Skipped: ${change.path}`);
      results.push({ cmd: `FILE: ${change.path}`, output: 'Skipped by user.', status: 2 });
    }
  }
  return results;
}

// ─── Run check command ────────────────────────────────────────────────────────

function runCheck(cmd, cwd) {
  console.log(`\n[check] $ ${cmd}`);
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8', cwd });
  const output = (result.stdout + result.stderr).trim();
  console.log(output || '(no output)');
  return { output, failed: result.status !== 0 };
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.taskFile) {
    args.task = fs.readFileSync(path.resolve(args.taskFile), 'utf8');
  }
  if (args.taskStdin) {
    args.task = fs.readFileSync(0, 'utf8');
  }

  if (!args.sessionKey && args.jobId) args.sessionKey = args.jobId;

  if (!args.task) {
    console.error(
      'Usage: node agent.js [--files f1,f2] [--check "cmd"] [--cwd /path] [--auto] [--reuse-chat] "task"\n' +
      'Example: node agent.js --check "go build ./..." --cwd ~/project "add validation to createUserHandler"'
    );
    process.exit(1);
  }

  console.log(`\nTask : ${args.task}`);
  console.log(`CWD  : ${args.cwd}`);
  if (args.files.length) console.log(`Files: ${args.files.join(', ')}`);
  if (args.check)        console.log(`Check: ${args.check}`);
  console.log('');

  let prompt = buildInitialPrompt(args.task, args.files, args.cwd);
  let isNew = args.sessionFile ? !fs.existsSync(args.sessionFile) : !args.reuseChat;
  let turns = 0;
  let phase = 'INSPECT';
  let hasEdited = false;
  let verificationPassed = false;
  let noProgressTurns = 0;
  let inspectTurns = 0;
  let lastSnapshot = workspaceSnapshot(args.cwd);
  const initialSnapshot = lastSnapshot;
  const changedFiles = new Set();
  const transactions = [];
  const executionLog = [];
  const verificationLog = [];
  const commandFailures = new Set();
  const errorClassCounts = new Map();
  const errorFingerprintCounts = new Map();
  const recoveryHistory = [];
  let strategyResets = 0;

  const statePayload = extra => ({
    phase,
    remainingTurns: Math.max(0, MAX_TURNS - turns),
    changedFiles: [...changedFiles],
    transactions: transactions.slice(-100),
    strategyPass: strategyResets + 1,
    inspectTurns,
    recoveryHistory: recoveryHistory.slice(-10),
    ...extra,
  });

  const checkpointText = reason => JSON.stringify({
    reason,
    phase,
    turns,
    remainingTurns: Math.max(0, MAX_TURNS - turns),
    changedFiles: [...changedFiles],
    transactions: transactions.slice(-100),
    strategyPass: strategyResets + 1,
    inspectTurns,
    recoveryHistory: recoveryHistory.slice(-10),
    successfulVerification: verificationPassed,
    resume: 'Start from this checkpoint with a materially different strategy. Preserve verified facts and successful file changes.',
  }, null, 2);

  const saveCheckpoint = reason => {
    const text = checkpointText(reason);
    if (args.sessionFile) {
      const checkpointPath = path.join(path.dirname(args.sessionFile), 'checkpoint.json');
      fs.writeFileSync(checkpointPath, text, { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(checkpointPath, 0o600);
    }
    return text;
  };

  const blockJob = async (reason, errorClass) => {
    phase = 'BLOCKED';
    const checkpoint = saveCheckpoint(reason);
    await reportProgress(args, 'blocked', reason, statePayload({ errorClass, checkpoint }));
    await reportResult(args, {
      status: 'blocked',
      lastError: reason,
      workerLog: args.sessionFile
        ? `Checkpoint: ${path.join(path.dirname(args.sessionFile), 'checkpoint.json')}\nLog: /home/ubuntu/.local/state/pseudo-codex/jobs/${args.jobId}.log`
        : checkpoint,
      finalAnswer: '',
      executionResult: compactOutput(executionLog.join('\n\n')),
      verificationResult: compactOutput(verificationLog.join('\n\n')),
    });
    console.error(`[blocked] ${reason}`);
    process.exitCode = 78;
  };

  const recordResults = results => {
    let repeatedFailure = null;
    for (const result of results) {
      if (result.status === 0) {
        if (result.file) {
          changedFiles.add(result.file);
          transactions.push({
            at: new Date().toISOString(),
            file: result.file,
            operation: String(result.cmd || ''),
            status: 'applied',
          });
        }
        continue;
      }
      const errorClass = classifyError(result);
      if (errorClass === 'edit_context_mismatch') {
        continue;
      }
      errorClassCounts.set(errorClass, (errorClassCounts.get(errorClass) || 0) + 1);
      const fingerprint = errorFingerprint(result);
      const count = (errorFingerprintCounts.get(fingerprint) || 0) + 1;
      errorFingerprintCounts.set(fingerprint, count);
      if (count >= MAX_IDENTICAL_ERRORS) {
        repeatedFailure = {
          errorClass,
          fingerprint,
          evidence: buildCommandResults([result]),
        };
      }
    }
    return repeatedFailure;
  };

  const archiveCurrentConversation = reason => {
    if (!args.sessionFile || !fs.existsSync(args.sessionFile)) return;
    const directory = path.dirname(args.sessionFile);
    const historyPath = path.join(directory, 'chat-history.json');
    let history = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (Array.isArray(parsed)) history = parsed;
    } catch (_error) {
      history = [];
    }
    history.push({
      at: new Date().toISOString(),
      url: fs.readFileSync(args.sessionFile, 'utf8').trim(),
      reason,
      strategyPass: strategyResets + 1,
    });
    fs.writeFileSync(historyPath, JSON.stringify(history.slice(-20), null, 2), { encoding: 'utf8', mode: 0o600 });
  };

  const startFreshStrategy = async (reason, errorClass, evidence) => {
    if (strategyResets >= MAX_STRATEGY_RESETS) return false;
    archiveCurrentConversation(reason);
    strategyResets += 1;
    recoveryHistory.push({
      at: new Date().toISOString(),
      pass: strategyResets + 1,
      reason,
      errorClass,
    });
    phase = 'PLAN';
    noProgressTurns = 0;
    inspectTurns = 0;
    errorClassCounts.clear();
    errorFingerprintCounts.clear();
    turns = 0;
    isNew = true;
    prompt = [
      `RECOVERY STRATEGY PASS ${strategyResets + 1} of ${MAX_STRATEGY_RESETS + 1}.`,
      'You are a fresh implementation agent replacing a stuck approach.',
      'Preserve the current workspace and all successful edits. Do not restart broad exploration.',
      `Original task:\n${args.task}`,
      `Current phase: ${phase}`,
      `Changed files: ${[...changedFiles].join(', ') || '(none)'}`,
      `Failure category: ${errorClass}`,
      `Reason for strategy reset: ${reason}`,
      `Failure evidence:\n${compactOutput(evidence || '(none)')}`,
      'Choose a materially different method. Do not repeat any failed command.',
      'If PATCH/EDIT failed, use a complete FILE block after reading the current target.',
      'Do not inspect or execute host-only deployment paths; the host dispatcher deploys after TASK_COMPLETE.',
      'Return one smallest useful action now.',
    ].join('\n\n');
    await reportProgress(
      args,
      'sending_to_chatgpt',
      `戦略を変更して新しいChatGPT会話へ引き継ぎ pass=${strategyResets + 1}`,
      statePayload({ errorClass })
    );
    console.error(`[strategy reset ${strategyResets + 1}] ${reason}`);
    return true;
  };

  const updateNoProgress = () => {
    const current = workspaceSnapshot(args.cwd);
    const newChanges = changedFilesBetween(initialSnapshot, current);
    for (const file of newChanges) changedFiles.add(file);
    const controllerIsWorking = phase !== 'INSPECT';
    if (current.digest === lastSnapshot.digest && controllerIsWorking && !verificationPassed) noProgressTurns += 1;
    else noProgressTurns = 0;
    lastSnapshot = current;
    return noProgressTurns >= MAX_NO_PROGRESS_TURNS;
  };

  while (true) {
    if (turns >= MAX_TURNS) {
      const reason = `Conversation turn budget reached: ${MAX_TURNS}`;
      if (await startFreshStrategy(reason, 'turn_budget', 'Start a new focused conversation from the current workspace.')) {
        continue;
      }
      await blockJob(reason, 'turn_budget');
      return;
    }
    turns += 1;
    console.log(`\nSending to ChatGPT... (turn ${turns})\n`);
    await reportProgress(args, 'sending_to_chatgpt', 'ChatGPTへ送信中 turn=' + turns, statePayload({}));
    await reportProgress(args, 'waiting_chatgpt', 'ChatGPT回答待ち turn=' + turns, statePayload({}));
    const sentPrompt = compactContext(prompt);
    const sentAt = new Date().toISOString();
    const response = ask(sentPrompt, isNew, args.sessionFile, args.sessionKey);
    isNew = false;
    const metadata = conversationMetadata(args);
    if (metadata.chatConversationUrl) {
      await reportProgress(
        args,
        'waiting_chatgpt',
        'ChatGPT会話をジョブへ保存 turn=' + turns,
        statePayload(metadata)
      );
    }

    if (/^\[ERROR\]/m.test(response)) {
      if (response.includes('MODEL_USAGE_LIMIT')) {
        await blockJob('Model usage limit detected. Automatic retry is disabled.', 'model_usage_limit');
        return;
      }
      if (response.includes('remained unresponsive after page reload and one resend')) {
        throw new Error('ChatGPT browser remained unresponsive after internal recovery; dispatcher restart required.');
      }
      throw new Error(`ChatGPT browser request failed: ${response}`);
    }

    console.log('── ChatGPT ──────────────────────────────────────────────\n');
    console.log(response);
    console.log('\n─────────────────────────────────────────────────────────');

    let runCmds = parseRunBlocks(response);
    const changes = parseFileBlocks(response);
    const patches = parsePatchBlocks(response);
    const edits = parseEditBlocks(response);
    const replacements = parseReplaceBlocks(response);
    const completed = response.includes(COMPLETE_MARKER);
    const mutationResults = [];
    await reportTurn(args, {
      turn: turns,
      sentAt,
      responseReceivedAt: new Date().toISOString(),
      prompt: sentPrompt,
      response,
      runCommands: runCmds,
      fileChanges: [
        ...edits.map(item => ({ path: item.path, contentLength: item.newText.length })),
        ...replacements.map(item => ({ path: item.path, contentLength: item.newText.length })),
        ...changes.map(item => ({ path: item.path, contentLength: item.content.length })),
      ],
    });

    if (edits.length || replacements.length || patches.length || changes.length) {
      if (phase === 'INSPECT') phase = 'PLAN';
      phase = 'EDIT';
      await reportProgress(args, 'writing_file', `${edits.length + replacements.length + patches.length + changes.length}件の構造化編集を適用中`, statePayload({}));
      mutationResults.push(...await applyEdits(edits, args.cwd));
      mutationResults.push(...await applyReplacements(replacements, args.cwd));
      mutationResults.push(...await applyPatches(patches, args.cwd));
      mutationResults.push(...await applyChanges(changes, args.cwd, args.auto));
      executionLog.push(buildCommandResults(mutationResults));
      const repeatedFailure = recordResults(mutationResults);
      if (repeatedFailure) {
        const reason = `Same failed operation repeated ${MAX_IDENTICAL_ERRORS} times: ${repeatedFailure.errorClass}`;
        if (await startFreshStrategy(reason, repeatedFailure.errorClass, repeatedFailure.evidence)) continue;
        await blockJob(reason, repeatedFailure.errorClass);
        return;
      }
      if (mutationResults.some(result => result.status !== 0)) {
        const failureDetail = buildCommandResults(mutationResults);
        console.error(`\n[structured edit failed]\n${failureDetail}`);
        prompt = `Structured edit failed. Do not repeat the same operation. Re-read only a small unique target range, then send one corrected PATCH/EDIT or a complete FILE replacement:\n\n${failureDetail}`;
        if (updateNoProgress()) {
          const reason = `No acceptance progress for ${MAX_NO_PROGRESS_TURNS} consecutive turns.`;
          if (await startFreshStrategy(reason, 'no_progress', buildCommandResults(mutationResults))) continue;
          await blockJob(reason, 'no_progress');
          return;
        }
        continue;
      }
      if (mutationResults.length > 0) {
        hasEdited = true;
        verificationPassed = false;
        inspectTurns = 0;
      }
    }

    const hostOnlyCommands = runCmds.filter(command => isHostOnlyCommand(command, args));
    if (hostOnlyCommands.length > 0) {
      const notice = [
        'HOST_ONLY_COMMAND_DEFERRED: the sandbox cannot inspect or run host deployment paths.',
        'The host dispatcher will deploy automatically after workspace verification and TASK_COMPLETE.',
        ...hostOnlyCommands.map(command => `$ ${command}`),
      ].join('\n');
      executionLog.push(notice);
      console.log(`\n${notice}`);
      runCmds = runCmds.filter(command => !isHostOnlyCommand(command, args));
      if (runCmds.length === 0) {
        phase = hasEdited ? 'TEST' : 'PLAN';
        prompt = notice + '\nContinue only in /mnt/workspace. Implement or verify the requested change, then emit TASK_COMPLETE.';
        continue;
      }
    }

    if (runCmds.length > 0) {
      const verificationCommands = runCmds.every(isVerificationCommand);
      phase = verificationCommands ? 'TEST' : (hasEdited ? 'TEST' : 'INSPECT');
      await reportProgress(
        args,
        verificationCommands ? 'verifying' : 'executing_command',
        `${runCmds.length}件の${verificationCommands ? '検証' : 'Ubuntu'}コマンドを実行中`,
        statePayload({})
      );
      const results = await execCommands(
        runCmds,
        args.cwd,
        args.auto,
        command => reportProgress(
          args,
          isVerificationCommand(command) ? 'verifying' : 'executing_command',
          'Ubuntuコマンド実行中',
          statePayload({ currentCommand: command.slice(0, 2000) })
        ),
        commandFailures
      );
      const resultText = buildCommandResults(results);
      executionLog.push(resultText);
      const repeatedFailure = recordResults(results);
      if (repeatedFailure) {
        const reason = `Same failed operation repeated ${MAX_IDENTICAL_ERRORS} times: ${repeatedFailure.errorClass}`;
        if (await startFreshStrategy(reason, repeatedFailure.errorClass, repeatedFailure.evidence)) continue;
        await blockJob(reason, repeatedFailure.errorClass);
        return;
      }
      if (verificationCommands) {
        verificationLog.push(resultText);
        verificationPassed = results.every(result => result.status === 0);
      }
      if (!hasEdited && !verificationCommands) {
        inspectTurns += 1;
        if (inspectTurns >= MAX_INSPECT_TURNS) {
          const reason = `Inspection loop reached ${MAX_INSPECT_TURNS} command turns without an implementation action.`;
          if (await startFreshStrategy(reason, 'inspection_loop', resultText)) continue;
          await blockJob(reason, 'inspection_loop');
          return;
        }
      }
      prompt = `Command results:\n\n${resultText}`;
      if (updateNoProgress()) {
        const reason = `No acceptance progress for ${MAX_NO_PROGRESS_TURNS} consecutive turns.`;
        if (await startFreshStrategy(reason, 'no_progress', resultText)) continue;
        await blockJob(reason, 'no_progress');
        return;
      }
      continue;
    }

    if (completed) {
      if (hasEdited && !verificationPassed) {
        prompt = `Completion rejected by the controller: edited files require a successful verification command. Run the smallest relevant syntax and regression tests now.`;
        if (updateNoProgress()) {
          const reason = `No acceptance progress for ${MAX_NO_PROGRESS_TURNS} consecutive turns.`;
          if (await startFreshStrategy(reason, 'no_progress', prompt)) continue;
          await blockJob(reason, 'no_progress');
          return;
        }
        continue;
      }
      phase = 'VERIFY';
      await reportProgress(args, 'verifying', '機械的完了条件を確認', statePayload({}));
      await reportResult(args, {
        status: 'done',
        lastError: '',
        workerLog: '',
        finalAnswer: cleanFinalAnswer(response),
        executionResult: compactOutput(executionLog.join('\n\n')) || 'No Ubuntu command output was produced.',
        verificationResult: compactOutput(verificationLog.join('\n\n')) || 'Read-only task completed without file edits.',
      });
      console.log(`\n${COMPLETE_MARKER}`);
      return;
    }

    phase = hasEdited ? 'TEST' : 'PLAN';
    prompt = `No valid action or completion marker was found. Continue from phase ${phase}. Use short RUN, PATCH, EDIT, or a complete FILE block. Remaining turns: ${MAX_TURNS - turns}.`;
    if (updateNoProgress()) {
      const reason = `No acceptance progress for ${MAX_NO_PROGRESS_TURNS} consecutive turns.`;
      if (await startFreshStrategy(reason, 'no_progress', response)) continue;
      await blockJob(reason, 'no_progress');
      return;
    }
  }

}

main().catch(async err => {
  const args = parseArgs(process.argv.slice(2));
  await reportResult(args, {
    status: 'failed',
    lastError: err instanceof Error ? err.message : String(err),
    workerLog: '',
    finalAnswer: '',
    executionResult: '',
    verificationResult: '',
  });
  console.error(err);
  process.exit(1);
});
