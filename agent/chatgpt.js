#!/usr/bin/env node
/**
 * chatgpt.js — Fast persistent-browser Codex-style CLI backed by chatgpt.com
 *
 * The browser runs as a background daemon so the launch/navigation overhead
 * only happens once. Subsequent calls take ~2-5s (ChatGPT response time only).
 *
 * Setup (first time):
 *   node chatgpt.js --login
 *
 * Usage:
 *   node chatgpt.js "prompt"                              # continue last chat
 *   node chatgpt.js --new "prompt"                        # start fresh chat
 *   node chatgpt.js --code "write fizzbuzz in Go"         # extract code only
 *   node chatgpt.js --file <path> "prompt"                # attach a file
 *   node chatgpt.js --git "write a commit message"        # attach git context
 *   node chatgpt.js --context "we use Fiber v2" "prompt"  # inline context
 *   cat error.log | node chatgpt.js "what is wrong"       # pipe input
 *   node chatgpt.js --status                              # check daemon
 *   node chatgpt.js --stop                                # kill daemon
 */

const path                = require('path');
const os                  = require('os');
const fs                  = require('fs');
const http                = require('http');
const readline            = require('readline');
const { execSync, spawn } = require('child_process');

const browserClientPath = process.env.PSEUDO_CODEX_BROWSER_CLIENT || '';
const browserClient = browserClientPath
  ? require(path.resolve(browserClientPath))
  : null;
let puppeteer = null;

function getPuppeteer() {
  if (puppeteer) return puppeteer;
  const { addExtra } = require('puppeteer-extra');
  const puppeteerCore = require('puppeteer-core');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer = addExtra(puppeteerCore);
  puppeteer.use(StealthPlugin());
  return puppeteer;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CHROME_PATH      = '/usr/bin/google-chrome';
const PROFILE_DIR      = path.join(os.homedir(), '.chatgpt-poc-profile');
const SESSION_FILE     = path.join(os.homedir(), '.chatgpt-poc-session');
const DAEMON_FILE      = path.join(os.homedir(), '.chatgpt-poc-daemon.json');
const DAEMON_LOG       = path.join(os.homedir(), '.chatgpt-poc-daemon.log');
const CHATGPT_URL      = 'https://chatgpt.com';
const RESPONSE_TIMEOUT = Number.parseInt(
  process.env.CHATGPT_RESPONSE_TIMEOUT_MS || '60000',
  10
);
const RECOVERY_RESPONSE_TIMEOUT = Number.parseInt(
  process.env.CHATGPT_RECOVERY_TIMEOUT_MS || '60000',
  10
);

function readSessionUrl(sessionFile) {
  return fs.existsSync(sessionFile)
    ? fs.readFileSync(sessionFile, 'utf8').trim()
    : CHATGPT_URL;
}

function newChatUrl() {
  // ChatGPT redirects GPT project paths to their non-chat /project view.
  // That page can render a textarea but does not create a conversation, so
  // every isolated job must begin at the normal conversation endpoint.
  return CHATGPT_URL;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are a senior software engineer acting as a coding assistant.
Rules:
- Be concise. Code over explanation.
- Write complete, working, production-quality code.
- Match the language, style, and patterns of any provided code or context.
- When fixing code show only the corrected version, no before/after commentary.
- No disclaimers, caveats, or filler text.
- If the task is ambiguous, pick the most reasonable interpretation and go.
---
`;

// ─── Prompt builders ──────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim() || null));
  });
}

function readFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return fs.readFileSync(abs, 'utf8');
}

function getGitContext(cwd) {
  const run = cmd => { try { return execSync(cmd, { encoding: 'utf8', cwd }).trim(); } catch { return ''; } };
  const branch = run('git branch --show-current');
  const status = run('git status --short');
  const diff   = run('git diff HEAD');
  if (!branch && !status && !diff) throw new Error('Not inside a git repo or no changes found.');
  let out = '';
  if (branch) out += `Branch: ${branch}\n`;
  if (status) out += `\nStatus:\n${status}\n`;
  if (diff)   out += `\nDiff:\n${diff}\n`;
  return out;
}

function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```[\w]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trimEnd());
  return blocks.length > 0 ? blocks.join('\n\n') : text;
}

function buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData }) {
  const parts = [SYSTEM_PROMPT];
  if (contextData) parts.push(`Context:\n${contextData}\n`);
  if (gitData)     parts.push(`Git context:\n${gitData}\n`);
  if (fileData)    parts.push(`File content:\n\`\`\`\n${fileData}\n\`\`\`\n`);
  if (stdinData)   parts.push(`Input:\n\`\`\`\n${stdinData}\n\`\`\`\n`);
  parts.push(`Task: ${userPrompt}`);
  return parts.join('\n');
}

// ─── Browser helpers (daemon-side only) ───────────────────────────────────────

/**
 * Upload a local file to ChatGPT via direct CDP file-input injection.
 *
 * The ChatGPT composer always has a hidden <input id="upload-files"> in the DOM.
 * Puppeteer's uploadFile() uses the Chrome DevTools Protocol to set files on
 * the input element without needing a native file-picker dialog (which requires
 * a real user gesture and cannot be triggered programmatically in headless mode).
 * After setting the files via CDP we fire a synthetic change event so React's
 * event system picks up the new FileList and registers the attachment.
 */
async function uploadFileToChatGPT(page, uploadPath, log) {
  const abs = path.resolve(uploadPath);
  if (!fs.existsSync(abs)) throw new Error(`Upload file not found: ${abs}`);
  log(`Uploading file: ${abs}`);

  // Wait for the hidden file input to be present in the DOM
  const inputHandle = await page.waitForSelector('#upload-files', { timeout: 8_000 });

  // CDP-level file injection — no dialog needed
  await inputHandle.uploadFile(abs);

  // Notify React that the input's FileList changed
  await page.evaluate(() => {
    const el = document.getElementById('upload-files');
    if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Give ChatGPT's React handler a moment to process the file and render a preview
  await new Promise(r => setTimeout(r, 2_000));

  // ChatGPT may show a "You've already uploaded this file" warning dialog when
  // the same file has been uploaded recently.  Dismiss it so the flow continues.
  const dialog = await page.$('[role="dialog"]');
  if (dialog) {
    const dialogText = await page.evaluate(el => el.textContent.trim().slice(0, 120), dialog);
    log(`Dismissing dialog: "${dialogText}"`);
    const okBtn = await page.$('[role="dialog"] button');
    if (okBtn) await okBtn.click();
    await new Promise(r => setTimeout(r, 800));
  }

  log('Upload complete.');
}

function launchBrowser() {
  if (browserClient && typeof browserClient.launchBrowser === 'function') {
    return browserClient.launchBrowser();
  }
  return getPuppeteer().launch({
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_DIR,
    headless: false,
    // Complex repair turns can exceed Puppeteer's default 180-second CDP call limit.
    protocolTimeout: 600_000,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-extensions-except=',
    ],
    defaultViewport: null,
  });
}

// Single DOM operation — no keystroke simulation, no chunking, no delay.
// execCommand('insertText') is the fastest reliable way to fill a
// React-controlled contenteditable without breaking its event listeners.
async function fillTextarea(page, text) {
  await page.waitForSelector('#prompt-textarea', { timeout: 10_000 });
  await page.click('#prompt-textarea');
  await page.evaluate(t => {
    const el = document.querySelector('#prompt-textarea');
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, t);
  }, text);
}

async function snapshotAssistantState(page) {
  return page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    return {
      count: msgs.length,
      lastText: msgs.length > 0 ? (msgs[msgs.length - 1].innerText || '').trim() : '',
    };
  });
}

async function waitForStreamingDone(page, log, beforeState, timeoutMs = RESPONSE_TIMEOUT) {
  // ChatGPT sometimes reuses the previous assistant DOM node instead of adding
  // a new one. Track both count and text so either UI behavior is supported.
  if (beforeState === undefined) {
    beforeState = await snapshotAssistantState(page);
  }
  const deadline = Date.now() + timeoutMs;
  log(`waitForStreamingDone: beforeCount=${beforeState.count}`);

  // Phase 1 — wait for a new assistant message to appear (ChatGPT started replying).
  // polling:1000 reduces CDP round-trips on heavy pages and avoids
  // "Runtime.callFunctionOn timed out" errors that occur with the default 100ms poll.
  await page.waitForFunction(
    before => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (msgs.length === 0) return false;
      const lastText = (msgs[msgs.length - 1].innerText || '').trim();
      return lastText.length > 0 && (msgs.length > before.count || lastText !== before.lastText);
    },
    { timeout: timeoutMs, polling: 1_000 },
    beforeState
  ).catch(async err => {
    // On timeout, dump the DOM state to the log for debugging
    const dump = await page.evaluate(() => {
      const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
        .map(el => el.innerText.trim().slice(0, 100));
      const allRoles = [...document.querySelectorAll('[data-message-author-role]')]
        .map(el => `${el.getAttribute('data-message-author-role')}: ${(el.innerText||'').trim().slice(0,80)}`);
      const buttons = [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim().slice(0,30)).filter(Boolean);
      const url = location.href;
      return { assistants, allRoles, buttons: buttons.slice(0,15), url };
    }).catch(() => ({ error: 'page.evaluate failed' }));
    log(`waitForStreamingDone TIMEOUT dump: ${JSON.stringify(dump)}`);
    throw err;
  });

  // Phase 2 — wait for ChatGPT to add the completed-turn action buttons.
  // Text-length stability is not sufficient: the current UI can display the
  // temporary word "Thinking" long enough to look like a finished response.
  const remaining = Math.max(1_000, deadline - Date.now());
  await page.waitForFunction(
    before => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (msgs.length === 0) return false;
      const lastMessage = msgs[msgs.length - 1];
      const lastText = (lastMessage.innerText || '').trim();
      if (lastText.length === 0) return false;
      if (msgs.length <= before.count && lastText === before.lastText) return false;
      const turn = lastMessage.closest('[data-turn="assistant"]');
      return !!turn?.querySelector(
        'button[data-testid="copy-turn-action-button"][aria-label="Copy response"]'
      );
    },
    { timeout: remaining, polling: 500 },
    beforeState
  );
}

async function submitPrompt(page, fullPrompt, log) {
  await fillTextarea(page, fullPrompt);
  const beforeState = await snapshotAssistantState(page);
  const clicked = await page.evaluate(() => {
    const button = document.querySelector('button[data-testid="send-button"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  });
  if (clicked) {
    log('Submitted via send button');
  } else {
    await page.focus('#prompt-textarea');
    await page.keyboard.press('Enter');
    log('Send button unavailable; submitted via Enter key');
  }
  return beforeState;
}

async function pageIsStreaming(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('button')].some(button => {
      const label = (button.getAttribute('aria-label') || '').toLowerCase();
      const testId = (button.getAttribute('data-testid') || '').toLowerCase();
      return testId.includes('stop') || label.includes('stop generating') || label.includes('応答を停止');
    });
  });
}

async function detectUsageLimit(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const patterns = [
      /usage limit/i,
      /rate limit/i,
      /token limit/i,
      /limit reached/i,
      /try again later/i,
      /reset(?:s)? at/i,
      /upgrade to continue/i,
      /利用上限/,
      /制限に達し/,
    ];
    const match = patterns.find(pattern => pattern.test(text));
    if (!match) return '';
    const index = text.search(match);
    return text.slice(Math.max(0, index - 120), index + 500);
  }).catch(() => '');
}

async function waitWithRecovery(page, fullPrompt, log, beforeState) {
  try {
    await waitForStreamingDone(page, log, beforeState, RESPONSE_TIMEOUT);
    return;
  } catch (initialError) {
    const usageLimit = await detectUsageLimit(page);
    if (usageLimit) {
      throw new Error(`MODEL_USAGE_LIMIT: ${usageLimit}`);
    }
    log(`No completed response after ${RESPONSE_TIMEOUT}ms; reloading the ChatGPT page once.`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('#prompt-textarea', { timeout: 20_000 });
    await new Promise(resolve => setTimeout(resolve, 3_000));

    const reloadedUsageLimit = await detectUsageLimit(page);
    if (reloadedUsageLimit) {
      throw new Error(`MODEL_USAGE_LIMIT: ${reloadedUsageLimit}`);
    }

    if (await pageIsStreaming(page)) {
      log('Generation is still active after reload; waiting without duplicate submission.');
      await waitForStreamingDone(page, log, beforeState, RECOVERY_RESPONSE_TIMEOUT);
      return;
    }

    const stateAfterReload = await snapshotAssistantState(page);
    if (
      stateAfterReload.count > beforeState.count ||
      stateAfterReload.lastText !== beforeState.lastText
    ) {
      log('A response appeared after reload; waiting for completion.');
      await waitForStreamingDone(page, log, beforeState, RECOVERY_RESPONSE_TIMEOUT);
      return;
    }

    log('No response is active after reload; resubmitting the same prompt once.');
    const retryState = await submitPrompt(page, fullPrompt, log);
    try {
      await waitForStreamingDone(page, log, retryState, RECOVERY_RESPONSE_TIMEOUT);
    } catch (retryError) {
      throw new Error(
        `ChatGPT remained unresponsive after page reload and one resend: ${retryError.message}`,
        { cause: initialError }
      );
    }
  }
}

async function navigateWithRetry(page, targetUrl, log) {
  const safeUrl = String(targetUrl || CHATGPT_URL).startsWith('https://chatgpt.com')
    ? String(targetUrl || CHATGPT_URL)
    : CHATGPT_URL;
  try {
    await page.goto(safeUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
  } catch (initialError) {
    log(`Navigation failed once for ${safeUrl}: ${initialError.message}; retrying once.`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.goto(safeUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
  }
}

function conversationDetails(url) {
  const value = String(url || '');
  const match = value.match(/\/c\/([^/?#]+)/);
  return {
    conversationUrl: value,
    conversationId: match ? match[1] : '',
  };
}

async function extractLastAssistantMessage(page) {
  return page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (msgs.length > 0) return msgs[msgs.length - 1].innerText.trim();
    const blocks = document.querySelectorAll('.markdown, .prose');
    if (blocks.length > 0) return blocks[blocks.length - 1].innerText.trim();
    return null;
  });
}

// ─── Daemon process ───────────────────────────────────────────────────────────

async function startDaemonProcess() {
  const logStream = fs.createWriteStream(DAEMON_LOG, { flags: 'a' });
  const log = msg => logStream.write(`[${new Date().toISOString()}] ${msg}\n`);

  log('Daemon starting...');

  let browser;
  let defaultPage;
  const sessions = new Map();
  try {
    browser = await launchBrowser();
    defaultPage = await browser.newPage();

    const initUrl = fs.existsSync(SESSION_FILE)
      ? fs.readFileSync(SESSION_FILE, 'utf8').trim()
      : CHATGPT_URL;

    log(`Navigating to ${initUrl}`);
    await navigateWithRetry(defaultPage, initUrl, log);

    if (!browserClient) {
      const loggedOut = await defaultPage.evaluate(() => {
        const hasLoginBtn = [...document.querySelectorAll('button, a')]
          .some(el => ['Log in', 'Sign in'].includes(el.textContent.trim()));
        const hasInput = !!document.querySelector('#prompt-textarea');
        return hasLoginBtn && !hasInput;
      });

      if (loggedOut) {
        log('ERROR: Not logged in. Run: node chatgpt.js --login');
        await browser.close();
        process.exit(1);
      }
    }

    sessions.set('default', Promise.resolve({
      page: defaultPage,
      tail: Promise.resolve(),
      conversationUrl: initUrl,
    }));
    log('Browser ready and logged in.');
  } catch (err) {
    log(`Startup error: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }

  const getSession = async (key, activeSessionFile) => {
    if (!sessions.has(key)) {
      sessions.set(key, (async () => {
        const page = await browser.newPage();
        const initialUrl = readSessionUrl(activeSessionFile);
        await navigateWithRetry(page, initialUrl, log);
        return { page, tail: Promise.resolve(), conversationUrl: initialUrl };
      })());
    }
    return sessions.get(key);
  };

  const enqueue = (state, task) => {
    const current = state.tail.catch(() => {}).then(task);
    state.tail = current.catch(() => {});
    return current;
  };

  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url === '/status') {
      return send(200, { ok: true, pid: process.pid, activeSessions: sessions.size });
    }

    if (req.method === 'POST' && req.url === '/stop') {
      send(200, { ok: true });
      log('Shutting down...');
      server.close();
      await browser.close().catch(() => {});
      if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      process.exit(0);
    }

    if (req.method === 'POST' && req.url === '/ask') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const {
            fullPrompt,
            codeOnly,
            newChat,
            uploadPath,
            sessionFile,
            sessionKey,
          } = payload;
          const activeSessionFile = sessionFile || SESSION_FILE;
          const key = String(
            sessionKey || (activeSessionFile === SESSION_FILE ? 'default' : activeSessionFile)
          ).slice(0, 500);
          const state = await getSession(key, activeSessionFile);
          const result = await enqueue(state, async () => {
            const page = state.page;
            const sessionUrl = state.conversationUrl || readSessionUrl(activeSessionFile);
            log(`ask: sessionKey=${key} newChat=${newChat} codeOnly=${codeOnly} upload=${uploadPath || 'none'} len=${String(fullPrompt || '').length}`);

            const currentUrl = page.url();
            if (newChat) {
              log(`Starting new chat for sessionKey=${key}`);
              await navigateWithRetry(
                page,
                activeSessionFile === SESSION_FILE ? CHATGPT_URL : newChatUrl(),
                log
              );
            } else if (currentUrl !== sessionUrl) {
              log(`Switching session ${key} to ${sessionUrl}`);
              await navigateWithRetry(page, sessionUrl, log);
            }

            let raw;
            if (browserClient && typeof browserClient.send === 'function') {
              const adapterResult = await browserClient.send({
                page,
                fullPrompt,
                codeOnly,
                newChat,
                uploadPath,
                sessionKey: key,
                sessionFile: activeSessionFile,
                log,
              });
              raw = adapterResult && typeof adapterResult === 'object'
                ? adapterResult.response
                : adapterResult;
            } else {
              if (uploadPath) await uploadFileToChatGPT(page, uploadPath, log);
              if (uploadPath) {
                log('Waiting for send button to become enabled (file upload in progress)...');
                await page.waitForFunction(
                  () => {
                    const btn = document.querySelector('button[data-testid="send-button"]');
                    return btn && !btn.disabled;
                  },
                  { timeout: 60_000 }
                );
                log('Send button is now enabled.');
              }

              const beforeState = await submitPrompt(page, fullPrompt, log);
              log('Prompt sent, waiting for response...');
              await waitWithRecovery(page, fullPrompt, log, beforeState);
              raw = await extractLastAssistantMessage(page);
            }

            const finalUrl = page.url();
            state.conversationUrl = finalUrl;
            if (conversationDetails(finalUrl).conversationId) {
              fs.mkdirSync(path.dirname(activeSessionFile), { recursive: true });
              fs.writeFileSync(activeSessionFile, finalUrl, { encoding: 'utf8', mode: 0o600 });
              fs.chmodSync(activeSessionFile, 0o600);
            }

            if (!raw) throw new Error('Could not extract response from page');
            const output = codeOnly ? extractCodeBlocks(raw) : raw;
            const details = conversationDetails(finalUrl);
            log(`Done: sessionKey=${key} conversation=${details.conversationId || 'none'} chars=${output.length}`);
            return {
              ok: true,
              response: output,
              conversationId: details.conversationId,
              conversationUrl: details.conversationUrl,
              workerSessionId: key,
            };
          });
          send(200, result);
        } catch (err) {
          log(`Error: ${err.message}`);
          send(500, { ok: false, error: err.message });
        }
      });
      return;
    }

    send(404, { ok: false, error: 'Not found' });
  });

  server.on('error', err => {
    log(`HTTP server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    log(`HTTP server listening on 127.0.0.1:${port}`);
    fs.writeFileSync(DAEMON_FILE, JSON.stringify({ port, pid: process.pid }), 'utf8');
    log('Daemon ready.');
  });

  const shutdown = async signalName => {
    log(`${signalName} received, shutting down`);
    if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ─── Client helpers ───────────────────────────────────────────────────────────

function readDaemonState() {
  const forcedPort = Number.parseInt(process.env.CHATGPT_DAEMON_PORT || '', 10);
  if (Number.isInteger(forcedPort) && forcedPort > 0 && forcedPort <= 65535) {
    return { port: forcedPort, pid: null, external: true };
  }

  if (!fs.existsSync(DAEMON_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
    process.kill(state.pid, 0); // throws if PID is dead
    return state;
  } catch {
    return null;
  }
}

function httpPost(port, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error('Invalid JSON from daemon')); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function ensureDaemon() {
  let state = readDaemonState();
  if (state) return state.port;

  if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE); // clean stale file

  process.stderr.write('[*] Starting browser daemon (first time ~15s)...\n');

  const child = spawn(process.execPath, [__filename, '--daemon-internal'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1_000));
    state = readDaemonState();
    if (state) {
      await new Promise(r => setTimeout(r, 300)); // let HTTP server bind
      process.stderr.write('[*] Daemon ready.\n');
      return state.port;
    }
  }

  throw new Error('Daemon did not start. Check: cat ~/.chatgpt-poc-daemon.log');
}

// ─── Login (one-time setup, no daemon) ───────────────────────────────────────

function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function login() {
  console.log('[*] Opening Chrome for login...');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(CHATGPT_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
  console.log('');
  console.log('  Log in to chatgpt.com in the Chrome window that opened.');
  console.log('  When fully logged in and the chat interface is visible,');
  await waitForEnter('  press Enter here to save the session: ');
  await browser.close();
  console.log('[*] Done. Run: node chatgpt.js "your prompt here"');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    login: false, codeOnly: false, file: null, upload: null, save: null,
    git: false, context: null, newChat: false, start: false, stop: false, status: false,
    daemonInternal: false, cwd: null, sessionFile: null, sessionKey: null, promptFile: null, prompt: [],
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--login':           opts.login          = true;  break;
      case '--code':            opts.codeOnly       = true;  break;
      case '--git':             opts.git            = true;  break;
      case '--new':             opts.newChat        = true;  break;
      case '--start':           opts.start          = true;  break;
      case '--stop':            opts.stop           = true;  break;
      case '--status':          opts.status         = true;  break;
      case '--daemon-internal': opts.daemonInternal = true;  break;
      case '--file':            opts.file    = args[++i];    break;
      case '--upload':          opts.upload  = args[++i];    break;
      case '--save':            opts.save    = args[++i];    break;
      case '--context':         opts.context = args[++i];    break;
      case '--cwd':             opts.cwd     = args[++i];    break;
      case '--session-file':    opts.sessionFile = args[++i]; break;
      case '--session-key':     opts.sessionKey = args[++i];  break;
      case '--prompt-file':     opts.promptFile = args[++i];  break;
      default:                  opts.prompt.push(args[i]);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage:
  node chatgpt.js --login                               # first-time setup
  node chatgpt.js "prompt"                              # continue last chat (daemon auto-starts)
  node chatgpt.js --new "prompt"                        # force a new chat
  node chatgpt.js --code "write fizzbuzz in Go"         # extract code blocks only
  node chatgpt.js --file <path> "prompt"                # paste file content as text in prompt
  node chatgpt.js --upload <path> "prompt"              # upload file via ChatGPT attachment button
  node chatgpt.js --save <path> "prompt"                # save response to a file
  node chatgpt.js --git "write a commit message"        # attach git diff/status
  node chatgpt.js --context "we use Fiber v2" "prompt"  # inline context
  cat error.log | node chatgpt.js "what is wrong"       # pipe input
  node chatgpt.js --status                              # check if daemon is running
  node chatgpt.js --start                               # start daemon without sending a prompt
  node chatgpt.js --stop                                # shut down the daemon
`);
}

(async () => {
  const opts = parseArgs(process.argv);

  if (opts.daemonInternal) {
    await startDaemonProcess(); // never returns
    return;
  }

  if (opts.login) {
    await login().catch(err => { console.error('[ERROR]', err.message); process.exit(1); });
    return;
  }

  if (opts.start) {
    const port = await ensureDaemon();
    console.log(`[*] Daemon ready on 127.0.0.1:${port}`);
    return;
  }

  if (opts.stop) {
    const state = readDaemonState();
    if (!state) { console.log('[*] No daemon running.'); return; }
    try {
      await httpPost(state.port, '/stop', {});
      console.log('[*] Daemon stopped.');
    } catch {
      if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      console.log('[*] Daemon stopped.');
    }
    return;
  }

  if (opts.status) {
    const state = readDaemonState();
    if (!state) { console.log('[*] Daemon not running.'); return; }
    console.log(`[*] Daemon running — PID ${state.pid}, port ${state.port}`);
    return;
  }

  if (opts.prompt.length === 0 && !opts.promptFile) {
    printHelp();
    process.exit(1);
  }

  const userPrompt  = opts.promptFile ? readFile(opts.promptFile) : opts.prompt.join(' ');
  const stdinData   = await readStdin();
  const fileData    = opts.file    ? readFile(opts.file)  : null;
  const gitData     = opts.git     ? getGitContext(opts.cwd || process.cwd()) : null;
  const contextData = opts.context || null;

  const fullPrompt = buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData });

  try {
    const port   = await ensureDaemon();
    const result = await httpPost(port, '/ask', {
      fullPrompt, codeOnly: opts.codeOnly, newChat: opts.newChat,
      uploadPath: opts.upload || null, sessionFile: opts.sessionFile,
      sessionKey: opts.sessionKey,
    });
    if (!result.ok) throw new Error(result.error || 'Daemon returned an error');
    console.log('\n--- RESPONSE ---');
    console.log(result.response);
    console.log('--- END ---\n');
    if (opts.save) {
      fs.writeFileSync(path.resolve(opts.save), result.response, 'utf8');
      console.error(`[*] Response saved to: ${path.resolve(opts.save)}`);
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    process.exit(1);
  }
})();
