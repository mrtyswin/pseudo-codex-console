from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_between(text: str, start: str, end: str, new: str, label: str) -> str:
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f"{label}: start marker not found")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f"{label}: end marker not found")
    return text[:start_index] + new + text[end_index:]


# app.js
app_path = Path("app.js")
app = app_path.read_text(encoding="utf-8")

app = replace_once(
    app,
    '''return {
workerId: String(value.workerId || "").trim().slice(0, 200),
sessionId: String(value.sessionId || "").trim().slice(0, 200),
pid: boundedInteger(value.pid, 1, 2147483647, null),
leaseSeconds: boundedInteger(value.leaseSeconds, 30, 86400, 300)
};''',
    '''return {
workerId: String(value.workerId || "").trim().slice(0, 200),
sessionId: String(value.sessionId || "").trim().slice(0, 200),
pid: boundedInteger(value.pid, 1, 2147483647, null),
leaseSeconds: boundedInteger(value.leaseSeconds, 30, 86400, 300),
excludedProjects: Array.isArray(value.excludedProjects)
? value.excludedProjects.map(String).filter(function(project) {
return PROJECT_PATTERN.test(project);
}).slice(0, 100)
: []
};''',
    "worker request exclusions",
)

app = replace_once(
    app,
    ''' errorClass: String(value.errorClass || "").slice(0, 200),
 checkpoint: String(value.checkpoint || "").slice(0, 20000)
};''',
    ''' errorClass: String(value.errorClass || "").slice(0, 200),
 checkpoint: String(value.checkpoint || "").slice(0, 20000),
 chatConversationId: String(value.chatConversationId || "").slice(0, 300),
 chatConversationUrl: String(value.chatConversationUrl || "").slice(0, 2000),
 workerSessionId: String(value.workerSessionId || "").slice(0, 300)
};''',
    "progress conversation fields",
)

app = replace_once(
    app,
    '''checkpoint: compactText(source.checkpoint, 20000),
conversationTurns,
history''',
    '''checkpoint: compactText(source.checkpoint, 20000),
chatConversationId: compactText(source.chatConversationId, 300),
chatConversationUrl: compactText(source.chatConversationUrl, 2000),
workerSessionId: compactText(source.workerSessionId, 300),
parentJobId: compactText(source.parentJobId, 200),
rootJobId: compactText(source.rootJobId, 200) || normalizeString(source.id),
autoHandoffDepth: Number.isSafeInteger(source.autoHandoffDepth) && source.autoHandoffDepth >= 0
? source.autoHandoffDepth
: 0,
autoHandoffCreatedAt: normalizeOptionalDate(source.autoHandoffCreatedAt),
sourceFailureStage: compactText(source.sourceFailureStage, 100),
sourceErrorClass: compactText(source.sourceErrorClass, 200),
sourceCheckpointKey: compactText(source.sourceCheckpointKey, 200),
continuationJobId: compactText(source.continuationJobId, 200),
autoHandoffStatus: compactText(source.autoHandoffStatus, 500),
autoHandoffKey: compactText(source.autoHandoffKey, 200),
forceNewConversation: source.forceNewConversation === true,
conversationTurns,
history''',
    "normalize continuation fields",
)

app = replace_once(
    app,
    '''errorClass: "",
checkpoint: "",
conversationTurns: [],''',
    '''errorClass: "",
checkpoint: "",
chatConversationId: "",
chatConversationUrl: "",
workerSessionId: "",
parentJobId: "",
rootJobId: "",
autoHandoffDepth: 0,
autoHandoffCreatedAt: "",
sourceFailureStage: "",
sourceErrorClass: "",
sourceCheckpointKey: "",
continuationJobId: "",
autoHandoffStatus: "",
autoHandoffKey: "",
forceNewConversation: false,
conversationTurns: [],''',
    "new job continuation defaults",
)

app = replace_once(
    app,
    '''if (
    job.status !== "queued" ||
    job.stage !== "queued" ||
    job.kind === "test" ||
    job.isTest === true
  ) {''',
    '''if (
    job.status !== "queued" ||
    job.stage !== "queued" ||
    job.kind === "test" ||
    job.isTest === true ||
    worker.excludedProjects.includes(job.project)
  ) {''',
    "claim project exclusion",
)

app = replace_once(
    app,
    '''if (progress.errorClass) job.errorClass = progress.errorClass;
if (progress.checkpoint) job.checkpoint = progress.checkpoint;
if (job.workerId || progress.workerId) {''',
    '''if (progress.errorClass) job.errorClass = progress.errorClass;
if (progress.checkpoint) job.checkpoint = progress.checkpoint;
if (progress.chatConversationId) job.chatConversationId = progress.chatConversationId;
if (progress.chatConversationUrl) job.chatConversationUrl = progress.chatConversationUrl;
if (progress.workerSessionId) job.workerSessionId = progress.workerSessionId;
if (job.workerId || progress.workerId) {''',
    "save conversation metadata",
)

continuation_code = r'''function getAutoHandoffMax() {
const parsed = Number.parseInt(
process.env.PSEUDO_CODEX_AUTO_HANDOFF_MAX || "3",
10
);
return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 3;
}

function continuationFailureKey(job) {
const checkpointSource = job.checkpoint || job.updatedAt || job.id;
return crypto.createHash("sha1").update([
job.id,
checkpointSource,
job.errorClass || job.status || job.stage,
job.strategyPass || 1
].join("\n")).digest("hex");
}

function createContinuationJob(jobs, job, reason, automatic) {
if (
job.isTest ||
job.kind === "test" ||
job.stage === "stopped" ||
job.status === "cancelled" ||
job.stage === "completed"
) {
return null;
}

const depth = Number.isSafeInteger(job.autoHandoffDepth)
? job.autoHandoffDepth
: 0;
const maximum = getAutoHandoffMax();
if (depth >= maximum) {
job.autoHandoffStatus = "自動再引き継ぎ上限に到達";
job.autoHandoffCreatedAt = new Date().toISOString();
return null;
}

const key = continuationFailureKey(job);
const existing = jobs.find(function(candidate) {
return candidate.autoHandoffKey === key ||
candidate.id === job.continuationJobId;
});
if (existing) {
return existing;
}

const now = new Date().toISOString();
const assignment = deriveAssignment("queued");
const continuationId = crypto.randomUUID();
const recoveryInstruction = [
"このジョブは前の実装方法で行き詰まったため、新しいChatGPT会話で継続します。",
"成功済みの変更とチェックポイントを保持し、失敗した操作を繰り返さず、別の具体的な実装方法を選んでください。",
reason ? "継続理由: " + reason : "",
"",
buildChatGptHandoff(job)
].filter(Boolean).join("\n");

const continuation = normalizeJob({
id: continuationId,
project: job.project,
createdAt: now,
updatedAt: now,
attempts: 0,
lastError: "",
workerLog: "",
title: (job.title || "無題") + "（別の手で継続 " + (depth + 1) + "）",
instruction: recoveryInstruction,
kind: "job",
status: "queued",
stage: "queued",
assignee: assignment.assignee,
displayStatus: assignment.displayStatus,
result: "",
finalAnswer: "",
executionResult: "",
verificationResult: "",
workerId: "",
sessionId: "",
pid: null,
heartbeatAt: "",
activityAt: now,
leaseExpiresAt: "",
currentTurn: 0,
currentCommand: "",
phase: "INSPECT",
remainingTurns: 0,
strategyPass: 1,
inspectTurns: 0,
recoveryHistory: Array.isArray(job.recoveryHistory) ? job.recoveryHistory.slice() : [],
changedFiles: Array.isArray(job.changedFiles) ? job.changedFiles.slice() : [],
transactions: Array.isArray(job.transactions) ? job.transactions.slice() : [],
errorClass: "",
checkpoint: job.checkpoint || "",
parentJobId: job.id,
rootJobId: job.rootJobId || job.id,
autoHandoffDepth: depth + 1,
autoHandoffCreatedAt: now,
sourceFailureStage: job.stage,
sourceErrorClass: job.errorClass || job.status || job.stage,
sourceCheckpointKey: key,
autoHandoffKey: key,
forceNewConversation: true,
conversationTurns: [],
history: [{
at: now,
stage: "queued",
assignee: assignment.assignee,
message: automatic
? "失敗を検知し、別の手を聞く継続ジョブを自動登録"
: "Web GUIから別の手を聞く継続ジョブを登録"
}]
});

jobs.unshift(continuation);
job.continuationJobId = continuationId;
job.autoHandoffStatus = automatic
? "別の手を聞く継続ジョブを自動作成済み"
: "別の手を聞く継続ジョブを作成済み";
job.autoHandoffCreatedAt = now;
job.autoHandoffKey = key;
appendHistory(
job,
job.stage,
job.assignee,
job.autoHandoffStatus + " continuation=" + continuationId
);
return continuation;
}

function requestAlternativeJob(id) {
return mutateJobs(function(jobs) {
const job = jobs.find(function(candidate) {
return candidate.id === id;
});
if (!job) return null;
return createContinuationJob(
jobs,
job,
job.lastError || "Web GUIから別の実装方法を要求",
false
);
});
}

'''
app = replace_once(
    app,
    "function updateJobResult(id, result) {",
    continuation_code + "function updateJobResult(id, result) {",
    "continuation functions",
)

app = replace_once(
    app,
    '''} else {
applyStage(job, "queued", "再実行待ちへ戻す");
}

return job;

});
}''',
    '''} else {
applyStage(job, "queued", "再実行待ちへ戻す");
}

if (["failed", "blocked"].includes(job.stage)) {
createContinuationJob(
jobs,
job,
job.lastError || "最終失敗を検知",
true
);
}
return job;

});
}''',
    "automatic continuation trigger",
)

app = replace_once(
    app,
    '''function renderHandoffActions(job) {
return [
'<div class="handoff-actions">',
'<button type="button" data-copy-handoff data-job-id="', escapeHtml(job.id), '">',
"ChatGPT用引き継ぎをコピー",
"</button>",
'<a href="/api/jobs/', encodeURIComponent(job.id),
'/handoff" target="_blank" rel="noopener">Markdownを表示・保存</a>',
'<span data-handoff-status aria-live="polite"></span>',
"</div>"
].join("");
}''',
    '''function renderHandoffActions(job) {
const recoveryButton = ["failed", "blocked"].includes(job.stage)
? '<button type="button" data-recover-job data-job-id="' + escapeHtml(job.id) + '">別の手をChatGPTに聞く</button>'
: "";
return [
'<div class="handoff-actions">',
'<button type="button" data-copy-handoff data-job-id="', escapeHtml(job.id), '">',
"ChatGPT用引き継ぎをコピー",
"</button>",
recoveryButton,
'<a href="/api/jobs/', encodeURIComponent(job.id),
'/handoff" target="_blank" rel="noopener">Markdownを表示・保存</a>',
'<span data-handoff-status aria-live="polite"></span>',
"</div>"
].join("");
}

function renderRecoveryInfo(job) {
const values = [];
if (job.parentJobId) {
values.push('自動再引き継ぎジョブ · 深度 ' + escapeHtml(job.autoHandoffDepth) +
' · <a href="#job-' + escapeHtml(job.parentJobId) + '">元ジョブへ</a>');
}
if (job.continuationJobId) {
values.push(escapeHtml(job.autoHandoffStatus || "継続ジョブを作成済み") +
' · <a href="#job-' + escapeHtml(job.continuationJobId) + '">継続ジョブへ</a>');
} else if (job.autoHandoffStatus) {
values.push(escapeHtml(job.autoHandoffStatus));
}
return values.length ? '<div class="recovery-info">' + values.join('<br>') + '</div>' : "";
}''',
    "server recovery actions",
)

app = replace_once(
    app,
    ''''<article class="job" data-job-id="', escapeHtml(job.id), '" data-updated-at="', escapeHtml(job.updatedAt), '">',''',
    ''''<article id="job-', escapeHtml(job.id), '" class="job" data-job-id="', escapeHtml(job.id), '" data-updated-at="', escapeHtml(job.updatedAt), '">',''',
    "server card anchor",
)

app = replace_once(
    app,
    '''renderRuntime(job),
renderJobActions(job),
renderHandoffActions(job),''',
    '''renderRuntime(job),
renderRecoveryInfo(job),
renderJobActions(job),
renderHandoffActions(job),''',
    "server recovery info",
)

app = replace_once(
    app,
    '''".runtime{font-size:.82rem;color:#687386;overflow-wrap:anywhere}",
".job-actions{display:flex;gap:8px;margin-top:10px}.job-actions button{margin:0;padding:7px 12px;background:#5b6472}.job-actions button:disabled{opacity:.55;cursor:wait}",''',
    '''".runtime{font-size:.82rem;color:#687386;overflow-wrap:anywhere}",
".recovery-info{margin-top:10px;padding:9px 11px;border-left:4px solid #765600;background:#fff8df;color:#604800;font-size:.88rem}.recovery-info a{font-weight:700;color:#604800}",
".job-actions{display:flex;gap:8px;margin-top:10px}.job-actions button{margin:0;padding:7px 12px;background:#5b6472}.job-actions button:disabled{opacity:.55;cursor:wait}",''',
    "recovery css",
)

# CLIENT_JS additions
app = replace_once(
    app,
    '''function handoffActions(job) {
  var id = encodeURIComponent(job.id);
  return '<div class="handoff-actions"><button type="button" data-copy-handoff data-job-id="' +
    escapeHtml(job.id) + '">ChatGPT用引き継ぎをコピー</button>' +
    '<a href="/api/jobs/' + id + '/handoff" target="_blank" rel="noopener">Markdownを表示・保存</a>' +
    '<span data-handoff-status aria-live="polite"></span></div>';
}''',
    '''function handoffActions(job) {
  var id = encodeURIComponent(job.id);
  var recoveryButton = ['failed', 'blocked'].includes(job.stage)
    ? '<button type="button" data-recover-job data-job-id="' + escapeHtml(job.id) + '">別の手をChatGPTに聞く</button>'
    : '';
  return '<div class="handoff-actions"><button type="button" data-copy-handoff data-job-id="' +
    escapeHtml(job.id) + '">ChatGPT用引き継ぎをコピー</button>' + recoveryButton +
    '<a href="/api/jobs/' + id + '/handoff" target="_blank" rel="noopener">Markdownを表示・保存</a>' +
    '<span data-handoff-status aria-live="polite"></span></div>';
}

function recoveryInfo(job) {
  var values = [];
  if (job.parentJobId) {
    values.push('自動再引き継ぎジョブ · 深度 ' + escapeHtml(job.autoHandoffDepth) +
      ' · <a href="#job-' + escapeHtml(job.parentJobId) + '">元ジョブへ</a>');
  }
  if (job.continuationJobId) {
    values.push(escapeHtml(job.autoHandoffStatus || '継続ジョブを作成済み') +
      ' · <a href="#job-' + escapeHtml(job.continuationJobId) + '">継続ジョブへ</a>');
  } else if (job.autoHandoffStatus) {
    values.push(escapeHtml(job.autoHandoffStatus));
  }
  return values.length ? '<div class="recovery-info">' + values.join('<br>') + '</div>' : '';
}''',
    "client recovery actions",
)

app = replace_once(
    app,
    '''return '<article class="job" data-job-id="' + escapeHtml(job.id) + '" data-updated-at="' +
    escapeHtml(job.updatedAt) + '"><div class="job-head">''',
    '''return '<article id="job-' + escapeHtml(job.id) + '" class="job" data-job-id="' + escapeHtml(job.id) + '" data-updated-at="' +
    escapeHtml(job.updatedAt) + '"><div class="job-head">''',
    "client card anchor",
)

app = replace_once(
    app,
    '''runtime + jobActions(job) + handoffActions(job) +''',
    '''runtime + recoveryInfo(job) + jobActions(job) + handoffActions(job) +''',
    "client recovery info",
)

app = replace_once(
    app,
    '''  var historyButton = event.target.closest && event.target.closest('button[data-history-action]');''',
    '''  var recoverButton = event.target.closest && event.target.closest('button[data-recover-job]');
  if (recoverButton) {
    var recoverContainer = recoverButton.closest('.handoff-actions');
    var recoverStatus = recoverContainer.querySelector('[data-handoff-status]');
    recoverButton.disabled = true;
    recoverStatus.textContent = '別の手を依頼中...';
    try {
      var recoverResponse = await fetch('/api/jobs/' + encodeURIComponent(recoverButton.dataset.jobId) + '/recover', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
      });
      if (!recoverResponse.ok) throw new Error('recover request failed');
      recoverStatus.textContent = '継続ジョブを登録しました';
      await refreshJobs();
    } catch (_error) {
      recoverStatus.textContent = '継続ジョブの登録に失敗しました';
    } finally {
      recoverButton.disabled = false;
    }
    return;
  }

  var historyButton = event.target.closest && event.target.closest('button[data-history-action]');''',
    "client recovery click",
)

# Recovery route before progress route.
app = replace_once(
    app,
    '''const progressJobId = parseJobPath(
url.pathname,
"progress"
);''',
    '''const recoverJobId = parseJobPath(url.pathname, "recover");
if (request.method === "POST" && recoverJobId) {
const continuation = await requestAlternativeJob(recoverJobId);
if (!continuation) {
sendJson(response, 409, { error: "job cannot create a continuation" });
} else {
sendJson(response, 201, continuation);
}
return;
}

const progressJobId = parseJobPath(
url.pathname,
"progress"
);''',
    "recover route",
)

app_path.write_text(app, encoding="utf-8")


# agent/agent.js
agent_path = Path("agent/agent.js")
agent = agent_path.read_text(encoding="utf-8")
agent = replace_once(
    agent,
    '''    sessionFile: process.env.PSEUDO_CODEX_SESSION_FILE || null,
    hostWorkspace: null,''',
    '''    sessionFile: process.env.PSEUDO_CODEX_SESSION_FILE || null,
    sessionKey: process.env.PSEUDO_CODEX_SESSION_KEY || null,
    hostWorkspace: null,''',
    "agent session key default",
)
agent = replace_once(
    agent,
    '''    else if (argv[i] === '--session-file') args.sessionFile = argv[++i];
    else if (argv[i] === '--host-workspace')''',
    '''    else if (argv[i] === '--session-file') args.sessionFile = argv[++i];
    else if (argv[i] === '--session-key') args.sessionKey = argv[++i];
    else if (argv[i] === '--host-workspace')''',
    "agent session key flag",
)
agent = replace_once(
    agent,
    '''function ask(prompt, isNew = false, sessionFile = null) {''',
    '''function ask(prompt, isNew = false, sessionFile = null, sessionKey = null) {''',
    "agent ask signature",
)
agent = replace_once(
    agent,
    '''  if (sessionFile) flags.push('--session-file', sessionFile);
  flags.push('--prompt-file', promptFile);''',
    '''  if (sessionFile) flags.push('--session-file', sessionFile);
  if (sessionKey) flags.push('--session-key', sessionKey);
  flags.push('--prompt-file', promptFile);''',
    "agent ask session flag",
)
agent = replace_once(
    agent,
    '''async function reportTurn(args, payload) {''',
    '''function conversationMetadata(args) {
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

async function reportTurn(args, payload) {''',
    "agent conversation metadata helper",
)
agent = replace_once(
    agent,
    '''  console.log(`\nTask : ${args.task}`);''',
    '''  if (!args.sessionKey && args.jobId) args.sessionKey = args.jobId;

  console.log(`\nTask : ${args.task}`);''',
    "agent session key assignment",
)
agent = replace_once(
    agent,
    '''    const response = ask(sentPrompt, isNew, args.sessionFile);
    isNew = false;

    if (/^\[ERROR\]/m.test(response)) {''',
    '''    const response = ask(sentPrompt, isNew, args.sessionFile, args.sessionKey);
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

    if (/^\[ERROR\]/m.test(response)) {''',
    "agent save conversation metadata",
)
agent_path.write_text(agent, encoding="utf-8")


# agent/chatgpt.js
chat_path = Path("agent/chatgpt.js")
chat = chat_path.read_text(encoding="utf-8")
chat = replace_once(
    chat,
    '''const { addExtra }        = require('puppeteer-extra');
const puppeteerCore       = require('puppeteer-core');
const StealthPlugin       = require('puppeteer-extra-plugin-stealth');
const path                = require('path');
const os                  = require('os');
const fs                  = require('fs');
const http                = require('http');
const readline            = require('readline');
const { execSync, spawn } = require('child_process');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());''',
    '''const path                = require('path');
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
}''',
    "lazy browser dependencies",
)
chat = replace_once(
    chat,
    '''function launchBrowser() {
  return puppeteer.launch({''',
    '''function launchBrowser() {
  if (browserClient && typeof browserClient.launchBrowser === 'function') {
    return browserClient.launchBrowser();
  }
  return getPuppeteer().launch({''',
    "browser adapter launch",
)
chat = replace_once(
    chat,
    '''async function extractLastAssistantMessage(page) {''',
    '''async function navigateWithRetry(page, targetUrl, log) {
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

async function extractLastAssistantMessage(page) {''',
    "navigation recovery helpers",
)

new_daemon = r'''async function startDaemonProcess() {
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
        return { page, tail: Promise.resolve() };
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
            const sessionUrl = readSessionUrl(activeSessionFile);
            log(`ask: sessionKey=${key} newChat=${newChat} codeOnly=${codeOnly} upload=${uploadPath || 'none'} len=${String(fullPrompt || '').length}`);

            const currentUrl = page.url();
            if (newChat) {
              log(`Starting new chat for sessionKey=${key}`);
              await navigateWithRetry(
                page,
                activeSessionFile === SESSION_FILE ? CHATGPT_URL : projectHomeUrl(),
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

'''
chat = replace_between(
    chat,
    "async function startDaemonProcess() {",
    "// ─── Client helpers",
    new_daemon,
    "daemon session manager",
)

chat = replace_once(
    chat,
    '''    daemonInternal: false, cwd: null, sessionFile: null, promptFile: null, prompt: [],''',
    '''    daemonInternal: false, cwd: null, sessionFile: null, sessionKey: null, promptFile: null, prompt: [],''',
    "chatgpt session key option",
)
chat = replace_once(
    chat,
    '''      case '--session-file':    opts.sessionFile = args[++i]; break;
      case '--prompt-file':''',
    '''      case '--session-file':    opts.sessionFile = args[++i]; break;
      case '--session-key':     opts.sessionKey = args[++i];  break;
      case '--prompt-file':''',
    "chatgpt session key parse",
)
chat = replace_once(
    chat,
    '''      uploadPath: opts.upload || null, sessionFile: opts.sessionFile,
    });''',
    '''      uploadPath: opts.upload || null, sessionFile: opts.sessionFile,
      sessionKey: opts.sessionKey,
    });''',
    "chatgpt request session key",
)
chat_path.write_text(chat, encoding="utf-8")


# dispatcher/dispatcher.py
dispatcher_path = Path("dispatcher/dispatcher.py")
dispatcher = dispatcher_path.read_text(encoding="utf-8")
dispatcher = replace_once(
    dispatcher,
    '''from datetime import datetime, timezone
import json''',
    '''from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
import json''',
    "dispatcher futures import",
)
dispatcher = replace_once(
    dispatcher,
    '''WORKER_ID = os.environ.get("PSEUDO_CODEX_WORKER_ID", f"{socket.gethostname()}-{os.getpid()}")''',
    '''WORKER_ID = os.environ.get("PSEUDO_CODEX_WORKER_ID", f"{socket.gethostname()}-{os.getpid()}")
MAX_WORKERS = max(1, int(os.environ.get("PSEUDO_CODEX_MAX_WORKERS", "3")))''',
    "dispatcher worker count",
)
dispatcher = replace_once(
    dispatcher,
    '''    command = [
        AGENT,
        "run",''',
    '''    session_path = job_session_path(job_id)
    if job.get("forceNewConversation") and session_path.exists():
        session_path.unlink()

    command = [
        AGENT,
        "run",''',
    "dispatcher fresh session",
)
dispatcher = replace_once(
    dispatcher,
    '''        "--session-file",
        str(job_session_path(job_id)),
        "--cwd",''',
    '''        "--session-file",
        str(session_path),
        "--session-key",
        job_id,
        "--cwd",''',
    "dispatcher session key",
)
dispatcher = replace_once(
    dispatcher,
    '''def claim_next_job() -> dict[str, Any] | None:
    session_id = uuid.uuid4().hex
    status, job = api_json(
        "POST",
        "/api/jobs/claim",
        {
            "workerId": WORKER_ID,
            "sessionId": session_id,
            "leaseSeconds": LEASE_SECONDS,
        },
    )
    return None if status == 204 else job


def main() -> int:
    LOG.info(
        "dispatcher started console=%s project_root=%s total_timeout=%s idle_timeout=%s",
        CONSOLE_URL,
        PROJECT_ROOT,
        TOTAL_TIMEOUT_SECONDS,
        IDLE_TIMEOUT_SECONDS,
    )
    recover_running_jobs()
    while True:
        try:
            job = claim_next_job()
            if job is None:
                time.sleep(POLL_SECONDS)
                continue
            if job.get("kind") == "test" or job.get("isTest") is True:
                LOG.error("console returned a test job; refusing job=%s", job.get("id"))
                continue
            run_job(job)
        except KeyboardInterrupt:
            return 0
        except Exception as exc:
            LOG.exception("dispatcher loop error: %r", exc)
            time.sleep(POLL_SECONDS)
''',
    '''def claim_next_job(excluded_projects: set[str] | None = None) -> dict[str, Any] | None:
    session_id = uuid.uuid4().hex
    status, job = api_json(
        "POST",
        "/api/jobs/claim",
        {
            "workerId": WORKER_ID,
            "sessionId": session_id,
            "leaseSeconds": LEASE_SECONDS,
            "excludedProjects": sorted(excluded_projects or set()),
        },
    )
    return None if status == 204 else job


def project_allows_parallel(project: str) -> bool:
    git_config = PROJECT_CONFIGS.get(project, {}).get("git", {})
    return isinstance(git_config, dict) and bool(git_config.get("enabled", False))


def main() -> int:
    LOG.info(
        "dispatcher started console=%s project_root=%s total_timeout=%s idle_timeout=%s max_workers=%s",
        CONSOLE_URL,
        PROJECT_ROOT,
        TOTAL_TIMEOUT_SECONDS,
        IDLE_TIMEOUT_SECONDS,
        MAX_WORKERS,
    )
    recover_running_jobs()
    active: dict[Future[None], str] = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="pseudo-codex") as executor:
        while True:
            try:
                for future in [item for item in active if item.done()]:
                    project = active.pop(future)
                    try:
                        future.result()
                    except Exception as exc:
                        LOG.exception("worker failed project=%s: %r", project, exc)

                if len(active) >= MAX_WORKERS:
                    time.sleep(0.5)
                    continue

                excluded_projects = {
                    project for project in active.values()
                    if not project_allows_parallel(project)
                }
                job = claim_next_job(excluded_projects)
                if job is None:
                    time.sleep(POLL_SECONDS)
                    continue
                if job.get("kind") == "test" or job.get("isTest") is True:
                    LOG.error("console returned a test job; refusing job=%s", job.get("id"))
                    continue

                project = str(job.get("project", ""))
                active[executor.submit(run_job, job)] = project
                LOG.info(
                    "scheduled job=%s project=%s active=%s/%s",
                    job.get("id"),
                    project,
                    len(active),
                    MAX_WORKERS,
                )
            except KeyboardInterrupt:
                return 0
            except Exception as exc:
                LOG.exception("dispatcher loop error: %r", exc)
                time.sleep(POLL_SECONDS)
''',
    "dispatcher worker pool",
)
dispatcher_path.write_text(dispatcher, encoding="utf-8")


# package.json
package_path = Path("package.json")
package = package_path.read_text(encoding="utf-8")
package = replace_once(
    package,
    '''"check:agent": "node tests/agent-no-sha.check.js && node tests/agent-controller.check.js",
    "check:syntax": "node --check app.js && node --check agent/agent.js && node --check agent/chatgpt.js && node --check agent/mcp-server.js"''',
    '''"check:agent": "node tests/agent-no-sha.check.js && node tests/agent-controller.check.js && node tests/chatgpt-parallel.check.js",
    "check:syntax": "node --check app.js && node --check agent/agent.js && node --check agent/chatgpt.js && node --check agent/fake-browser-client.js && node --check agent/mcp-server.js"''',
    "package checks",
)
package_path.write_text(package, encoding="utf-8")


# check.js
check_path = Path("check.js")
check = check_path.read_text(encoding="utf-8")
check = replace_once(
    check,
    '''async function claim() {
return postJson("/api/jobs/claim", {
workerId: "check-worker",
sessionId: crypto.randomUUID(),
leaseSeconds: 120
});
}''',
    '''async function claim(excludedProjects) {
return postJson("/api/jobs/claim", {
workerId: "check-worker",
sessionId: crypto.randomUUID(),
leaseSeconds: 120,
excludedProjects: excludedProjects || []
});
}''',
    "check claim exclusions",
)
check = replace_once(
    check,
    '''const verifying = await postJson("/api/jobs/" + completedCreated.id + "/progress", {
stage: "verifying",
message: "結果を検証 turn=3",
currentCommand: "node --check app.js"
});
assert.equal(verifying.assignee, "Ubuntu");
assert.equal(verifying.currentTurn, 3);
assert.equal(verifying.currentCommand, "node --check app.js");''',
    '''const verifying = await postJson("/api/jobs/" + completedCreated.id + "/progress", {
stage: "verifying",
message: "結果を検証 turn=3",
currentCommand: "node --check app.js",
chatConversationId: "conversation-check",
chatConversationUrl: "https://chatgpt.com/g/g-test/project/c/conversation-check",
workerSessionId: completedCreated.id
});
assert.equal(verifying.assignee, "Ubuntu");
assert.equal(verifying.currentTurn, 3);
assert.equal(verifying.currentCommand, "node --check app.js");
assert.equal(verifying.chatConversationId, "conversation-check");
assert.equal(verifying.workerSessionId, completedCreated.id);''',
    "check conversation persistence",
)
check = replace_once(
    check,
    '''assert.equal(failed.stage, "failed");
assert.equal(failed.assignee, "失敗");

const stoppedCreated = await createJob''',
    '''assert.equal(failed.stage, "failed");
assert.equal(failed.assignee, "失敗");
assert.ok(failed.continuationJobId, "failed job must create one continuation");
const continuation = await requestJson("/api/jobs/" + failed.continuationJobId, { method: "GET" });
assert.equal(continuation.parentJobId, failedCreated.id);
assert.equal(continuation.rootJobId, failedCreated.id);
assert.equal(continuation.autoHandoffDepth, 1);
assert.equal(continuation.forceNewConversation, true);
assert.ok(continuation.instruction.includes("# Pseudo Codex job handoff for ChatGPT"));
const duplicateFailure = await postJson("/api/jobs/" + failedCreated.id + "/result", {
status: "failed", lastError: "DISPLAY_TEST_FAILURE", workerLog: "",
finalAnswer: "", executionResult: "", verificationResult: ""
});
assert.equal(duplicateFailure.continuationJobId, failed.continuationJobId);
const manualContinuation = await postJson("/api/jobs/" + failedCreated.id + "/recover", {});
assert.equal(manualContinuation.id, failed.continuationJobId);
assert.equal((await claim()).id, continuation.id);
const continuationFailed = await postJson("/api/jobs/" + continuation.id + "/result", {
status: "failed", lastError: "CONTINUATION_FAILURE", workerLog: "",
finalAnswer: "", executionResult: "", verificationResult: ""
});
assert.equal(continuationFailed.autoHandoffStatus, "自動再引き継ぎ上限に到達");
assert.equal(continuationFailed.continuationJobId, "");

const stoppedCreated = await createJob''',
    "check automatic continuation",
)
check = replace_once(
    check,
    '''const noClaim = await claim();
assert.equal(noClaim.statusCode, 204, "test-only job must remain unclaimed");''',
    '''const excludedCreated = await createJob("Excluded project test " + token);
const excludedClaim = await claim(["request-console"]);
assert.equal(excludedClaim.statusCode, 204, "active project must be skipped by another worker");
await postJson("/api/jobs/" + excludedCreated.id + "/stop", { reason: "test cleanup" });

const noClaim = await claim();
assert.equal(noClaim.statusCode, 204, "test-only job must remain unclaimed");''',
    "check project exclusion",
)
check = replace_once(
    check,
    '''const stoppedCard = extractJobCard(page, stoppedCreated.id);''',
    '''const stoppedCard = extractJobCard(page, stoppedCreated.id);
const continuationCard = extractJobCard(page, continuation.id);''',
    "check continuation card",
)
check = replace_once(
    check,
    '''assert.match(stoppedCard, /stage-stopped[^>]*>停止<\/span>/);
assert.ok(page.includes('<script src="/client.js"></script>'));''',
    '''assert.match(stoppedCard, /stage-stopped[^>]*>停止<\/span>/);
assert.ok(failedCard.includes("data-recover-job"));
assert.ok(failedCard.includes("継続ジョブへ"));
assert.ok(continuationCard.includes("元ジョブへ"));
assert.ok(page.includes('<script src="/client.js"></script>'));''',
    "check recovery UI",
)
check = replace_once(
    check,
    '''assert.ok(clientScript.includes("button[data-job-action]"));''',
    '''assert.ok(clientScript.includes("button[data-job-action]"));
assert.ok(clientScript.includes("button[data-recover-job]"));
assert.ok(clientScript.includes("/recover"));''',
    "check recovery client",
)
check = replace_once(
    check,
    '''assert.equal(listed.jobs.length, 4);''',
    '''assert.equal(listed.jobs.length, 6);''',
    "check job count",
)
check = replace_once(
    check,
    '''env: Object.assign({}, process.env, { PORT: String(port), DATA_PATH: dataPath }),''',
    '''env: Object.assign({}, process.env, {
PORT: String(port),
DATA_PATH: dataPath,
PSEUDO_CODEX_AUTO_HANDOFF_MAX: "1"
}),''',
    "check handoff max env",
)
check_path.write_text(check, encoding="utf-8")


# New fake browser adapter
Path("agent/fake-browser-client.js").write_text(r'''"use strict";

let nextPageId = 0;

class FakePage {
  constructor() {
    this.pageId = ++nextPageId;
    this.currentUrl = "about:blank";
    this.reloadCount = 0;
  }

  async goto(url) {
    this.currentUrl = String(url);
  }

  async reload() {
    this.reloadCount += 1;
  }

  url() {
    return this.currentUrl;
  }
}

class FakeBrowser {
  constructor() {
    this.pages = [];
  }

  async newPage() {
    const page = new FakePage();
    this.pages.push(page);
    return page;
  }

  async close() {}
}

async function launchBrowser() {
  return new FakeBrowser();
}

async function send({ page, fullPrompt, newChat }) {
  let conversationId = String(page.url()).match(/\/c\/([^/?#]+)/)?.[1] || "";
  if (newChat || !conversationId) {
    conversationId = "conversation-" + page.pageId + "-" + Date.now().toString(36);
    page.currentUrl = "https://chatgpt.com/g/g-test/project/c/" + conversationId;
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  return { response: conversationId + ":" + fullPrompt };
}

module.exports = { launchBrowser, send };
''', encoding="utf-8")


# Parallel browser regression
Path("tests/chatgpt-parallel.check.js").write_text(r'''"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "agent", "chatgpt.js");
const adapter = path.join(root, "agent", "fake-browser-client.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pseudo-codex-chatgpt-test-"));
const env = Object.assign({}, process.env, {
  HOME: home,
  PSEUDO_CODEX_BROWSER_CLIENT: adapter,
});

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
  assert.ok(a2.startsWith(aConversation + ":A2"));
  assert.ok(b2.startsWith(bConversation + ":B2"));
  assert.ok(!a2.includes(bConversation));
  assert.ok(!b2.includes(aConversation));

  const legacy1 = await run(["--new", "legacy1"]);
  const legacyConversation = legacy1.split(":", 1)[0];
  const legacy2 = await run(["legacy2"]);
  assert.ok(legacy2.startsWith(legacyConversation + ":legacy2"));

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
''', encoding="utf-8")


# Dispatcher payload regression
Path("tests/dispatcher-parallel.check.py").write_text(r'''#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as temporary:
    project_root = Path(temporary) / "projects"
    workspace = project_root / "request-console"
    workspace.mkdir(parents=True)
    config_path = Path(temporary) / "projects.json"
    config_path.write_text(json.dumps({
        "request-console": {"workspace": str(workspace), "requiresDeployment": False}
    }), encoding="utf-8")
    os.environ["PSEUDO_CODEX_PROJECT_CONFIG"] = str(config_path)
    os.environ["PSEUDO_CODEX_PROJECT_ROOT"] = str(project_root)
    os.environ["PSEUDO_CODEX_STATE_DIR"] = str(Path(temporary) / "state")

    spec = importlib.util.spec_from_file_location("dispatcher_under_test", root / "dispatcher" / "dispatcher.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    captured = {}
    def fake_api(method, path, payload=None):
        captured.update(payload or {})
        return 204, None

    module.api_json = fake_api
    assert module.claim_next_job({"request-console"}) is None
    assert captured["excludedProjects"] == ["request-console"]
    assert module.MAX_WORKERS >= 1
    assert module.project_allows_parallel("request-console") is False

print("DISPATCHER_PARALLEL_POOL_OK")
''', encoding="utf-8")


# Workflow test command
workflow_path = Path(".github/workflows/test.yml")
workflow = workflow_path.read_text(encoding="utf-8")
workflow = replace_once(
    workflow,
    '''      - run: python3 tests/dispatcher-git.check.py''',
    '''      - run: python3 tests/dispatcher-git.check.py
      - run: python3 tests/dispatcher-parallel.check.py''',
    "workflow dispatcher parallel test",
)
workflow_path.write_text(workflow, encoding="utf-8")
