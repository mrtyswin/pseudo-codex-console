"use strict";

// Production deployment is performed by the dispatcher after successful jobs.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number.parseInt(process.env.PORT || "8090", 10);
const DATA_PATH = process.env.DATA_PATH || "/data/jobs.json";
const HOME_PATH = process.env.HOME || process.env.USERPROFILE || process.cwd();
const PROJECT_CONFIG_PATH = process.env.PROJECT_CONFIG_PATH ||
path.join(HOME_PATH, ".config", "pseudo-codex", "projects.json");
const RESULT_LOG_ROOT =
process.env.RESULT_LOG_ROOT || path.join(HOME_PATH, ".local", "state", "pseudo-codex", "jobs");
const STARTED_AT = new Date().toISOString();
const DEFAULT_PROJECT = "request-console";
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GITHUB_FIRST_PROJECTS = new Set(["request-console"]);
const WORKER_LOG_LIMIT = Number.parseInt(
process.env.WORKER_LOG_LIMIT || "12000",
10
);
const JST_DATE_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
year: "numeric",
month: "2-digit",
day: "2-digit",
hour: "2-digit",
minute: "2-digit",
second: "2-digit",
hourCycle: "h23",
timeZone: "Asia/Tokyo"
});

const RESULT_STATUSES = new Set([
"done",
"completed",
"queued",
"needs_human",
"failed",
"stopped",
"blocked"
]);

const STAGES = new Set([
"queued",
"sending_to_chatgpt",
"waiting_chatgpt",
"executing_command",
"writing_file",
"verifying",
"completed",
"failed",
"stopped",
"blocked"
]);

const TERMINAL_STAGES = new Set([
"completed",
"failed",
"stopped",
"blocked"
]);

const WORK_PHASES = new Set([
"INSPECT", "PLAN", "EDIT", "TEST", "DEPLOY", "VERIFY", "COMPLETE", "BLOCKED"
]);

const CHATGPT_STAGES = new Set([
"sending_to_chatgpt",
"waiting_chatgpt"
]);

const UBUNTU_STAGES = new Set([
"queued",
"executing_command",
"writing_file",
"verifying"
]);

const CLIENT_REFRESH_SCRIPT = String.raw`<script>
(function () {
const formatter = new Intl.DateTimeFormat("ja-JP", {
year: "numeric",
month: "2-digit",
day: "2-digit",
hour: "2-digit",
minute: "2-digit",
second: "2-digit",
hourCycle: "h23",
timeZone: "Asia/Tokyo"
});
const escapeHtml = function (value) {
return String(value || "").replace(/[&<>"']/g, function (character) {
return {
"&": "&",
"<": "<",
">": ">",
'"': """,
"'": "'"
}[character];
});
};
const formatDate = function (value) {
const date = new Date(value);
return Number.isNaN(date.getTime())
? ""
: formatter.format(date) + " JST";
};
const detailStates = new Map();
const historyStates = new Map();
const filterState = {
keyword: "",
status: "all"
};
let cachedJobs = [];
let activeHistoryDetails = null;

const nextFrame = function (callback) {
if (typeof window.requestAnimationFrame === "function") {
window.requestAnimationFrame(callback);
return;
}
setTimeout(callback, 0);
};

const details = function (jobId, title, value, open, isResult) {
if (!value) return "";
const key = jobId + ":" + title;
const isOpen = detailStates.has(key)
? detailStates.get(key)
: open;
return "<details data-detail-key="" + escapeHtml(key) + """ +
(isResult ? " class="result-details"" : "") +
(isOpen ? " open" : "") +
"><summary>" + escapeHtml(title) + "</summary><pre>" +
escapeHtml(value) + "</pre></details>";
};

const historyText = function (entries) {
return (entries || []).map(function (entry) {
const assignee = entry.assignee
? entry.assignee + " / "
: "";
return formatDate(entry.at) + " [" + assignee +
entry.stage + "] " + entry.message;
}).join(String.fromCharCode(10));
};

const historyDetails = function (jobId, entries) {
const value = historyText(entries);
if (!value) return "";
const key = jobId + ":処理履歴を表示";
const isOpen = detailStates.has(key)
? detailStates.get(key)
: false;

return "<details class=\"history-details\" data-detail-key=\"" +
  escapeHtml(key) + "\" data-history-job-id=\"" +
  escapeHtml(jobId) + "\"" + (isOpen ? " open" : "") +
  "><summary>処理履歴を表示</summary>" +
  "<div class=\"history-toolbar\">" +
  "<button type=\"button\" data-history-action=\"pause\">" +
  "更新を一時停止</button>" +
  "<button type=\"button\" data-history-action=\"latest\">" +
  "最新へ戻る</button>" +
  "<button type=\"button\" data-history-action=\"copy\">" +
  "表示中をコピー</button>" +
  "<span class=\"history-status\" data-history-status " +
  "aria-live=\"polite\"></span></div>" +
  "<pre class=\"history-log\" tabindex=\"0\">" +
  escapeHtml(value) + "</pre></details>";

};

const getHistoryState = function (jobId) {
if (!historyStates.has(jobId)) {
historyStates.set(jobId, {
initialized: false,
paused: false,
interacting: false,
autoFollow: true,
scrollTop: 0,
latestText: "",
displayedText: "",
hasNew: false,
copyStatus: ""
});
}
return historyStates.get(jobId);
};

const badges = function (job) {
if (["completed", "failed", "stopped", "blocked"].includes(job.stage)) {
return "<div class="badges"><span class="badge stage-" +
escapeHtml(job.stage) + "">" +
escapeHtml(job.displayStatus) + "</span></div>";
}

return "<div class=\"badges\"><span class=\"badge assignee-" +
  escapeHtml(job.assignee) + "\">現在の担当: " +
  escapeHtml(job.assignee) +
  "</span><span class=\"badge stage-" +
  escapeHtml(job.stage) + "\">" +
  escapeHtml(job.stage) + "</span></div>";

};

const actions = function (job) {
if (job.stage === "completed") return "";
const action =
["stopped", "failed", "blocked"].includes(job.stage)
? "resume"
: "stop";
const label = action === "stop" ? "停止" : "再実行";

return "<div class=\"job-actions\"><button type=\"button\" " +
  "data-job-action=\"" + action + "\" data-job-id=\"" +
  escapeHtml(job.id) + "\">" + label + "</button></div>";

};

const handoffControls = function (job) {
const id = encodeURIComponent(job.id);
return "<div class=\"handoff-actions\">" +
  "<button type=\"button\" data-copy-handoff data-job-id=\"" +
  escapeHtml(job.id) + "\">ChatGPT用引き継ぎをコピー</button>" +
  "<a href=\"/api/jobs/" + id +
  "/handoff\" target=\"_blank\" rel=\"noopener\">Markdownを表示・保存</a>" +
  "<span data-handoff-status aria-live=\"polite\"></span></div>";
};

const renderJob = function (job) {
return "<article class="job" data-job-id="" +
escapeHtml(job.id) + "">" +
"<div class="job-head"><div><h3>" +
escapeHtml(job.title || "無題") +
"</h3><p class="meta">登録: " +
escapeHtml(formatDate(job.createdAt)) + " · " +
escapeHtml(job.project) + " · " +
escapeHtml(job.id) + "</p></div>" +
badges(job) + "</div>" +
"<div class="facts"><span>段階: <strong>" +
escapeHtml(job.stage) +
"</strong></span><span>試行回数: <strong>" +
escapeHtml(job.attempts) +
"</strong></span><span>更新: <strong>" +
escapeHtml(formatDate(job.updatedAt)) +
"</strong></span></div>" +
"<div class="facts"><span>工程: <strong>" +
escapeHtml(job.phase || "INSPECT") +
"</strong></span><span>残りターン: <strong>" +
escapeHtml(job.remainingTurns) +
"</strong></span><span>変更ファイル: <strong>" +
escapeHtml((job.changedFiles || []).length) +
"</strong></span><span>戦略パス: <strong>" +
escapeHtml(job.strategyPass || 1) +
"</strong></span></div>" +
(job.workerId
? "<div class="runtime">Worker: " +
escapeHtml(job.workerId) + " · PID: " +
escapeHtml(job.pid || "-") +
" · 最終heartbeat: " +
escapeHtml(formatDate(job.heartbeatAt)) + "</div>"
: "") +
actions(job) +
handoffControls(job) +
"<div class="job-download"><a href="/api/jobs/" +
encodeURIComponent(job.id) +
"/transcript" download="transcript.json">" +
"このジョブのやり取りをダウンロード</a></div>" +
details(job.id, "指示を表示", job.instruction, false, false) +
details(job.id, "最終結果を表示", job.result, false, true) +
details(job.id, "ワーカーログを表示", job.workerLog, false, false) +
details(job.id, "変更トランザクションを表示", JSON.stringify(job.transactions || [], null, 2), false, false) +
details(job.id, "チェックポイントを表示", job.checkpoint, false, false) +
details(
job.id,
"最終エラーを表示",
job.lastError,
job.stage === "failed",
false
) +
historyDetails(job.id, job.history) +
"</article>";
};

const setHistoryStatus = function (detailsNode, state) {
const status = detailsNode.querySelector("[data-history-status]");
if (status) {
status.textContent = state.copyStatus ||
(state.hasNew
? "更新停止中・新しい履歴あり"
: state.paused || state.interacting || !state.autoFollow
? "更新停止中"
: "");
}

const pauseButton = detailsNode.querySelector(
  '[data-history-action="pause"]'
);
if (pauseButton) {
  pauseButton.disabled = state.paused;
}

};

const scrollHistoryToBottom = function (detailsNode, state) {
const log = detailsNode.querySelector(".history-log");
if (!log) return;

nextFrame(function () {
  log.scrollTop = log.scrollHeight;
  state.scrollTop = log.scrollTop;
});

};

const applyHistoryUpdate = function (
detailsNode,
latestText,
force
) {
if (!detailsNode) return false;

const state = getHistoryState(detailsNode.dataset.historyJobId);
const log = detailsNode.querySelector(".history-log");
if (!log) return false;

state.latestText = latestText;

if (
  !force &&
  (state.paused || state.interacting || !state.autoFollow)
) {
  state.hasNew = latestText !== state.displayedText;
  setHistoryStatus(detailsNode, state);
  return false;
}

if (log.textContent !== latestText) {
  log.textContent = latestText;
}

state.displayedText = latestText;
state.hasNew = false;
state.initialized = true;
scrollHistoryToBottom(detailsNode, state);
setHistoryStatus(detailsNode, state);
return true;

};

const initializeHistoryView = function (
detailsNode,
latestText
) {
if (!detailsNode) return;

const state = getHistoryState(detailsNode.dataset.historyJobId);
const log = detailsNode.querySelector(".history-log");
if (!log) return;

state.latestText = latestText;

if (!state.initialized) {
  state.initialized = true;
  state.displayedText = log.textContent;
  state.hasNew = false;
  scrollHistoryToBottom(detailsNode, state);
  setHistoryStatus(detailsNode, state);
  return;
}

if (
  state.paused ||
  state.interacting ||
  !state.autoFollow
) {
  log.textContent = state.displayedText;
  state.hasNew = latestText !== state.displayedText;
  nextFrame(function () {
    log.scrollTop = state.scrollTop;
  });
  setHistoryStatus(detailsNode, state);
  return;
}

applyHistoryUpdate(detailsNode, latestText, true);

};

const copyText = async function (value) {
if (
navigator.clipboard &&
typeof navigator.clipboard.writeText === "function"
) {
await navigator.clipboard.writeText(value);
return;
}

const fallback = document.createElement("textarea");
fallback.value = value;
fallback.setAttribute("readonly", "");
fallback.style.position = "fixed";
fallback.style.opacity = "0";
document.body.appendChild(fallback);
fallback.select();
const copied = document.execCommand("copy");
fallback.remove();
if (!copied) throw new Error("clipboard unavailable");
};

const copyVisibleHistory = async function (detailsNode) {
const state = getHistoryState(detailsNode.dataset.historyJobId);
const log = detailsNode.querySelector(".history-log");
if (!log) return false;

try {
  await copyText(log.textContent);
  state.copyStatus = "コピーしました";
  setHistoryStatus(detailsNode, state);

  setTimeout(function () {
    if (state.copyStatus === "コピーしました") {
      state.copyStatus = "";
      setHistoryStatus(detailsNode, state);
    }
  }, 1500);

  return true;
} catch (_error) {
  state.copyStatus = "コピーに失敗しました";
  setHistoryStatus(detailsNode, state);
  return false;
}

};

const copyHandoff = async function (button) {
const container = button.closest(".handoff-actions");
const status = container
? container.querySelector("[data-handoff-status]")
: null;
button.disabled = true;
if (status) status.textContent = "生成中...";
try {
  const response = await fetch(
    "/api/jobs/" + encodeURIComponent(button.dataset.jobId) + "/handoff",
    { cache: "no-store" }
  );
  if (!response.ok) throw new Error("handoff request failed");
  await copyText(await response.text());
  if (status) status.textContent = "コピーしました";
} catch (_error) {
  if (status) status.textContent = "コピーに失敗しました。Markdownを表示してください";
} finally {
  button.disabled = false;
}
};

const createJobElement = function (job) {
const template = document.createElement("template");
template.innerHTML = renderJob(job);
return template.content.firstElementChild;
};

const syncJobElement = function (existing, job) {
const existingHistory = existing.querySelector(
"details.history-details"
);
const fresh = createJobElement(job);
const freshHistory = fresh.querySelector(
"details.history-details"
);

if (!existingHistory || !freshHistory) {
  existing.replaceWith(fresh);
  return fresh;
}

applyHistoryUpdate(
  existingHistory,
  historyText(job.history),
  false
);

Array.from(existing.children).forEach(function (child) {
  if (child !== existingHistory) {
    child.remove();
  }
});

Array.from(fresh.children).forEach(function (child) {
  if (child !== freshHistory) {
    existing.insertBefore(child, existingHistory);
  }
});

return existing;

};

const captureViewStates = function () {
Array.from(
document.querySelectorAll("#jobs details[data-detail-key]")
).forEach(function (item) {
detailStates.set(item.dataset.detailKey, item.open);
});

Array.from(
  document.querySelectorAll("#jobs details.history-details")
).forEach(function (item) {
  const state = getHistoryState(item.dataset.historyJobId);
  const log = item.querySelector(".history-log");
  if (!log) return;

  state.scrollTop = log.scrollTop;

  if (!state.initialized) {
    state.initialized = true;
    state.latestText = log.textContent;
    state.displayedText = log.textContent;
    scrollHistoryToBottom(item, state);
  }
});

};

const matchesStatus = function (job, status) {
if (status === "all") return true;
if (status === "queued") return job.stage === "queued";

if (status === "running") {
  return [
    "sending_to_chatgpt",
    "waiting_chatgpt",
    "executing_command",
    "writing_file",
    "verifying"
  ].includes(job.stage);
}

return job.stage === status;

};

const matchesKeyword = function (job, keyword) {
const normalized = keyword
.trim()
.toLocaleLowerCase("ja-JP");

if (!normalized) return true;

return [
  job.title,
  job.instruction,
  job.id
].some(function (value) {
  return String(value || "")
    .toLocaleLowerCase("ja-JP")
    .includes(normalized);
});

};

const syncFilterState = function () {
const searchInput = document.getElementById("job-search");
const statusSelect = document.getElementById(
"job-status-filter"
);

filterState.keyword = searchInput
  ? searchInput.value
  : "";
filterState.status = statusSelect
  ? statusSelect.value
  : "all";

};

const renderFilteredJobs = function () {
const visibleJobs = cachedJobs.filter(function (job) {
return matchesKeyword(job, filterState.keyword) &&
matchesStatus(job, filterState.status);
});
const jobsNode = document.getElementById("jobs");
const resultCount = document.getElementById(
"job-result-count"
);

if (jobsNode) {
  if (cachedJobs.length === 0) {
    jobsNode.innerHTML =
      '<p class="empty">登録済みジョブはありません。</p>';
  } else if (visibleJobs.length === 0) {
    jobsNode.innerHTML =
      '<p class="empty">' +
      "検索条件に一致するジョブはありません。</p>";
  } else {
    const existing = new Map();

    Array.from(jobsNode.children).forEach(function (child) {
      if (child.matches("article.job")) {
        existing.set(child.dataset.jobId, child);
      }
    });

    const desired = visibleJobs.map(function (job) {
      const current = existing.get(job.id);
      return current
        ? syncJobElement(current, job)
        : createJobElement(job);
    });

    desired.forEach(function (node, index) {
      const current = jobsNode.children[index];

      if (current !== node) {
        jobsNode.insertBefore(node, current || null);
      }

      initializeHistoryView(
        node.querySelector("details.history-details"),
        historyText(visibleJobs[index].history)
      );
    });

    Array.from(jobsNode.children).forEach(function (child) {
      if (!desired.includes(child)) {
        child.remove();
      }
    });
  }
}

if (resultCount) {
  resultCount.textContent =
    "表示 " + visibleJobs.length +
    " / 全 " + cachedJobs.length + " 件";
}

};

const refreshJobs = async function () {
try {
captureViewStates();

  const response = await fetch("/api/jobs", {
    cache: "no-store"
  });

  if (!response.ok) return;

  const payload = await response.json();
  captureViewStates();
  cachedJobs = Array.isArray(payload.jobs)
    ? payload.jobs
    : [];
  renderFilteredJobs();
} catch (_error) {
  // Keep the last rendered state during a transient outage.
}

};

captureViewStates();
syncFilterState();

const searchInput = document.getElementById("job-search");
if (searchInput) {
searchInput.addEventListener("input", function () {
captureViewStates();
syncFilterState();
renderFilteredJobs();
});
}

const statusSelect = document.getElementById(
"job-status-filter"
);
if (statusSelect) {
statusSelect.addEventListener("change", function () {
captureViewStates();
syncFilterState();
renderFilteredJobs();
});
}

document.addEventListener("mousedown", function (event) {
const copyButton = event.target.closest(
'button[data-history-action="copy"]'
);

if (copyButton) {
  event.preventDefault();
}

}, true);

document.addEventListener("pointerdown", function (event) {
const detailsNode = event.target.closest(
"details.history-details"
);
if (!detailsNode) return;

const state = getHistoryState(
  detailsNode.dataset.historyJobId
);
const log = detailsNode.querySelector(".history-log");

state.paused = true;
state.interacting = true;
state.autoFollow = false;
activeHistoryDetails = detailsNode;

if (log) {
  state.scrollTop = log.scrollTop;
}

setHistoryStatus(detailsNode, state);

}, true);

const endHistoryInteraction = function () {
if (!activeHistoryDetails) return;

const state = getHistoryState(
  activeHistoryDetails.dataset.historyJobId
);
state.interacting = false;
setHistoryStatus(activeHistoryDetails, state);
activeHistoryDetails = null;

};

document.addEventListener(
"pointerup",
endHistoryInteraction,
true
);
document.addEventListener(
"pointercancel",
endHistoryInteraction,
true
);

document.addEventListener("selectstart", function (event) {
const log = event.target.closest(".history-log");
if (!log) return;

const detailsNode = log.closest(
  "details.history-details"
);
const state = getHistoryState(
  detailsNode.dataset.historyJobId
);

state.paused = true;
state.interacting = true;
state.autoFollow = false;
state.scrollTop = log.scrollTop;
activeHistoryDetails = detailsNode;
setHistoryStatus(detailsNode, state);

}, true);

document.addEventListener("scroll", function (event) {
const log = event.target.closest
? event.target.closest(".history-log")
: null;
if (!log) return;

const detailsNode = log.closest(
  "details.history-details"
);
const state = getHistoryState(
  detailsNode.dataset.historyJobId
);

state.scrollTop = log.scrollTop;

if (
  log.scrollHeight -
  log.scrollTop -
  log.clientHeight >
  4
) {
  state.paused = true;
  state.autoFollow = false;
  setHistoryStatus(detailsNode, state);
}

}, true);

document.addEventListener("toggle", function (event) {
const detailsNode = event.target.closest
? event.target.closest("details.history-details")
: null;
if (!detailsNode) return;

detailStates.set(
  detailsNode.dataset.detailKey,
  detailsNode.open
);

const state = getHistoryState(
  detailsNode.dataset.historyJobId
);

if (
  detailsNode.open &&
  !state.paused &&
  state.autoFollow
) {
  scrollHistoryToBottom(detailsNode, state);
}

}, true);

document.addEventListener("click", async function (event) {
const handoffButton = event.target.closest(
"button[data-copy-handoff]"
);
if (handoffButton) {
  await copyHandoff(handoffButton);
  return;
}

const historyButton = event.target.closest(
"button[data-history-action]"
);

if (historyButton) {
  const detailsNode = historyButton.closest(
    "details.history-details"
  );
  const state = getHistoryState(
    detailsNode.dataset.historyJobId
  );
  const action = historyButton.dataset.historyAction;

  if (action === "pause") {
    state.paused = true;
    state.interacting = false;
    state.autoFollow = false;
    setHistoryStatus(detailsNode, state);
  } else if (action === "latest") {
    state.paused = false;
    state.interacting = false;
    state.autoFollow = true;
    state.copyStatus = "";
    applyHistoryUpdate(
      detailsNode,
      state.latestText,
      true
    );
  } else if (action === "copy") {
    await copyVisibleHistory(detailsNode);
  }

  return;
}

const button = event.target.closest(
  "button[data-job-action]"
);
if (!button) return;

button.disabled = true;

try {
  await fetch(
    "/api/jobs/" +
    encodeURIComponent(button.dataset.jobId) +
    "/" +
    button.dataset.jobAction,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body:
        button.dataset.jobAction === "stop"
          ? JSON.stringify({
            reason: "Web GUIから手動停止"
          })
          : "{}"
    }
  );
  await refreshJobs();
} finally {
  button.disabled = false;
}

});

window.__pseudoCodexHistoryTest = {
historyText: historyText,
getHistoryState: getHistoryState,
applyHistoryUpdate: applyHistoryUpdate,
copyVisibleHistory: copyVisibleHistory
};

void refreshJobs();
setInterval(refreshJobs, 3000);
}());
</script>`;

const CLIENT_SCRIPT_TAG = '<script src="/client.js"></script>';
const CLIENT_JS = String.raw`(function () {
'use strict';

var formatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', timeZone: 'Asia/Tokyo'
});
var detailStates = new Map();
var historyStates = new Map();
var cachedJobs = [];

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
    return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character];
  });
}

function formatDate(value) {
  var date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : formatter.format(date) + ' JST';
}

function updateQueueSummary(jobs) {
  var node = document.getElementById('queue-summary');
  if (!node) return;
  var running = jobs.filter(function (job) { return job.status === 'running'; }).length;
  var queued = jobs.filter(function (job) { return job.stage === 'queued'; }).length;
  var failed = jobs.filter(function (job) { return job.stage === 'failed' || job.stage === 'blocked'; }).length;
  var stopped = jobs.filter(function (job) { return job.stage === 'stopped'; }).length;
  node.innerHTML = '<div><strong>いま動いている:</strong> ' + running + ' 件</div>' +
    '<div><strong>実行待ち:</strong> ' + queued + ' 件</div>' +
    '<div><strong>失敗・保留:</strong> ' + failed + ' 件</div>' +
    '<div><strong>停止済み:</strong> ' + stopped + ' 件</div>' +
    '<p>「実行中」はUbuntu上のworkerが担当中です。停止を押したジョブは次回更新で「停止済み」に変わります。</p>';
}

function sanitizeUserFacingText(value) {
  return String(value == null ? '' : value)
    .replace(/[^]+/g, '')
    .replace(/\bturn\d+(?:file|search|view|news)\d+\b/gi, '')
    .replace(/\bfile_[0-9a-f]{16,}\b/gi, '')
    .replace(/\bH\d{2,}\b/g, '')
    .replace(/\s+id="[0-9a-f]{6,16}"/gi, '')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+/gi, '$1 [REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY)[A-Z0-9_]*)\s*[:=]\s*([^\s]+)/gi, '$1=[REDACTED]')
    .trim();
}

function clip(value, limit) {
  var text = String(value || '');
  return text.length > limit ? text.slice(0, limit) + '\n…省略…' : text;
}

function conversationText(turns) {
  var values = Array.isArray(turns) ? turns.slice(-20) : [];
  return values.map(function (turn) {
    var prompt = clip(sanitizeUserFacingText(turn.prompt), 5000);
    var response = clip(sanitizeUserFacingText(turn.response), 7000);
    var actions = [];
    if (Array.isArray(turn.runCommands) && turn.runCommands.length) {
      actions.push('Ubuntu実行:\n' + turn.runCommands.join('\n'));
    }
    if (Array.isArray(turn.fileChanges) && turn.fileChanges.length) {
      actions.push('変更:\n' + turn.fileChanges.map(function (change) {
        return '- ' + String(change.path || '');
      }).join('\n'));
    }
    return 'ユーザー / システム\n' + (prompt || '(記録なし)') +
      '\n\nChatGPT\n' + (response || '(記録なし)') +
      (actions.length ? '\n\n' + actions.join('\n\n') : '');
  }).join('\n\n--------------------\n\n');
}

function historyText(entries) {
  return (entries || []).map(function (entry) {
    return formatDate(entry.at) + ' [' + (entry.assignee || '') + ' / ' +
      (entry.stage || '') + '] ' + (entry.message || '');
  }).join('\n');
}

function historyState(jobId) {
  if (!historyStates.has(jobId)) {
    historyStates.set(jobId, {paused: false, text: '', scrollTop: 0, status: '', autoScrolling: false});
  }
  return historyStates.get(jobId);
}

function detail(jobId, title, value, resultClass) {
  if (!value) return '';
  var key = jobId + ':' + title;
  return '<details data-detail-key="' + escapeHtml(key) + '"' +
    (resultClass ? ' class="result-details"' : '') +
    (detailStates.get(key) ? ' open' : '') + '><summary>' + escapeHtml(title) +
    '</summary><pre>' + escapeHtml(value) + '</pre></details>';
}

function historyDetail(job) {
  var latest = historyText(job.history);
  if (!latest) return '';
  var state = historyState(job.id);
  if (!state.paused) state.text = latest;
  var key = job.id + ':処理履歴を表示';
  return '<details class="history-details" data-detail-key="' + escapeHtml(key) +
    '" data-history-job-id="' + escapeHtml(job.id) + '"' +
    (detailStates.get(key) ? ' open' : '') + '><summary>処理履歴を表示</summary>' +
    '<div class="history-toolbar"><button type="button" data-history-action="pause">更新を一時停止</button>' +
    '<button type="button" data-history-action="latest">最新へ戻る</button>' +
    '<button type="button" data-history-action="copy">表示中をコピー</button>' +
    '<span class="history-status" data-history-status aria-live="polite">' +
    escapeHtml(state.status || (state.paused && latest !== state.text ? '更新停止中・新しい履歴あり' : state.paused ? '更新停止中' : '')) +
    '</span></div><pre class="history-log" tabindex="0">' + escapeHtml(state.text) + '</pre></details>';
}

function badges(job) {
  if (['completed', 'failed', 'stopped', 'blocked'].includes(job.stage)) {
    return '<div class="badges"><span class="badge stage-' + escapeHtml(job.stage) + '">' +
      escapeHtml(job.displayStatus) + '</span></div>';
  }
  return '<div class="badges"><span class="badge assignee-' + escapeHtml(job.assignee) +
    '">現在の担当: ' + escapeHtml(job.assignee) + '</span><span class="badge stage-' +
    escapeHtml(job.stage) + '">' + escapeHtml(job.stage) + '</span></div>';
}

function jobActions(job) {
  if (job.stage === 'completed') return '';
  var action = ['stopped', 'failed', 'blocked'].includes(job.stage) ? 'resume' : 'stop';
  return '<div class="job-actions"><button type="button" data-job-action="' + action +
    '" data-job-id="' + escapeHtml(job.id) + '">' + (action === 'stop' ? '停止' : '再実行') +
    '</button></div>';
}

function handoffActions(job) {
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
}

function renderJob(job) {
  var runtime = job.workerId ? '<div class="runtime">Worker: ' + escapeHtml(job.workerId) +
    ' · PID: ' + escapeHtml(job.pid || '-') + ' · 最終heartbeat: ' + escapeHtml(formatDate(job.heartbeatAt)) + '</div>' : '';
  return '<article id="job-' + escapeHtml(job.id) + '" class="job" data-job-id="' + escapeHtml(job.id) + '" data-updated-at="' +
    escapeHtml(job.updatedAt) + '"><div class="job-head"><div><h3>' + escapeHtml(job.title || '無題') +
    '</h3><p class="meta">登録: ' + escapeHtml(formatDate(job.createdAt)) + ' · ' + escapeHtml(job.project) +
    ' · ' + escapeHtml(job.id) + '</p></div>' + badges(job) + '</div>' +
    '<div class="facts"><span>段階: <strong>' + escapeHtml(job.stage) +
    '</strong></span><span>試行回数: <strong>' + escapeHtml(job.attempts) +
    '</strong></span><span>更新: <strong>' + escapeHtml(formatDate(job.updatedAt)) + '</strong></span></div>' +
    '<div class="facts"><span>工程: <strong>' + escapeHtml(job.phase || 'INSPECT') +
    '</strong></span><span>残りターン: <strong>' + escapeHtml(job.remainingTurns) +
    '</strong></span><span>変更ファイル: <strong>' + escapeHtml((job.changedFiles || []).length) +
    '</strong></span><span>戦略パス: <strong>' + escapeHtml(job.strategyPass || 1) + '</strong></span></div>' +
    runtime + recoveryInfo(job) + jobActions(job) + handoffActions(job) +
    '<div class="job-download"><a href="/api/jobs/' + encodeURIComponent(job.id) +
    '/transcript" download="transcript.json">このジョブのやり取りをダウンロード</a></div>' +
    detail(job.id, '指示を表示', job.instruction, false) +
    detail(job.id, 'ChatGPTとのやり取り', conversationText(job.conversationTurns), false) +
    detail(job.id, '最終結果を表示', job.result, true) +
    detail(job.id, 'ワーカーログを表示', job.workerLog, false) +
    detail(job.id, '変更トランザクションを表示', JSON.stringify(job.transactions || [], null, 2), false) +
    detail(job.id, '戦略変更履歴を表示', JSON.stringify(job.recoveryHistory || [], null, 2), false) +
    detail(job.id, 'チェックポイントを表示', job.checkpoint, false) +
    detail(job.id, '最終エラーを表示', job.lastError, false) + historyDetail(job) + '</article>';
}

function captureCard(card) {
  Array.from(card.querySelectorAll('details[data-detail-key]')).forEach(function (node) {
    detailStates.set(node.dataset.detailKey, node.open);
  });
  var history = card.querySelector('details.history-details');
  if (history) {
    var state = historyState(history.dataset.historyJobId);
    var log = history.querySelector('.history-log');
    if (log) state.scrollTop = log.scrollTop;
  }
}

function userIsReading(card) {
  if (card.contains(document.activeElement)) return true;
  var selection = window.getSelection && window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.anchorNode && card.contains(selection.anchorNode));
}

function scrollHistoryToBottom(detailsNode, state) {
  var log = detailsNode.querySelector('.history-log');
  if (!log) return;
  state.autoScrolling = true;
  requestAnimationFrame(function () {
    log.scrollTop = log.scrollHeight;
    state.scrollTop = log.scrollTop;
    setTimeout(function () { state.autoScrolling = false; }, 100);
  });
}

function restoreCard(card) {
  var history = card.querySelector('details.history-details');
  if (!history) return;
  var state = historyState(history.dataset.historyJobId);
  var log = history.querySelector('.history-log');
  if (!log) return;
  if (state.paused) {
    requestAnimationFrame(function () { log.scrollTop = state.scrollTop; });
    return;
  }
  scrollHistoryToBottom(history, state);
}

function applyFilters() {
  var keywordNode = document.getElementById('job-search');
  var statusNode = document.getElementById('job-status-filter');
  var keyword = keywordNode ? keywordNode.value.trim().toLowerCase() : '';
  var status = statusNode ? statusNode.value : 'all';
  var shown = 0;
  Array.from(document.querySelectorAll('#jobs .job')).forEach(function (card) {
    var job = cachedJobs.find(function (item) { return item.id === card.dataset.jobId; });
    var matchesKeyword = !keyword || (job && [job.title, job.instruction, job.id, job.project]
      .join(' ').toLowerCase().includes(keyword));
    var matchesStatus = status === 'all' || (job && (job.status === status || job.stage === status ||
      (status === 'completed' && job.stage === 'completed')));
    card.hidden = !(matchesKeyword && matchesStatus);
    if (!card.hidden) shown += 1;
  });
  var count = document.getElementById('job-result-count');
  if (count) count.textContent = '表示 ' + shown + ' / 全 ' + cachedJobs.length + ' 件';
}

async function refreshJobs() {
  try {
    var response = await fetch('/api/jobs', {cache: 'no-store'});
    if (!response.ok) return;
    var payload = await response.json();
    cachedJobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    updateQueueSummary(cachedJobs);
    var container = document.getElementById('jobs');
    if (!container) return;
    cachedJobs.forEach(function (job, index) {
      var existing = container.querySelector('.job[data-job-id="' + CSS.escape(job.id) + '"]');
      if (existing && existing.dataset.updatedAt !== job.updatedAt && !userIsReading(existing)) {
        captureCard(existing);
        var wrapper = document.createElement('div');
        wrapper.innerHTML = renderJob(job);
        var fresh = wrapper.firstElementChild;
        existing.replaceWith(fresh);
        existing = fresh;
      } else if (!existing) {
        var holder = document.createElement('div');
        holder.innerHTML = renderJob(job);
        existing = holder.firstElementChild;
        var reference = container.children[index] || null;
        container.insertBefore(existing, reference);
      }
      if (existing) restoreCard(existing);
    });
    applyFilters();
  } catch (_error) {
    return;
  }
}

async function copyText(value) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(value);
    return;
  }
  var textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  var copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('clipboard unavailable');
}

document.addEventListener('toggle', function (event) {
  var node = event.target;
  if (node && node.matches && node.matches('details[data-detail-key]')) {
    detailStates.set(node.dataset.detailKey, node.open);
    if (node.open && node.matches('details.history-details')) {
      var state = historyState(node.dataset.historyJobId);
      if (!state.paused) scrollHistoryToBottom(node, state);
    }
  }
}, true);

document.addEventListener('pointerdown', function (event) {
  var log = event.target.closest && event.target.closest('.history-log');
  if (!log) return;
  var detailsNode = log.closest('details.history-details');
  var state = historyState(detailsNode.dataset.historyJobId);
  state.paused = true;
  state.status = '更新停止中';
}, true);

document.addEventListener('scroll', function (event) {
  var log = event.target.closest && event.target.closest('.history-log');
  if (!log) return;
  var detailsNode = log.closest('details.history-details');
  var state = historyState(detailsNode.dataset.historyJobId);
  state.scrollTop = log.scrollTop;
  if (state.autoScrolling) return;
  state.paused = true;
  state.status = '更新停止中';
}, true);

document.addEventListener('click', async function (event) {
  var handoffButton = event.target.closest && event.target.closest('button[data-copy-handoff]');
  if (handoffButton) {
    var handoffContainer = handoffButton.closest('.handoff-actions');
    var handoffStatus = handoffContainer.querySelector('[data-handoff-status]');
    handoffButton.disabled = true;
    handoffStatus.textContent = '生成中...';
    try {
      var handoffResponse = await fetch('/api/jobs/' + encodeURIComponent(handoffButton.dataset.jobId) + '/handoff', {cache: 'no-store'});
      if (!handoffResponse.ok) throw new Error('handoff request failed');
      await copyText(await handoffResponse.text());
      handoffStatus.textContent = 'コピーしました';
    } catch (_error) {
      handoffStatus.textContent = 'コピーに失敗しました。Markdownを表示してください';
    } finally {
      handoffButton.disabled = false;
    }
    return;
  }

  var recoverButton = event.target.closest && event.target.closest('button[data-recover-job]');
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

  var historyButton = event.target.closest && event.target.closest('button[data-history-action]');
  if (historyButton) {
    var historyNode = historyButton.closest('details.history-details');
    var historyLog = historyNode.querySelector('.history-log');
    var state = historyState(historyNode.dataset.historyJobId);
    if (historyButton.dataset.historyAction === 'latest') {
      state.paused = false;
      state.status = '';
      scrollHistoryToBottom(historyNode, state);
      await refreshJobs();
    } else if (historyButton.dataset.historyAction === 'pause') {
      state.paused = true;
      state.status = '更新停止中';
    } else if (historyButton.dataset.historyAction === 'copy') {
      try { await copyText(historyLog.textContent); state.status = 'コピーしました'; }
      catch (_error) { state.status = 'コピーに失敗しました'; }
    }
    var statusNode = historyNode.querySelector('[data-history-status]');
    if (statusNode) statusNode.textContent = state.status;
    return;
  }

  var actionButton = event.target.closest && event.target.closest('button[data-job-action]');
  if (!actionButton) return;
  actionButton.disabled = true;
  try {
    await fetch('/api/jobs/' + encodeURIComponent(actionButton.dataset.jobId) + '/' + actionButton.dataset.jobAction, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: actionButton.dataset.jobAction === 'stop' ? JSON.stringify({reason: 'Web GUIから手動停止'}) : '{}'
    });
    await refreshJobs();
  } finally {
    actionButton.disabled = false;
  }
});

var search = document.getElementById('job-search');
var statusFilter = document.getElementById('job-status-filter');
if (search) search.addEventListener('input', applyFilters);
if (statusFilter) statusFilter.addEventListener('change', applyFilters);
void refreshJobs();
setInterval(refreshJobs, 3000);
window.__pseudoCodexClientV2 = {refreshJobs: refreshJobs, historyText: historyText};
}());`;

let mutationChain = Promise.resolve();

function ensureStorage() {
fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
if (!fs.existsSync(DATA_PATH)) {
fs.writeFileSync(DATA_PATH, "[]\n", {
encoding: "utf8",
mode: 0o600
});
}
}

function normalizeString(value) {
return typeof value === "string" ? value : "";
}

function compactText(value, limit) {
const text = normalizeString(value).replace(/\0/g, "");
if (text.length <= limit) {
return text;
}
return "[先頭を省略: 全" + text.length + "文字]\n" + text.slice(-limit);
}

function normalizeOptionalDate(value) {
const text = normalizeString(value);
if (!text) {
return "";
}
const parsed = new Date(text);
return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function normalizeDate(value, fallback) {
if (typeof value !== "string") {
return fallback;
}

const parsed = new Date(value);
return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function formatDateForDisplay(value) {
const parsed = new Date(value);
if (Number.isNaN(parsed.getTime())) {
return "";
}
return JST_DATE_FORMATTER.format(parsed) + " JST";
}

function normalizeHistory(value) {
if (!Array.isArray(value)) {
return [];
}

const normalized = [];

value
.filter(function(entry) {
return entry && typeof entry === "object";
})
.forEach(function(entry) {
const stage = STAGES.has(entry.stage) ? entry.stage : "queued";
let assignee = normalizeString(entry.assignee);

if (
!assignee &&
(stage === "completed" || stage === "failed") &&
normalized.length > 0
) {
const previousAssignee = normalized[normalized.length - 1].assignee;
if (previousAssignee === "Ubuntu" || previousAssignee === "ChatGPT") {
assignee = previousAssignee;
}
}

normalized.push({
at: normalizeDate(entry.at, new Date(0).toISOString()),
stage,
assignee: assignee || deriveAssignment(stage).assignee,
message: normalizeString(entry.message)
});
});

return normalized.slice(-200);
}

function normalizeConversationTurns(value) {
if (!Array.isArray(value)) {
return [];
}

return value
.filter(function(entry) {
return entry && typeof entry === "object";
})
.map(function(entry, index) {
return {
turn:
Number.isSafeInteger(entry.turn) && entry.turn > 0
? entry.turn
: index + 1,
sentAt: normalizeOptionalDate(entry.sentAt),
responseReceivedAt: normalizeOptionalDate(entry.responseReceivedAt),
prompt: compactText(entry.prompt, 120000),
response: compactText(entry.response, 120000),
runCommands: Array.isArray(entry.runCommands)
? entry.runCommands.slice(0, 50).map(function(command) {
return compactText(command, 20000);
})
: [],
fileChanges: Array.isArray(entry.fileChanges)
? entry.fileChanges.slice(0, 100).map(function(change) {
const item = change && typeof change === "object" ? change : {};
return {
path: compactText(item.path, 2000),
contentLength:
Number.isSafeInteger(item.contentLength) && item.contentLength >= 0
? item.contentLength
: 0
};
})
: [],
commandResults: Array.isArray(entry.commandResults)
? entry.commandResults.slice(0, 50).map(function(result) {
const item = result && typeof result === "object" ? result : {};
return {
command: compactText(item.command, 20000),
exitStatus: Number.isSafeInteger(item.exitStatus)
? item.exitStatus
: null,
timedOut: item.timedOut === true,
rejected: item.rejected === true,
output: compactText(item.output, 50000)
};
})
: [],
checkResults: Array.isArray(entry.checkResults)
? entry.checkResults.slice(0, 20).map(function(result) {
const item = result && typeof result === "object" ? result : {};
return {
command: compactText(item.command, 20000),
exitStatus: Number.isSafeInteger(item.exitStatus)
? item.exitStatus
: null,
output: compactText(item.output, 50000)
};
})
: []
};
})
.sort(function(left, right) {
return left.turn - right.turn;
})
.slice(-50);
}

function stageFromLegacyStatus(status) {
if (status === "done" || status === "completed") {
return "completed";
}

if (status === "needs_human" || status === "failed") {
return "failed";
}

if (status === "stopped" || status === "cancelled") {
return "stopped";
}

if (status === "blocked") {
return "blocked";
}

if (status === "running") {
return "waiting_chatgpt";
}

return "queued";
}

function deriveAssignment(stage) {
if (stage === "completed") {
return {
assignee: "完了",
displayStatus: "完了"
};
}

if (stage === "stopped") {
return {
assignee: "停止",
displayStatus: "停止"
};
}

if (stage === "blocked") {
return {
assignee: "保留",
displayStatus: "保留"
};
}

if (stage === "failed") {
return {
assignee: "失敗",
displayStatus: "失敗"
};
}

if (CHATGPT_STAGES.has(stage)) {
return {
assignee: "ChatGPT",
displayStatus: "ChatGPT回答待ち"
};
}

return {
assignee: "Ubuntu",
displayStatus: stage === "queued" ? "実行待ち" : "Ubuntuで実行中"
};
}

function composeResult(fields) {
if (normalizeString(fields.result).trim()) {
return normalizeString(fields.result).trim();
}

const sections = [
["最終回答", fields.finalAnswer],
["実行結果", fields.executionResult],
["検証結果", fields.verificationResult]
];

return sections
.filter(function(section) {
return normalizeString(section[1]).trim();
})
.map(function(section) {
return "【" + section[0] + "】\n" + normalizeString(section[1]).trim();
})
.join("\n\n");
}

function extractLogPath(workerLog) {
 const text = normalizeString(workerLog);
 const markers = ["Log:", "ログ:"];

 for (const marker of markers) {
 const markerIndex = text.indexOf(marker);
 if (markerIndex < 0) {
 continue;
 }

 const firstLine = text
 .slice(markerIndex + marker.length)
 .trim()
 .split(String.fromCharCode(10))[0]
 .trim();

 if (firstLine.startsWith("/") && firstLine.endsWith(".log")) {
 return firstLine;
 }
 }

 return "";
}

function readAllowedResultLog(workerLog) {
const logPath = extractLogPath(workerLog);
if (!logPath) {
return "";
}

const resolvedRoot = path.resolve(RESULT_LOG_ROOT);
const resolvedPath = path.resolve(logPath);

if (
resolvedPath !== resolvedRoot &&
!resolvedPath.startsWith(resolvedRoot + path.sep)
) {
return "";
}

try {
const stat = fs.statSync(resolvedPath);
if (!stat.isFile()) {
return "";
}
return compactText(fs.readFileSync(resolvedPath, "utf8").trim(), 50000);
} catch (_error) {
return "";
}
}

function readJobLogById(jobId) {
const safeId = normalizeString(jobId);
if (!/^[a-f0-9-]{20,80}$/i.test(safeId)) return "";
const logPath = path.join(path.resolve(RESULT_LOG_ROOT), safeId + ".log");
try {
const stat = fs.statSync(logPath);
return stat.isFile()
? compactText(fs.readFileSync(logPath, "utf8").trim(), 50000)
: "";
} catch (_error) {
return "";
}
}

function normalizeJob(value) {
const source = value && typeof value === "object" ? value : {};
const createdFallback = new Date(0).toISOString();
const createdAt = normalizeDate(source.createdAt, createdFallback);
const updatedAt = normalizeDate(source.updatedAt, createdAt);
const project = PROJECT_PATTERN.test(normalizeString(source.project))
? source.project
: DEFAULT_PROJECT;
const attempts =
Number.isSafeInteger(source.attempts) && source.attempts >= 0
? source.attempts
: 0;

const allowedStatuses = new Set([
"queued",
"running",
"done",
"completed",
"needs_human",
"failed",
"stopped",
"cancelled",
"blocked"
]);

const status = allowedStatuses.has(source.status)
? source.status
: "queued";

const stage = STAGES.has(source.stage)
? source.stage
: stageFromLegacyStatus(status);

const assignment = deriveAssignment(stage);
const history = normalizeHistory(source.history);
const conversationTurns = normalizeConversationTurns(
source.conversationTurns
);

if (history.length === 0) {
history.push({
at: updatedAt,
stage,
message: "既存ジョブから状態を補完"
});
}

const workerLog = compactText(source.workerLog, WORKER_LOG_LIMIT);
const hasStructuredResult = Boolean(
normalizeString(source.finalAnswer).trim() ||
normalizeString(source.executionResult).trim() ||
normalizeString(source.verificationResult).trim()
);
const finalAnswer = compactText(
source.finalAnswer || (!hasStructuredResult ? source.result : ""),
50000
);
const executionResult = compactText(source.executionResult, 50000);
const verificationResult = compactText(source.verificationResult, 50000);
const storedResult = composeResult({
result: "",
finalAnswer,
executionResult,
verificationResult
});

const result = compactText(
storedResult || (!hasStructuredResult ? source.result : "") || readAllowedResultLog(workerLog),
100000
);

return {
id: normalizeString(source.id) || crypto.randomUUID(),
project,
createdAt,
updatedAt,
attempts,
lastError: compactText(source.lastError, 20000),
workerLog,
title: normalizeString(source.title),
instruction: normalizeString(source.instruction),
kind: source.kind === "test" || source.isTest === true ? "test" : "job",
isTest: source.kind === "test" || source.isTest === true,
status,
stage,
assignee: assignment.assignee,
displayStatus: assignment.displayStatus,
result,
finalAnswer,
executionResult,
verificationResult,
workerId: normalizeString(source.workerId),
sessionId: normalizeString(source.sessionId),
pid: Number.isSafeInteger(source.pid) && source.pid > 0 ? source.pid : null,
heartbeatAt: normalizeOptionalDate(source.heartbeatAt),
activityAt: normalizeOptionalDate(source.activityAt) || updatedAt,
leaseExpiresAt: normalizeOptionalDate(source.leaseExpiresAt),
currentTurn: Number.isSafeInteger(source.currentTurn) && source.currentTurn >= 0
? source.currentTurn
: 0,
currentCommand: compactText(source.currentCommand, 2000),
phase: WORK_PHASES.has(source.phase) ? source.phase : "INSPECT",
remainingTurns: Number.isSafeInteger(source.remainingTurns) && source.remainingTurns >= 0
? source.remainingTurns
: 0,
strategyPass: Number.isSafeInteger(source.strategyPass) && source.strategyPass > 0
? source.strategyPass
: 1,
inspectTurns: Number.isSafeInteger(source.inspectTurns) && source.inspectTurns >= 0
? source.inspectTurns
: 0,
recoveryHistory: Array.isArray(source.recoveryHistory)
? source.recoveryHistory.filter(function(item) { return item && typeof item === "object"; }).slice(-10)
: [],
changedFiles: Array.isArray(source.changedFiles) ? source.changedFiles.map(String).slice(0, 100) : [],
transactions: Array.isArray(source.transactions)
? source.transactions.filter(function(item) { return item && typeof item === "object"; }).slice(-100)
: [],
errorClass: compactText(source.errorClass, 200),
checkpoint: compactText(source.checkpoint, 20000),
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
history
};
}

function readJobs() {
ensureStorage();

try {
const value = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
if (!Array.isArray(value)) {
return [];
}
return value.map(normalizeJob);
} catch (error) {
console.error("Failed to read jobs:", error);
return [];
}
}

function writeJobs(jobs) {
ensureStorage();
const temporaryPath = DATA_PATH + ".tmp";
const storedJobs = jobs.map(function(job) {
const stored = { ...job };
delete stored.result;
delete stored.assignee;
delete stored.displayStatus;
delete stored.isTest;
return stored;
});

fs.writeFileSync(
temporaryPath,
JSON.stringify(storedJobs, null, 2) + "\n",
{
encoding: "utf8",
mode: 0o600
}
);

fs.renameSync(temporaryPath, DATA_PATH);
}

function mutateJobs(mutator) {
const operation = mutationChain.then(function() {
const jobs = readJobs();
const result = mutator(jobs);
writeJobs(jobs);
return result;
});

mutationChain = operation.catch(function() {
return undefined;
});

return operation;
}

function appendHistory(job, stage, assignee, message) {
job.history.push({
at: new Date().toISOString(),
stage,
assignee,
message: normalizeString(message)
});

if (job.history.length > 200) {
job.history = job.history.slice(-200);
}
}

function applyStage(job, stage, message) {
const now = new Date().toISOString();
const previousAssignee = job.assignee;
const assignment = deriveAssignment(stage);
const terminal =
 TERMINAL_STAGES.has(stage);
const historyAssignee =
terminal &&
(previousAssignee === "Ubuntu" || previousAssignee === "ChatGPT")
? previousAssignee
: assignment.assignee;

job.stage = stage;
job.assignee = assignment.assignee;
job.displayStatus = assignment.displayStatus;
job.updatedAt = now;

if (stage === "queued") {
job.status = "queued";
} else if (stage === "completed") {
job.status = "done";
} else if (stage === "failed") {
job.status = "needs_human";
} else if (stage === "stopped") {
job.status = "stopped";
} else if (stage === "blocked") {
job.status = "blocked";
} else {
job.status = "running";
}

if (terminal) {
job.leaseExpiresAt = "";
}

appendHistory(
job,
stage,
historyAssignee,
message
);
}

function escapeHtml(value) {
 const entities = {
 38: String.fromCharCode(38, 97, 109, 112, 59),
 60: String.fromCharCode(38, 108, 116, 59),
 62: String.fromCharCode(38, 103, 116, 59),
 34: String.fromCharCode(38, 113, 117, 111, 116, 59),
 39: String.fromCharCode(38, 35, 51, 57, 59)
 };

 return Array.from(String(value))
 .map(function(character) {
 return entities[character.charCodeAt(0)] || character;
 })
 .join("");
}

function sendJson(response, statusCode, value) {
const body = JSON.stringify(value);

response.writeHead(statusCode, {
"Content-Type": "application/json; charset=utf-8",
"Content-Length": Buffer.byteLength(body),
"Cache-Control": "no-store"
});

response.end(body);
}

function sendJsonDownload(response, filename, value) {
const body = JSON.stringify(value, null, 2) + "\n";

response.writeHead(200, {
"Content-Type": "application/json; charset=utf-8",
"Content-Length": Buffer.byteLength(body),
"Content-Disposition": 'attachment; filename="' + filename + '"',
"Cache-Control": "no-store"
});

response.end(body);
}

function sendText(response, statusCode, body, filename) {
const value = String(body || "");
const headers = {
"Content-Type": "text/markdown; charset=utf-8",
"Content-Length": Buffer.byteLength(value),
"Cache-Control": "no-store"
};
if (filename) {
headers["Content-Disposition"] = 'inline; filename="' + filename + '"';
}
response.writeHead(statusCode, headers);
response.end(value);
}

function readProjectConfigs() {
try {
const value = JSON.parse(fs.readFileSync(PROJECT_CONFIG_PATH, "utf8"));
return value && typeof value === "object" && !Array.isArray(value)
? value
: {};
} catch (_error) {
return {};
}
}

function writeProjectConfigs(configs) {
const directory = path.dirname(PROJECT_CONFIG_PATH);
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(
PROJECT_CONFIG_PATH,
JSON.stringify(configs, null, 2) + "\n",
  "utf8"
);
}

function projectGitConfig(projectConfig) {
const git = projectConfig && typeof projectConfig.git === "object"
? projectConfig.git
: {};
return {
enabled: git.enabled === true,
repository: typeof git.repository === "string" ? git.repository.trim() : "",
remote: typeof git.remote === "string" && git.remote.trim() ? git.remote.trim() : "origin",
baseBranch: typeof git.baseBranch === "string" && git.baseBranch.trim() ? git.baseBranch.trim() : "main",
branchPrefix: typeof git.branchPrefix === "string" && git.branchPrefix.trim() ? git.branchPrefix.trim() : "chatgpt-job",
push: git.push === true
};
}

function projectSummary(name, projectConfig) {
const config = projectConfig && typeof projectConfig === "object" ? projectConfig : {};
const git = projectGitConfig(config);
const executionMode = ["github_direct", "local", "verify_only"].includes(config.executionMode)
? config.executionMode
: (git.enabled && git.repository ? "github_direct" : "local");
return {
name,
executionMode,
workspace: typeof config.workspace === "string" ? config.workspace : "",
productionRoot: typeof config.productionRoot === "string" ? config.productionRoot : "",
deployCommand: typeof config.deployCommand === "string" ? config.deployCommand : "",
verifyCommand: typeof config.verifyCommand === "string" ? config.verifyCommand : "",
service: typeof config.service === "string" ? config.service : "",
healthUrl: typeof config.healthUrl === "string" ? config.healthUrl : "",
deploymentOwner: typeof config.deploymentOwner === "string" ? config.deploymentOwner : "",
requiresDeployment: config.requiresDeployment === true,
githubFirst: GITHUB_FIRST_PROJECTS.has(name),
git
};
}

function redactSecrets(value) {
return String(value || "")
.replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+/gi, "$1 [REDACTED]")
.replace(/\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY)[A-Z0-9_]*)\s*[:=]\s*([^\s]+)/gi, "$1=[REDACTED]");
}

function sanitizeUserFacingText(value) {
return redactSecrets(value)
.replace(/[^]+/g, "")
.replace(/\bturn\d+(?:file|search|view|news)\d+\b/gi, "")
.replace(/\bfile_[0-9a-f]{16,}\b/gi, "")
.replace(/\bH\d{2,}\b/g, "")
.replace(/\s+id="[0-9a-f]{6,16}"/gi, "")
.trim();
}

function renderConversationText(turns) {
const values = Array.isArray(turns) ? turns.slice(-20) : [];
if (!values.length) return "";
return values.map(function(turn) {
const prompt = compactText(sanitizeUserFacingText(turn.prompt), 5000);
const response = compactText(sanitizeUserFacingText(turn.response), 7000);
const actions = [];
if (Array.isArray(turn.runCommands) && turn.runCommands.length) {
actions.push("Ubuntu実行:\n" + turn.runCommands.join("\n"));
}
if (Array.isArray(turn.fileChanges) && turn.fileChanges.length) {
actions.push("変更:\n" + turn.fileChanges.map(function(change) {
return "- " + String(change.path || "");
}).join("\n"));
}
return [
"ユーザー / システム",
prompt || "(記録なし)",
"",
"ChatGPT",
response || "(記録なし)",
actions.length ? "\n" + actions.join("\n\n") : ""
].join("\n");
}).join("\n\n--------------------\n\n");
}

function buildChatGptHandoff(job) {
const config = readProjectConfigs()[job.project] || {};
const recentHistory = renderHistory(job.history.slice(-30));
const conversation = job.conversationTurns.slice(-12).map(function(turn) {
return [
"### Turn ", String(turn.turn || "?"), "\n",
"ChatGPT:\n", compactText(turn.response, 4000), "\n",
turn.runCommands.length
? "RUN commands: " + JSON.stringify(turn.runCommands) + "\n"
: "",
turn.fileChanges.length
? "File changes: " + JSON.stringify(turn.fileChanges) + "\n"
: ""
].join("");
}).join("\n");
const rawLog = readAllowedResultLog(job.workerLog) || readJobLogById(job.id);
const hostConfig = Object.fromEntries(
Object.entries(config).filter(function(entry) {
return entry[0] !== ["sandbox", "Workspace"].join("");
})
);
const hostContract = Object.keys(hostConfig).length
? JSON.stringify(hostConfig, null, 2)
: "PROJECT CONFIGURATION IS MISSING";

return redactSecrets([
"# Pseudo Codex job handoff for ChatGPT",
"",
"> This document is generated for ChatGPT troubleshooting and continuation.",
"> Do not merely restate the error. Identify the failed assumption and propose the next concrete implementation strategy.",
"",
"## Job",
"- Job ID: " + job.id,
"- Project: " + job.project,
"- Title: " + (job.title || "(untitled)"),
"- Status: " + job.status,
"- Stage: " + job.stage,
"- Phase: " + job.phase,
"- Current turn: " + job.currentTurn,
"- Strategy pass: " + job.strategyPass,
"- Inspection turns in this pass: " + job.inspectTurns,
"- Attempts: " + job.attempts,
"- Error class: " + (job.errorClass || "(none)"),
"- Updated: " + formatDateForDisplay(job.updatedAt),
"",
"## Authoritative execution and deployment contract",
"```json",
hostContract,
"```",
"",
"Important: local and verification jobs run directly on the Ubuntu host in the configured workspace or a dedicated host Git worktree. The dispatcher owns Git publication, deployment, and production verification after `===TASK_COMPLETE===`.",
"",
"## Original request",
job.instruction || "(empty)",
"",
"## Last error",
job.lastError || "(none)",
"",
"## Changed files",
job.changedFiles.length ? job.changedFiles.map(function(file) { return "- " + file; }).join("\n") : "(none)",
"",
"## Transactions",
"```json",
JSON.stringify(job.transactions, null, 2),
"```",
"",
"## Checkpoint",
job.checkpoint || "(none)",
"",
"## Strategy recovery history",
job.recoveryHistory.length ? JSON.stringify(job.recoveryHistory, null, 2) : "(none)",
"",
"## Final/result fields",
compactText(job.result, 12000) || "(none)",
"",
"## Recent controller history",
recentHistory || "(none)",
"",
"## Recent ChatGPT turns",
conversation || "(not recorded)",
"",
"## Recent browser-agent log",
"```text",
compactText(rawLog, 24000) || "(log unavailable)",
"```",
"",
"## Required continuation behavior",
"1. Preserve successful file changes and verified facts.",
"2. Do not repeat a failed command; inspect Ubuntu host state directly with non-destructive commands when the request concerns the host.",
"3. Choose a materially different strategy when the same failure recurs.",
"4. Return the smallest executable next action, then verify it.",
""
].join("\n"));
}

function buildJobTranscript(job) {
const transcriptJob = { ...job };
delete transcriptJob.conversationTurns;

return {
format: "pseudo-codex-job-transcript",
version: 2,
exportedAt: new Date().toISOString(),
rallies: job.conversationTurns,
job: transcriptJob,
conversationLog: readAllowedResultLog(job.workerLog)
};
}

function sendEmpty(response, statusCode) {
response.writeHead(statusCode, {
"Cache-Control": "no-store"
});
response.end();
}

function sendHtml(response, statusCode, body) {
response.writeHead(statusCode, {
"Content-Type": "text/html; charset=utf-8",
"Content-Length": Buffer.byteLength(body),
"Cache-Control": "no-store"
});
response.end(body);
}

function readBody(request) {
return new Promise(function(resolve, reject) {
let body = "";
let rejected = false;

request.setEncoding("utf8");

request.on("data", function(chunk) {
  if (rejected) {
    return;
  }

  body += chunk;

  if (body.length > 1000000) {
    rejected = true;
    reject(new Error("request body too large"));
    request.destroy();
  }
});

request.on("end", function() {
  if (!rejected) {
    resolve(body);
  }
});

request.on("error", reject);

});
}

function parseBody(request, body) {
const contentType = String(
request.headers["content-type"] || ""
)
.split(";")[0]
.trim()
.toLowerCase();

if (contentType === "application/json") {
const value = JSON.parse(body || "{}");

if (!value || typeof value !== "object" || Array.isArray(value)) {
  throw new Error("JSON object required");
}

return value;

}

return Object.fromEntries(new URLSearchParams(body));
}

function parseJobRequest(request, body) {
const value = parseBody(request, body);

return {
project: String(value.project || DEFAULT_PROJECT).trim(),
title: String(value.title || "").trim(),
instruction: String(value.instruction || "").trim(),
kind: value.kind === "test" || value.isTest === true ? "test" : "job"
};
}

function parseBooleanField(value) {
if (value === true) return true;
const normalized = String(value || "").trim().toLowerCase();
return normalized === "true" || normalized === "1" || normalized === "on" || normalized === "yes";
}

function parseProjectConfigRequest(request, body) {
const value = parseBody(request, body);
const name = String(value.name || value.project || "").trim();
const workspace = String(value.workspace || "").trim();
const requiresDeployment = parseBooleanField(value.requiresDeployment);
const gitEnabled = parseBooleanField(value.gitEnabled);
const gitPush = parseBooleanField(value.gitPush);
const requestedMode = String(value.executionMode || "").trim();
const executionMode = ["github_direct", "local", "verify_only"].includes(requestedMode)
? requestedMode
: (gitEnabled ? "github_direct" : "local");
const config = {
executionMode,
workspace,
productionRoot: String(value.productionRoot || "").trim(),
deployCommand: String(value.deployCommand || "").trim(),
verifyCommand: String(value.verifyCommand || "").trim(),
service: String(value.service || "").trim(),
healthUrl: String(value.healthUrl || "").trim(),
deploymentOwner: String(value.deploymentOwner || "").trim(),
requiresDeployment,
git: {
enabled: gitEnabled,
repository: String(value.gitRepository || "").trim(),
remote: String(value.gitRemote || "origin").trim() || "origin",
baseBranch: String(value.gitBaseBranch || "main").trim() || "main",
branchPrefix: String(value.gitBranchPrefix || "chatgpt-job").trim() || "chatgpt-job",
push: gitPush
}
};

if (!PROJECT_PATTERN.test(name)) {
throw new Error("project name must match [a-z0-9][a-z0-9-]{0,63}");
}
if (!workspace) {
throw new Error("workspace is required");
}
if (requiresDeployment && !config.deployCommand) {
throw new Error("deployCommand is required when requiresDeployment is true");
}
if (gitEnabled && !PROJECT_PATTERN.test(config.git.branchPrefix.replace(/[/.]/g, "-"))) {
throw new Error("git branch prefix must be a simple slug-like value");
}
if (executionMode === "github_direct" && !gitEnabled) {
throw new Error("GitHub直接編集にはGit管理を有効にしてください");
}
if (executionMode === "github_direct" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.git.repository)) {
throw new Error("GitHub直接編集には owner/repository 形式のRepositoryが必要です");
}

return {
name,
config
};
}

function boundedInteger(value, minimum, maximum, fallback) {
const parsed = Number.parseInt(String(value || ""), 10);
return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
? parsed
: fallback;
}

function parseWorkerRequest(request, body) {
const value = parseBody(request, body);
return {
workerId: String(value.workerId || "").trim().slice(0, 200),
sessionId: String(value.sessionId || "").trim().slice(0, 200),
pid: boundedInteger(value.pid, 1, 2147483647, null),
leaseSeconds: boundedInteger(value.leaseSeconds, 30, 86400, 300),
excludedProjects: Array.isArray(value.excludedProjects)
? value.excludedProjects.map(String).filter(function(project) {
return PROJECT_PATTERN.test(project);
}).slice(0, 100)
: []
};
}

function parseProgressRequest(request, body) {
const value = parseBody(request, body);
const changedFiles = Array.isArray(value.changedFiles) ? value.changedFiles.map(String).slice(0, 100) : [];
const transactions = Array.isArray(value.transactions)
? value.transactions.filter(function(item) { return item && typeof item === "object"; }).slice(-100)
: [];

return {
stage: String(value.stage || "").trim(),
message: String(value.message || ""),
workerId: String(value.workerId || "").trim().slice(0, 200),
sessionId: String(value.sessionId || "").trim().slice(0, 200),
pid: boundedInteger(value.pid, 1, 2147483647, null),
leaseSeconds: boundedInteger(value.leaseSeconds, 30, 86400, 300),
 currentCommand: String(value.currentCommand || "").slice(0, 2000),
 phase: WORK_PHASES.has(value.phase) ? value.phase : "",
 remainingTurns: boundedInteger(value.remainingTurns, 0, 1000, null),
 strategyPass: boundedInteger(value.strategyPass, 1, 100, null),
 inspectTurns: boundedInteger(value.inspectTurns, 0, 1000, null),
 recoveryHistory: Array.isArray(value.recoveryHistory)
 ? value.recoveryHistory.filter(function(item) { return item && typeof item === "object"; }).slice(-10)
 : [],
 changedFiles,
 transactions,
 errorClass: String(value.errorClass || "").slice(0, 200),
 checkpoint: String(value.checkpoint || "").slice(0, 20000),
 chatConversationId: String(value.chatConversationId || "").slice(0, 300),
 chatConversationUrl: String(value.chatConversationUrl || "").slice(0, 2000),
 workerSessionId: String(value.workerSessionId || "").slice(0, 300)
};
}

function parseTurnRequest(request, body) {
const value = parseBody(request, body);

return {
turn: boundedInteger(value.turn, 1, 100000, null),
sentAt: String(value.sentAt || ""),
responseReceivedAt: String(value.responseReceivedAt || ""),
prompt: String(value.prompt || ""),
response: String(value.response || ""),
runCommands: value.runCommands,
fileChanges: value.fileChanges,
commandResults: value.commandResults,
checkResults: value.checkResults
};
}

function parseStopRequest(request, body) {
const value = parseBody(request, body);
return {
reason: String(value.reason || "Web GUIから手動停止").trim().slice(0, 2000)
};
}

function parseResultRequest(request, body) {
const value = parseBody(request, body);

return {
status: String(value.status || "").trim(),
lastError: String(value.lastError || ""),
workerLog: String(value.workerLog || ""),
result: String(value.result || ""),
finalAnswer: String(value.finalAnswer || ""),
executionResult: String(value.executionResult || ""),
verificationResult: String(value.verificationResult || ""),
workerId: String(value.workerId || "").trim().slice(0, 200),
sessionId: String(value.sessionId || "").trim().slice(0, 200),
pid: boundedInteger(value.pid, 1, 2147483647, null)
};
}

function createJob(project, title, instruction, kind) {
const now = new Date().toISOString();
const assignment = deriveAssignment("queued");

const job = {
id: crypto.randomUUID(),
project,
createdAt: now,
updatedAt: now,
attempts: 0,
lastError: "",
workerLog: "",
title,
instruction,
kind: kind === "test" ? "test" : "job",
isTest: kind === "test",
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
recoveryHistory: [],
changedFiles: [],
transactions: [],
errorClass: "",
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
conversationTurns: [],
history: [
{
at: now,
stage: "queued",
assignee: assignment.assignee,
message: "ジョブを登録"
}
]
};

return mutateJobs(function(jobs) {
jobs.unshift(job);
return job;
});
}

function applyWorkerLease(job, worker) {
const now = new Date();
if (worker.workerId) {
job.workerId = worker.workerId;
}
if (worker.sessionId) {
job.sessionId = worker.sessionId;
}
if (worker.pid) {
job.pid = worker.pid;
}
job.heartbeatAt = now.toISOString();
job.leaseExpiresAt = new Date(
now.getTime() + worker.leaseSeconds * 1000
).toISOString();
}

function isStaleWorkerUpdate(job, worker) {
return Boolean(
(job.sessionId && worker.sessionId && job.sessionId !== worker.sessionId) ||
(job.pid && worker.pid && job.pid !== worker.pid)
);
}

function claimOldestJob(worker) {
return mutateJobs(function(jobs) {
let selectedIndex = -1;
let selectedTime = Number.POSITIVE_INFINITY;

for (let index = 0; index < jobs.length; index += 1) {
  const job = jobs[index];

  if (
    job.status !== "queued" ||
    job.stage !== "queued" ||
    job.kind === "test" ||
    job.isTest === true ||
    worker.excludedProjects.includes(job.project)
  ) {
    continue;
  }

  const timestamp = new Date(job.createdAt).getTime();
  const comparableTime = Number.isNaN(timestamp) ? 0 : timestamp;

  if (
    selectedIndex === -1 ||
    comparableTime < selectedTime
  ) {
    selectedIndex = index;
    selectedTime = comparableTime;
  }
}

if (selectedIndex === -1) {
  return null;
}

const job = jobs[selectedIndex];
job.attempts += 1;
job.activityAt = new Date().toISOString();
applyWorkerLease(job, worker);
applyStage(
  job,
  "sending_to_chatgpt",
  "DispatcherがChatGPTブラウザエージェントへ送信"
);

return job;

});
}

function updateJobProgress(id, progress) {
return mutateJobs(function(jobs) {
const job = jobs.find(function(candidate) {
return candidate.id === id;
});

if (!job) {
  return null;
}

if (isStaleWorkerUpdate(job, progress)) {
  return job;
}

applyStage(job, progress.stage, progress.message);
job.activityAt = job.updatedAt;
const turnMatch = progress.message.match(/\bturn=(\d+)\b/);
if (turnMatch) {
job.currentTurn = Number.parseInt(turnMatch[1], 10);
}
if (progress.currentCommand) {
job.currentCommand = progress.currentCommand;
}
if (progress.phase) job.phase = progress.phase;
if (progress.remainingTurns !== null) job.remainingTurns = progress.remainingTurns;
if (progress.strategyPass !== null) job.strategyPass = progress.strategyPass;
if (progress.inspectTurns !== null) job.inspectTurns = progress.inspectTurns;
if (progress.recoveryHistory.length > 0) job.recoveryHistory = progress.recoveryHistory;
if (progress.changedFiles.length > 0) job.changedFiles = progress.changedFiles;
if (progress.transactions.length > 0) job.transactions = progress.transactions;
if (progress.errorClass) job.errorClass = progress.errorClass;
if (progress.checkpoint) job.checkpoint = progress.checkpoint;
if (progress.chatConversationId) job.chatConversationId = progress.chatConversationId;
if (progress.chatConversationUrl) job.chatConversationUrl = progress.chatConversationUrl;
if (progress.workerSessionId) job.workerSessionId = progress.workerSessionId;
if (job.workerId || progress.workerId) {
applyWorkerLease(job, {
workerId: progress.workerId || job.workerId,
sessionId: progress.sessionId || job.sessionId,
pid: progress.pid || job.pid,
leaseSeconds: progress.leaseSeconds
});
}
return job;

});
}

function updateJobTurn(id, value) {
return mutateJobs(function(jobs) {
const job = jobs.find(function(candidate) {
return candidate.id === id;
});

if (!job) {
return null;
}

const normalized = normalizeConversationTurns([value])[0];
const existingIndex = job.conversationTurns.findIndex(function(entry) {
return entry.turn === normalized.turn;
});

if (existingIndex >= 0) {
job.conversationTurns[existingIndex] = normalized;
} else {
job.conversationTurns.push(normalized);
job.conversationTurns.sort(function(left, right) {
return left.turn - right.turn;
});
job.conversationTurns = job.conversationTurns.slice(-50);
}

const now = new Date().toISOString();
job.updatedAt = now;
job.activityAt = now;
job.currentTurn = Math.max(job.currentTurn, normalized.turn);

return job;
});
}

function heartbeatJob(id, heartbeat) {
return mutateJobs(function(jobs) {
const job = jobs.find(function(candidate) {
return candidate.id === id;
});

if (!job || TERMINAL_STAGES.has(job.stage)) {
return null;
}
if (job.sessionId && heartbeat.sessionId !== job.sessionId) {
return null;
}
applyWorkerLease(job, heartbeat);
return job;
});
}

function stopJob(id, reason) {
return mutateJobs(function(jobs) {
const job = jobs.find(function(candidate) {
return candidate.id === id;
});
if (!job) {
return null;
}
const stopReason = reason || "手動停止";
const descendantIds = new Set([job.id]);
let discovered = true;
while (discovered) {
discovered = false;
jobs.forEach(function(candidate) {
if (!descendantIds.has(candidate.id) && descendantIds.has(candidate.parentJobId)) {
descendantIds.add(candidate.id);
discovered = true;
}
});
}

jobs.forEach(function(candidate) {
if (!descendantIds.has(candidate.id) || candidate.stage === "completed") return;
candidate.lastError = "";
candidate.currentCommand = "";
if (candidate.id === job.id || !["failed", "stopped", "blocked"].includes(candidate.stage)) {
applyStage(candidate, "stopped", candidate.id === job.id ? stopReason : "親ジョブの停止により停止");
}
});
return job;
});
}

function resumeJob(id) {
return mutateJobs(function(jobs) {
const job = jobs.find(function(candidate) {
return candidate.id === id;
});
if (!job) {
return null;
}
if (!["stopped", "failed", "blocked"].includes(job.stage)) {
return job;
}
const activeDescendant = jobs.some(function(candidate) {
return candidate.parentJobId === job.id &&
  ["queued", "sending_to_chatgpt", "waiting_chatgpt", "executing_command", "writing_file", "verifying"].includes(candidate.stage);
});
if (activeDescendant) {
appendHistory(job, job.stage, job.assignee, "継続ジョブが未完了のため元ジョブの再実行を拒否");
return job;
}
job.workerId = "";
job.sessionId = "";
job.pid = null;
job.heartbeatAt = "";
job.leaseExpiresAt = "";
job.currentCommand = "";
applyStage(job, "queued", "手動で再実行待ちへ移動");
return job;
});
}

function getAutoHandoffMax() {
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
if (!["failed", "blocked"].includes(job.stage)) return null;
return createContinuationJob(
jobs,
job,
job.lastError || "Web GUIから別の実装方法を要求",
false
);
});
}

function updateJobResult(id, result) {
return mutateJobs(function(jobs) {
const job = jobs.find(function(candidate) {
return candidate.id === id;
});

if (!job) {
  return null;
}

if (["stopped", "blocked"].includes(job.stage) && result.status !== job.status) {
return job;
}

if (isStaleWorkerUpdate(job, result)) {
return job;
}

job.lastError = compactText(result.lastError, 20000);
job.workerLog = compactText(result.workerLog, WORKER_LOG_LIMIT);
job.finalAnswer = compactText(result.finalAnswer, 50000);
job.executionResult = compactText(result.executionResult, 50000);
job.verificationResult = compactText(result.verificationResult, 50000);

const composed = composeResult(result);
const logResult = readAllowedResultLog(result.workerLog);
job.result = composed || logResult || result.workerLog;

if (
  result.status === "done" ||
  result.status === "completed"
) {
  job.phase = "COMPLETE";
  applyStage(job, "completed", "処理結果を保存");
} else if (
  result.status === "needs_human" ||
  result.status === "failed"
) {
  applyStage(
    job,
    "failed",
    result.lastError || "処理失敗"
  );
} else if (result.status === "stopped") {
  job.phase = "BLOCKED";
  applyStage(job, "stopped", result.lastError || "処理停止");
} else if (result.status === "blocked") {
  job.phase = "BLOCKED";
  applyStage(job, "blocked", result.lastError || "自動継続を保留");
} else {
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
}

function renderDetails(jobId, title, value, open, isResult) {
if (!value) {
return "";
}

return [
"<details",
' data-detail-key="',
escapeHtml(jobId + ":" + title),
'"',
isResult ? ' class="result-details"' : "",
open ? " open" : "",
">",
"<summary>",
escapeHtml(title),
"</summary>",
"<pre>",
escapeHtml(value),
"</pre>",
"</details>"
].join("");
}

function renderHistory(history) {
if (!history.length) {
return "";
}

return history
.map(function(entry) {
const assignee =
normalizeString(entry.assignee) ||
deriveAssignment(entry.stage).assignee;

return [
formatDateForDisplay(entry.at),
" [",
assignee,
" / ",
entry.stage,
"] ",
entry.message
].join("");
})
.join("\n");
}

function renderHistoryDetails(jobId, history, open) {
const value = renderHistory(history);
if (!value) {
return "";
}

return [
'<details class="history-details"',
' data-detail-key="',
escapeHtml(jobId + ":処理履歴を表示"),
'" data-history-job-id="',
escapeHtml(jobId),
'"',
open ? " open" : "",
">",
"<summary>処理履歴を表示</summary>",
'<div class="history-toolbar">',
'<button type="button" data-history-action="pause">',
"更新を一時停止",
"</button>",
'<button type="button" data-history-action="latest">',
"最新へ戻る",
"</button>",
'<button type="button" data-history-action="copy">',
"表示中をコピー",
"</button>",
'<span class="history-status" data-history-status aria-live="polite"></span>',
"</div>",
'<pre class="history-log" tabindex="0">',
escapeHtml(value),
"</pre>",
"</details>"
].join("");
}

function renderJobBadges(job) {
if (TERMINAL_STAGES.has(job.stage)) {
return [
'<div class="badges">',
'<span class="badge stage-', escapeHtml(job.stage), '">',
escapeHtml(job.displayStatus),
"</span>",
"</div>"
].join("");
}

return [
'<div class="badges">',
'<span class="badge assignee-', escapeHtml(job.assignee), '">',
"現在の担当: ",
escapeHtml(job.assignee),
"</span>",
'<span class="badge stage-', escapeHtml(job.stage), '">',
escapeHtml(job.stage),
"</span>",
"</div>"
].join("");
}

function renderJobActions(job) {
if (job.stage === "completed") {
return "";
}
const action = ["stopped", "failed", "blocked"].includes(job.stage)
? "resume"
: "stop";
return [
'<div class="job-actions">',
'<button type="button" data-job-action="', action,
'" data-job-id="', escapeHtml(job.id), '">',
action === "stop" ? "停止" : "再実行",
"</button></div>"
].join("");
}

function renderHandoffActions(job) {
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
}

function renderRuntime(job) {
if (!job.workerId) {
return "";
}
return [
'<div class="runtime">Worker: ', escapeHtml(job.workerId),
' · PID: ', escapeHtml(job.pid || "-"),
' · 最終heartbeat: ', escapeHtml(formatDateForDisplay(job.heartbeatAt)),
job.currentTurn ? ' · ChatGPT turn: ' + escapeHtml(job.currentTurn) : "",
"</div>"
].join("");
}

function renderJobCard(job) {
return [
'<article id="job-', escapeHtml(job.id), '" class="job" data-job-id="', escapeHtml(job.id), '" data-updated-at="', escapeHtml(job.updatedAt), '">',
'<div class="job-head">',
"<div>",
"<h3>",
escapeHtml(job.title || "無題"),
"</h3>",
'<p class="meta">',
"登録: ",
escapeHtml(formatDateForDisplay(job.createdAt)),
" · ",
escapeHtml(job.project),
" · ",
escapeHtml(job.id),
"</p>",
"</div>",
renderJobBadges(job),
"</div>",
'<div class="facts">',
"<span>段階: <strong>",
escapeHtml(job.stage),
"</strong></span>",
"<span>試行回数: <strong>",
escapeHtml(job.attempts),
"</strong></span>",
"<span>更新: <strong>",
escapeHtml(formatDateForDisplay(job.updatedAt)),
"</strong></span>",
"</div>",
'<div class="facts"><span>工程: <strong>', escapeHtml(job.phase),
'</strong></span><span>残りターン: <strong>', escapeHtml(job.remainingTurns),
'</strong></span><span>変更ファイル: <strong>', escapeHtml(job.changedFiles.length),
"</strong></span><span>戦略パス: <strong>", escapeHtml(job.strategyPass),
"</strong></span></div>",
renderRuntime(job),
renderRecoveryInfo(job),
renderJobActions(job),
renderHandoffActions(job),
['<div class="job-download"><a href="/api/jobs/', encodeURIComponent(job.id), '/transcript" download="transcript.json">このジョブのやり取りをダウンロード</a></div>'].join(""),
renderDetails(job.id, "指示を表示", job.instruction, false, false),
renderDetails(job.id, "ChatGPTとのやり取り", renderConversationText(job.conversationTurns), false, false),
renderDetails(job.id, "最終結果を表示", job.result, false, true),
renderDetails(job.id, "ワーカーログを表示", job.workerLog, false, false),
renderDetails(job.id, "変更トランザクションを表示", JSON.stringify(job.transactions, null, 2), false, false),
renderDetails(job.id, "チェックポイントを表示", job.checkpoint, false, false),
renderDetails(job.id, "最終エラーを表示", job.lastError, job.stage === "failed", false),
renderHistoryDetails(job.id, job.history, false),
"</article>"
].join("");
}

function renderJobs(jobs) {
if (jobs.length === 0) {
return '<p class="empty">登録済みジョブはありません。</p>';
}

return jobs.map(renderJobCard).join("");
}

function renderQueueSummary(jobs) {
const counts = {
running: jobs.filter(function(job) { return job.status === "running"; }).length,
queued: jobs.filter(function(job) { return job.stage === "queued"; }).length,
failed: jobs.filter(function(job) { return job.stage === "failed" || job.stage === "blocked"; }).length,
stopped: jobs.filter(function(job) { return job.stage === "stopped"; }).length
};
return [
'<section id="queue-summary" class="queue-summary" aria-live="polite">',
'<div><strong>いま動いている:</strong> ', String(counts.running), ' 件</div>',
'<div><strong>実行待ち:</strong> ', String(counts.queued), ' 件</div>',
'<div><strong>失敗・保留:</strong> ', String(counts.failed), ' 件</div>',
'<div><strong>停止済み:</strong> ', String(counts.stopped), ' 件</div>',
'<p>「実行中」はUbuntu上のworkerが担当中です。停止を押したジョブは次回更新で「停止済み」に変わります。</p>',
'</section>'
].join("");
}

function renderProjectOptions() {
const names = Object.keys(readProjectConfigs())
.filter(function(name) { return PROJECT_PATTERN.test(name); })
.sort(function(left, right) {
if (left === DEFAULT_PROJECT) return -1;
if (right === DEFAULT_PROJECT) return 1;
return left.localeCompare(right);
});
if (names.length === 0) names.push(DEFAULT_PROJECT);
return names.map(function(name) {
return '<option value="' + escapeHtml(name) + '"' +
(name === DEFAULT_PROJECT ? " selected" : "") + ">" +
escapeHtml(name) + "</option>";
}).join("");
}

function renderProjectCatalog() {
const configs = readProjectConfigs();
const names = Object.keys(configs)
.filter(function(name) { return PROJECT_PATTERN.test(name); })
.sort(function(left, right) {
if (left === DEFAULT_PROJECT) return -1;
if (right === DEFAULT_PROJECT) return 1;
return left.localeCompare(right);
});

if (names.length === 0) {
return '<p class="empty">まだプロジェクト設定がありません。下のフォームから追加してください。</p>';
}

return names.map(function(name) {
const summary = projectSummary(name, configs[name]);
const executionMode = summary.executionMode === "github_direct"
? "GitHub直接編集"
: summary.executionMode === "verify_only" ? "検証のみ" : "Ubuntuホスト直接実行";
const gitMode = summary.git.enabled
? (summary.git.push ? "GitHub正本・push有効" : "Git管理あり・push無効")
: "ローカル作業のみ";
const deployMode = summary.requiresDeployment
? (summary.deployCommand ? "ホスト反映あり" : "要反映だが deployCommand 未設定")
: "反映不要";
const note = name === DEFAULT_PROJECT
? '<div class="project-note"><strong>固定ルール:</strong> このプロジェクトは GitHub main から pull --ff-only した内容だけを deploy します。サンドボックス変更物をそのまま本番へ反映しません。</div>'
: "";
return [
'<article class="project-card">',
'<div class="project-card-head"><h3>', escapeHtml(name), '</h3>',
summary.healthUrl ? '<a href="' + escapeHtml(summary.healthUrl) + '" target="_blank" rel="noopener">health</a>' : "",
'</div>',
'<div class="project-facts"><span>Workspace: <strong>', escapeHtml(summary.workspace || "(未設定)"), '</strong></span></div>',
'<div class="project-facts"><span>配備: <strong>', escapeHtml(deployMode), '</strong></span><span>Git: <strong>', escapeHtml(gitMode), '</strong></span></div>',
'<div class="project-facts"><span>実行方式: <strong>', escapeHtml(executionMode), '</strong></span></div>',
summary.productionRoot ? '<div class="project-facts"><span>Production Root: <strong>' + escapeHtml(summary.productionRoot) + '</strong></span></div>' : "",
summary.service ? '<div class="project-facts"><span>Service: <strong>' + escapeHtml(summary.service) + '</strong></span></div>' : "",
summary.git.enabled ? '<div class="project-facts"><span>Repository: <strong>' + escapeHtml(summary.git.repository || "(未設定)") + '</strong></span><span>Remote: <strong>' + escapeHtml(summary.git.remote) + '</strong></span><span>Base: <strong>' + escapeHtml(summary.git.baseBranch) + '</strong></span><span>Branch Prefix: <strong>' + escapeHtml(summary.git.branchPrefix) + '</strong></span><span>Deploy Source: <strong>' + escapeHtml(summary.githubFirst ? "GitHub main only" : "workspace") + '</strong></span></div>' : "",
note,
'</article>'
].join("");
}).join("");
}

function renderProjectConfigForm() {
return [
'<form method="post" action="/projects" class="project-config-form">',
'<div class="project-config-grid">',
'<div><label for="project-config-name">プロジェクト名</label><input id="project-config-name" name="name" maxlength="64" placeholder="wordpress-demo" required></div>',
'<div><label for="project-config-mode">実行方式</label><select id="project-config-mode" name="executionMode">' +
'<option value="github_direct">GitHub直接編集（推奨）</option>' +
'<option value="local">Ubuntuホスト直接実行</option>' +
'<option value="verify_only">検証のみ</option>' +
'</select></div>',
'<div><label for="project-config-workspace">Workspace</label><input id="project-config-workspace" name="workspace" maxlength="500" placeholder="/home/ubuntu/chatgpt-projects/wordpress-demo" required></div>',
'<div><label for="project-config-health">Health URL</label><input id="project-config-health" name="healthUrl" maxlength="500" placeholder="http://127.0.0.1:8080/health"></div>',
'<div><label for="project-config-production">Production Root</label><input id="project-config-production" name="productionRoot" maxlength="500" placeholder="/opt/pseudo-codex-console"></div>',
'<div><label for="project-config-service">Service / Container</label><input id="project-config-service" name="service" maxlength="300" placeholder="pseudo-codex-console.service"></div>',
'<div><label for="project-config-deploy">Deploy Command</label><input id="project-config-deploy" name="deployCommand" maxlength="500" placeholder="/usr/local/libexec/pseudo-codex-deploy-request-console"></div>',
'<div><label for="project-config-verify">Verify Command</label><input id="project-config-verify" name="verifyCommand" maxlength="500" placeholder="/usr/local/lib/pseudo-codex-console-deploy/verify-live.js"></div>',
'<div><label for="project-config-owner">Deployment Owner</label><input id="project-config-owner" name="deploymentOwner" maxlength="100" placeholder="host_dispatcher"></div>',
'</div>',
'<div class="checkbox-row"><label><input type="checkbox" name="requiresDeployment" value="true"> 本番反映が必要</label></div>',
'<div class="project-git-box">',
'<h3>GitHub / Git 運用</h3>',
'<p class="helper">GitHub直接編集ではChatGPTが専用ブランチとPRをGitHub上で作成します。Ubuntuホスト直接実行では、隔離用作業環境を使わず、実ホストの専用Git worktreeで調査・編集・検証します。</p>',
'<div class="checkbox-row"><label><input type="checkbox" name="gitEnabled" value="true"> Git 管理を有効にする</label><label><input type="checkbox" name="gitPush" value="true"> 成功後に push する</label></div>',
'<div class="project-config-grid">',
'<div><label for="project-config-repository">GitHub Repository</label><input id="project-config-repository" name="gitRepository" maxlength="300" placeholder="owner/repository"></div>',
'<div><label for="project-config-remote">Git Remote</label><input id="project-config-remote" name="gitRemote" maxlength="200" value="origin"></div>',
'<div><label for="project-config-base">Base Branch</label><input id="project-config-base" name="gitBaseBranch" maxlength="200" value="main"></div>',
'<div><label for="project-config-prefix">Branch Prefix</label><input id="project-config-prefix" name="gitBranchPrefix" maxlength="200" value="chatgpt-job"></div>',
'</div>',
'<p class="helper">注意: push を有効にしても、Ubuntu 側に Git author と GitHub 認証が無ければ最後の push で止まります。</p>',
'</div>',
'<button type="submit">プロジェクト設定を保存</button>',
'</form>'
].join("");
}

function renderPage(jobs, message) {
const messageHtml = message
? '<div class="message">' + escapeHtml(message) + "</div>"
: "";

return [
"<!doctype html>",
'<html lang="ja">',
"<head>",
'<meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
"<title>Pseudo Codex Console</title>",
"<style>",
':root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f6fa}',
"*{box-sizing:border-box}",
"body{margin:0;padding-bottom:42px}",
"main{width:min(1200px,calc(100% - 32px));margin:32px auto}",
"footer{position:fixed;z-index:1000;left:0;right:0;bottom:0;padding:10px 16px;text-align:center;color:#687386;background:rgba(244,246,250,.96);border-top:1px solid #dbe1ea;font-size:.82rem;backdrop-filter:blur(8px)}",
"header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:20px}",
"h1,h2,h3{margin:0 0 12px}",
"p{margin:6px 0}",
".card,.job{background:#fff;border:1px solid #dbe1ea;border-radius:12px;padding:20px;box-shadow:0 3px 12px rgba(20,35,60,.05)}",
".card{margin-bottom:20px}",
".notice{border-left:5px solid #2458c6;background:#eef4ff}",
".queue-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 20px}.queue-summary>div{padding:12px;border:1px solid #dbe1ea;border-radius:10px;background:#fbfcff}.queue-summary>p{grid-column:1/-1;margin:0;color:#687386;font-size:.88rem}",
".health{display:inline-flex;align-items:center;gap:8px;font-weight:700}",
".dot{width:10px;height:10px;border-radius:50%;background:#16883f}",
"label{display:block;font-weight:700;margin:14px 0 6px}",
"input,textarea,select{width:100%;border:1px solid #b9c3d1;border-radius:8px;padding:11px 12px;font:inherit;background:#fff;color:inherit}",
"textarea{min-height:150px;resize:vertical}",
"button{margin-top:14px;border:0;border-radius:8px;padding:11px 18px;background:#2458c6;color:#fff;font:inherit;font-weight:700;cursor:pointer}",
".message{padding:10px 12px;border-radius:8px;background:#eaf7ee;color:#145c2b;margin-bottom:12px}",
".job-filters{display:grid;grid-template-columns:minmax(0,2fr) minmax(150px,1fr) auto;gap:12px;align-items:end;margin:0 0 16px}",
".filter-field label{margin:0 0 6px}",
".result-count{align-self:center;justify-self:end;padding-bottom:11px;font-weight:700;color:#4a5568;white-space:nowrap}",
".jobs{display:grid;gap:14px}",
".job-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}",
".meta{font-size:.82rem;color:#687386;overflow-wrap:anywhere}",
".badges{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}",
".badge{display:inline-block;border-radius:999px;padding:5px 10px;font-weight:700;white-space:nowrap}",
".assignee-Ubuntu{background:#e8eefb;color:#214d99}",
".assignee-ChatGPT{background:#e5f5ee;color:#176544}",
".assignee-完了{background:#dff5e5;color:#145c2b}",
".assignee-失敗{background:#ffe1e1;color:#922323}",
".assignee-停止{background:#eceff3;color:#4b5563}",
".assignee-保留{background:#fff0bf;color:#765600}",
".stage-queued{background:#fff0bf;color:#765600}",
".stage-sending_to_chatgpt,.stage-waiting_chatgpt{background:#e5f5ee;color:#176544}",
".stage-executing_command,.stage-writing_file,.stage-verifying{background:#dce9ff;color:#174a9c}",
".stage-completed{background:#dff5e5;color:#145c2b}",
".stage-failed{background:#ffe1e1;color:#922323}",
".stage-stopped{background:#eceff3;color:#4b5563}",
".stage-blocked{background:#fff0bf;color:#765600}",
".facts{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0;color:#4a5568;font-size:.9rem}",
".runtime{font-size:.82rem;color:#687386;overflow-wrap:anywhere}",
".recovery-info{margin-top:10px;padding:9px 11px;border-left:4px solid #765600;background:#fff8df;color:#604800;font-size:.88rem}.recovery-info a{font-weight:700;color:#604800}",
".job-actions{display:flex;gap:8px;margin-top:10px}.job-actions button{margin:0;padding:7px 12px;background:#5b6472}.job-actions button:disabled{opacity:.55;cursor:wait}",
".handoff-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px}.handoff-actions button{margin:0;padding:8px 12px;background:#176544}.handoff-actions button:disabled{opacity:.55;cursor:wait}.handoff-actions a{font-weight:700;color:#176544}.handoff-actions span{font-size:.82rem;font-weight:700;color:#176544}",
".project-grid{display:grid;gap:14px}",
".project-card{background:#fbfcff;border:1px solid #dbe1ea;border-radius:12px;padding:16px}",
".project-card-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}",
".project-card-head a{font-weight:700;color:#2458c6;text-decoration:none}",
".project-facts{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;color:#4a5568;font-size:.9rem}",
".project-note{margin-top:12px;padding:10px 12px;border-left:4px solid #176544;background:#eef8f2;color:#145c2b;font-size:.9rem}",
".project-config-form{display:grid;gap:14px}",
".project-config-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}",
".project-git-box{border:1px solid #dbe1ea;border-radius:12px;padding:14px;background:#fbfcff}",
".checkbox-row{display:flex;gap:18px;flex-wrap:wrap;align-items:center}",
".checkbox-row label{display:inline-flex;gap:8px;align-items:center;margin:0;font-weight:700}",
".checkbox-row input{width:auto}",
".helper{font-size:.88rem;color:#687386}",
".settings-details{padding:0;overflow:hidden}",
".settings-details>summary{display:flex;align-items:center;justify-content:space-between;min-height:52px;padding:16px 20px;font-size:1.15rem;list-style:none}",
".settings-details>summary::-webkit-details-marker{display:none}",
".settings-details>summary::after{content:'＋';margin-left:12px}",
".settings-details[open]>summary::after{content:'−'}",
".settings-content{padding:0 20px 20px}",
"details{margin-top:10px;border:1px solid #e3e7ee;border-radius:8px;padding:9px 11px}",
"summary{cursor:pointer;font-weight:700}",
"pre{white-space:pre-wrap;word-break:break-word;margin:10px 0 0;font:inherit;line-height:1.55}",
".result-details pre{max-block-size:min(56dvh,32rem);overflow:auto;overscroll-behavior:contain}",
".history-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}",
".history-toolbar button{margin:0;padding:7px 10px;background:#5b6472}",
".history-toolbar button:disabled{opacity:.55;cursor:default}",
".history-status{font-size:.82rem;font-weight:700;color:#765600}",
".history-log{display:block;max-block-size:min(48dvh,28rem);min-block-size:10rem;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;user-select:text;cursor:text}",
".empty{text-align:center;color:#687386}",
"@media(max-width:700px){main{width:min(100% - 20px,1200px);margin:20px auto}.card,.job,.project-card{padding:16px}.settings-details{padding:0}.settings-details>summary{padding:14px 16px}.settings-content{padding:0 16px 16px}header,.job-head,.project-card-head{display:block}.health,.badges{margin-top:12px;justify-content:flex-start}.job-filters,.project-config-grid,.queue-summary{grid-template-columns:1fr}.result-count{justify-self:start;padding-bottom:0}}",
"</style>",
"</head>",
"<body>",
"<main>",
"<header>",
"<div><h1>Pseudo Codex Console</h1><p>ローカル依頼受付・ディスパッチキュー</p></div>",
'<div class="health"><span class="dot"></span>稼働中</div>',
"</header>",
'<section class="card notice">',
"<strong>処理担当をリアルタイム表示</strong>",
"<p>UbuntuとChatGPTの担当、処理段階、最終回答・実行結果・検証結果を表示します。</p>",
"</section>",
renderQueueSummary(jobs),
'<section class="card">',
"<h2>新規ジョブ</h2>",
messageHtml,
'<form method="post" action="/jobs">',
'<label for="project">プロジェクト</label>',
'<select id="project" name="project" required>',
renderProjectOptions(),
'</select>',
'<label for="title">ジョブタイトル</label>',
'<input id="title" name="title" maxlength="200" required>',
'<label for="instruction">詳細な自然言語指示</label>',
'<textarea id="instruction" name="instruction" maxlength="20000" required></textarea>',
'<button type="submit">キューへ登録</button>',
"</form>",
"</section>",
'<section class="card">',
"<h2>ジョブ一覧</h2>",
'<div class="job-filters" role="search" aria-label="ジョブ検索・絞り込み">',
'<div class="filter-field">',
'<label for="job-search">キーワード検索</label>',
'<input id="job-search" type="search" autocomplete="off" placeholder="タイトル・指示内容・ジョブID">',
"</div>",
'<div class="filter-field">',
'<label for="job-status-filter">状態</label>',
'<select id="job-status-filter">',
'<option value="all">すべて</option>',
'<option value="queued">実行待ち</option>',
'<option value="running">実行中</option>',
'<option value="completed">完了</option>',
'<option value="failed">失敗</option>',
'<option value="stopped">停止</option>',
"</select>",
"</div>",
'<output id="job-result-count" class="result-count" aria-live="polite">',
"表示 ",
String(jobs.length),
" / 全 ",
String(jobs.length),
" 件",
"</output>",
"</div>",
'<div id="jobs" class="jobs">',
renderJobs(jobs),
"</div>",
"</section>",
'<details class="card settings-details">',
'<summary>プロジェクト設定を表示</summary>',
'<div class="settings-content">',
'<p class="helper">このコンソールは「登録済みプロジェクト」を対象にジョブを流します。新しい対象を増やす時は、先にここで登録します。</p>',
'<div class="project-grid">',
renderProjectCatalog(),
"</div>",
"</div>",
"</details>",
'<details class="card settings-details">',
'<summary>プロジェクトを追加・更新</summary>',
'<div class="settings-content">',
'<p class="helper">GitHub連携を使う場合はGitを有効にし、Repositoryをowner/name形式で登録してください。</p>',
renderProjectConfigForm(),
"</div>",
"</details>",
"</main>",
'<footer>Pseudo Codex Console v0.1.0</footer>',
CLIENT_SCRIPT_TAG,
"</body>",
"</html>"
].join("");
}

function parseJobPath(pathname, suffix) {
const parts = pathname.split("/");

if (
parts.length === 5 &&
parts[0] === "" &&
parts[1] === "api" &&
parts[2] === "jobs" &&
parts[3] &&
parts[4] === suffix
) {
return decodeURIComponent(parts[3]);
}

return "";
}

async function handleRequest(request, response) {
const url = new URL(
request.url || "/",
"http://" + (request.headers.host || "127.0.0.1")
);

if (request.method === "GET" && url.pathname === "/client.js") {
response.writeHead(200, {
"Content-Type": "application/javascript; charset=utf-8",
"Content-Length": Buffer.byteLength(CLIENT_JS),
"Cache-Control": "no-store"
});
response.end(CLIENT_JS);
return;
}

if (request.method === "GET" && url.pathname === "/health") {
const jobs = readJobs();

const assignees = {
  Ubuntu: 0,
  ChatGPT: 0,
  完了: 0,
  失敗: 0,
  停止: 0,
  保留: 0
};

jobs.forEach(function(job) {
  if (Object.hasOwn(assignees, job.assignee)) {
    assignees[job.assignee] += 1;
  }
});

sendJson(response, 200, {
  status: "ok",
  service: "pseudo-codex-console",
  startedAt: STARTED_AT,
  storage: DATA_PATH,
  queueMode: "dispatcher",
  queued: jobs.filter(function(job) {
    return job.stage === "queued";
  }).length,
  running: jobs.filter(function(job) {
    return job.status === "running";
  }).length,
  leasedRunning: jobs.filter(function(job) {
    return job.status === "running" &&
      job.leaseExpiresAt &&
      new Date(job.leaseExpiresAt).getTime() > Date.now();
  }).length,
  orphaned: jobs.filter(function(job) {
    return job.status === "running" &&
      (!job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= Date.now());
  }).length,
  assignees
});
return;

}

if (request.method === "GET" && url.pathname === "/api/jobs") {
sendJson(response, 200, {
jobs: readJobs()
});
return;
}

if (request.method === "GET" && url.pathname === "/api/projects") {
const configs = readProjectConfigs();
const projects = Object.keys(configs)
.filter(function(name) { return PROJECT_PATTERN.test(name); })
.sort(function(left, right) {
if (left === DEFAULT_PROJECT) return -1;
if (right === DEFAULT_PROJECT) return 1;
return left.localeCompare(right);
})
.map(function(name) {
return projectSummary(name, configs[name]);
});
sendJson(response, 200, {
projects
});
return;
}

const transcriptJobId = parseJobPath(url.pathname, "transcript");
if (request.method === "GET" && transcriptJobId) {
const job = readJobs().find(function(candidate) {
return candidate.id === transcriptJobId;
});

if (!job) {
sendJson(response, 404, {
error: "job not found"
});
return;
}

sendJsonDownload(
response,
"transcript.json",
buildJobTranscript(job)
);
return;
}

const handoffJobId = parseJobPath(url.pathname, "handoff");
if (request.method === "GET" && handoffJobId) {
const job = readJobs().find(function(candidate) {
return candidate.id === handoffJobId;
});

if (!job) {
sendJson(response, 404, {
error: "job not found"
});
return;
}

sendText(
response,
200,
buildChatGptHandoff(job),
"pseudo-codex-handoff-" + job.id + ".md"
);
return;
}

if (
request.method === "GET" &&
url.pathname.startsWith("/api/jobs/")
) {
const parts = url.pathname.split("/");

if (parts.length === 4 && parts[3]) {
  const id = decodeURIComponent(parts[3]);
  const job = readJobs().find(function(candidate) {
    return candidate.id === id;
  });

  if (!job) {
    sendJson(response, 404, {
      error: "job not found"
    });
    return;
  }

  sendJson(response, 200, job);
  return;
}

}

if (
request.method === "POST" &&
url.pathname === "/api/jobs/claim"
) {
let worker;
try {
worker = parseWorkerRequest(request, await readBody(request));
} catch (_error) {
worker = { workerId: "", sessionId: "", pid: null, leaseSeconds: 300, excludedProjects: [] };
}
const job = await claimOldestJob(worker);

if (!job) {
  sendEmpty(response, 204);
  return;
}

sendJson(response, 200, job);
return;

}

const heartbeatJobId = parseJobPath(url.pathname, "heartbeat");
if (request.method === "POST" && heartbeatJobId) {
try {
const heartbeat = parseWorkerRequest(request, await readBody(request));
const job = await heartbeatJob(heartbeatJobId, heartbeat);
if (!job) {
sendJson(response, 409, { error: "job is terminal or lease owner does not match" });
} else {
sendJson(response, 200, job);
}
} catch (error) {
sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request" });
}
return;
}

const stopJobId = parseJobPath(url.pathname, "stop");
if (request.method === "POST" && stopJobId) {
try {
const values = parseStopRequest(request, await readBody(request));
const job = await stopJob(stopJobId, values.reason);
if (!job) {
sendJson(response, 404, { error: "job not found" });
} else {
sendJson(response, 200, job);
}
} catch (error) {
sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid request" });
}
return;
}

const resumeJobId = parseJobPath(url.pathname, "resume");
if (request.method === "POST" && resumeJobId) {
const job = await resumeJob(resumeJobId);
if (!job) {
sendJson(response, 404, { error: "job not found" });
} else {
sendJson(response, 200, job);
}
return;
}

const recoverJobId = parseJobPath(url.pathname, "recover");
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
);

if (request.method === "POST" && progressJobId) {
try {
const values = parseProgressRequest(
request,
await readBody(request)
);

  if (!STAGES.has(values.stage)) {
    sendJson(response, 400, {
      error: "invalid stage"
    });
    return;
  }

  if (values.message.length > 20000) {
    sendJson(response, 413, {
      error: "progress message is too long"
    });
    return;
  }

  const job = await updateJobProgress(
    progressJobId,
    values
  );

  if (!job) {
    sendJson(response, 404, {
      error: "job not found"
    });
    return;
  }

  sendJson(response, 200, job);
} catch (error) {
  sendJson(response, 400, {
    error:
      error instanceof Error
        ? error.message
        : "invalid request"
  });
}

return;

}

const turnJobId = parseJobPath(
url.pathname,
"turn"
);

if (request.method === "POST" && turnJobId) {
try {
const body = await readBody(request);
const values = parseTurnRequest(request, body);

if (values.turn === null) {
sendJson(response, 400, {
error: "turn must be a positive integer"
});
return;
}

if (
values.prompt.length > 240000 ||
values.response.length > 240000 ||
body.length > 750000
) {
sendJson(response, 413, {
error: "turn fields are too long"
});
return;
}

const job = await updateJobTurn(
turnJobId,
values
);

if (!job) {
sendJson(response, 404, {
error: "job not found"
});
return;
}

sendJson(response, 200, job);
} catch (error) {
sendJson(response, 400, {
error:
error instanceof Error
? error.message
: "invalid request"
});
}

return;
}

const resultJobId = parseJobPath(
url.pathname,
"result"
);

if (request.method === "POST" && resultJobId) {
try {
const values = parseResultRequest(
request,
await readBody(request)
);

  if (!RESULT_STATUSES.has(values.status)) {
    sendJson(response, 400, {
      error:
        "status must be done, completed, queued, needs_human, failed, stopped, or blocked"
    });
    return;
  }

  const totalResultLength =
    values.result.length +
    values.finalAnswer.length +
    values.executionResult.length +
    values.verificationResult.length;

  if (
    values.lastError.length > 20000 ||
    values.workerLog.length > 100000 ||
    totalResultLength > 500000
  ) {
    sendJson(response, 413, {
      error: "result fields are too long"
    });
    return;
  }

  const job = await updateJobResult(
    resultJobId,
    values
  );

  if (!job) {
    sendJson(response, 404, {
      error: "job not found"
    });
    return;
  }

  sendJson(response, 200, job);
} catch (error) {
  sendJson(response, 400, {
    error:
      error instanceof Error
        ? error.message
        : "invalid request"
  });
}

return;

}

if (request.method === "GET" && url.pathname === "/") {
const message =
url.searchParams.get("created") === "1"
? "ジョブを待機中として登録しました。"
: url.searchParams.get("project_saved") === "1"
? "プロジェクト設定を保存しました。"
: "";

sendHtml(
  response,
  200,
  renderPage(readJobs(), message)
);
return;

}

if (
request.method === "POST" &&
(url.pathname === "/projects" || url.pathname === "/api/projects")
) {
try {
const values = parseProjectConfigRequest(
request,
await readBody(request)
);
const configuredProjects = readProjectConfigs();
configuredProjects[values.name] = values.config;
writeProjectConfigs(configuredProjects);

const acceptsJson =
String(request.headers.accept || "").includes("application/json") ||
String(request.headers["content-type"] || "").includes("application/json") ||
url.pathname === "/api/projects";

if (acceptsJson) {
sendJson(response, 201, projectSummary(values.name, values.config));
return;
}

response.writeHead(303, {
Location: "/?project_saved=1"
});
response.end();
} catch (error) {
sendJson(response, 400, {
error: error instanceof Error ? error.message : "invalid request"
});
}
return;
}

if (
request.method === "POST" &&
url.pathname === "/jobs"
) {
try {
const values = parseJobRequest(
request,
await readBody(request)
);

  if (!PROJECT_PATTERN.test(values.project)) {
    sendJson(response, 400, {
      error:
        "project must match [a-z0-9][a-z0-9-]{0,63}"
    });
    return;
  }

  const configuredProjects = readProjectConfigs();
  if (
    Object.keys(configuredProjects).length > 0 &&
    !configuredProjects[values.project]
  ) {
    sendJson(response, 400, {
      error: "project is not configured; select a project from the configured list"
    });
    return;
  }

  if (!values.title || !values.instruction) {
    sendJson(response, 400, {
      error: "title and instruction are required"
    });
    return;
  }

  if (
    values.title.length > 200 ||
    values.instruction.length > 20000
  ) {
    sendJson(response, 413, {
      error: "job fields are too long"
    });
    return;
  }

  const job = await createJob(
    values.project,
    values.title,
    values.instruction,
    values.kind
  );

  const acceptsJson =
    String(request.headers.accept || "").includes(
      "application/json"
    ) ||
    String(
      request.headers["content-type"] || ""
    ).includes("application/json");

  if (acceptsJson) {
    sendJson(response, 201, job);
    return;
  }

  response.writeHead(303, {
    Location: "/?created=1"
  });
  response.end();
} catch (error) {
  sendJson(response, 400, {
    error:
      error instanceof Error
        ? error.message
        : "invalid request"
  });
}

return;

}

sendJson(response, 404, {
error: "not found"
});
}

ensureStorage();
writeJobs(readJobs());

const server = http.createServer(function(request, response) {
handleRequest(request, response).catch(function(error) {
console.error(error);

if (!response.headersSent) {
  sendJson(response, 500, {
    error: "internal server error"
  });
} else {
  response.end();
}

});
});

server.listen(PORT, "0.0.0.0", function() {
console.log(
"Pseudo Codex Console listening on 0.0.0.0:" + PORT
);
});

function shutdown(signal) {
console.log(signal + " received");

server.close(function() {
process.exit(0);
});

setTimeout(function() {
process.exit(1);
}, 5000).unref();
}

process.on("SIGTERM", function() {
shutdown("SIGTERM");
});

process.on("SIGINT", function() {
shutdown("SIGINT");
});
