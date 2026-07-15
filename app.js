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

function requesterMessage(value) {
  var text = sanitizeUserFacingText(value);
  var marker = '\nTask instruction:\n';
  var markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) text = text.slice(markerIndex + marker.length);
  var stops = [
    '\n\nGIT AUTHORING CONTRACT:',
    '\n\nREQUEST-CONSOLE SPECIAL RULE:',
    '\n\nThis is an infrastructure retry.'
  ];
  stops.forEach(function (stop) {
    var index = text.indexOf(stop);
    if (index >= 0) text = text.slice(0, index);
  });
  return clip(text.trim(), 5000);
}

function assistantMessage(value) {
  return clip(sanitizeUserFacingText(value)
    .replace(/--- RESPONSE ---/g, '')
    .replace(/--- END ---/g, '')
    .replace(/===RUN:[\s\S]*?===/g, '')
    .replace(/===RUN===[\s\S]*?===ENDRUN===/g, '')
    .replace(/===PATCH===[\s\S]*?===ENDPATCH===/g, '')
    .replace(/===EDIT===[\s\S]*?===ENDEDIT===/g, '')
    .replace(/===REPLACE===[\s\S]*?===ENDREPLACE===/g, '')
    .replace(/===FILE(?::[^\n]*)?===[\s\S]*?===ENDFILE===/g, '')
    .replace(/===TASK_COMPLETE===/g, '')
    .trim(), 7000);
}

function conversationHtml(turns) {
  var values = Array.isArray(turns) ? turns.slice(-20) : [];
  if (!values.length) return '';
  return values.map(function (turn) {
    var prompt = requesterMessage(turn.prompt);
    var response = assistantMessage(turn.response);
    var actions = [];
    if (Array.isArray(turn.runCommands) && turn.runCommands.length) {
      actions.push('Ubuntuで実行したコマンド:\n' + turn.runCommands.join('\n'));
    }
    if (Array.isArray(turn.fileChanges) && turn.fileChanges.length) {
      actions.push('変更対象のファイル:\n' + turn.fileChanges.map(function (change) {
        return '- ' + String(change.path || '');
      }).join('\n'));
    }
    if (Array.isArray(turn.commandResults) && turn.commandResults.length) {
      actions.push('コマンド結果:\n' + turn.commandResults.map(function (result) {
        var status = result.rejected ? '拒否' : result.timedOut ? 'タイムアウト' :
          result.exitStatus == null ? '状態不明' : '終了 ' + result.exitStatus;
        return '[' + status + '] ' + String(result.command || '') +
          (result.output ? '\n' + clip(sanitizeUserFacingText(result.output), 5000) : '');
      }).join('\n\n'));
    }
    if (Array.isArray(turn.checkResults) && turn.checkResults.length) {
      actions.push('検証結果:\n' + turn.checkResults.map(function (result) {
        return '[終了 ' + (result.exitStatus == null ? '?' : result.exitStatus) + '] ' +
          String(result.command || '') +
          (result.output ? '\n' + clip(sanitizeUserFacingText(result.output), 5000) : '');
      }).join('\n\n'));
    }
    var turnLabel = 'ターン ' + escapeHtml(turn.turn || '?');
    var promptTime = turn.sentAt ? formatDate(turn.sentAt) : '';
    var responseTime = turn.responseReceivedAt ? formatDate(turn.responseReceivedAt) : '';
    var metadata = actions.length
      ? '<details class="chat-meta"><summary><span>実行・変更の詳細</span><small>' +
        actions.length + '項目</small></summary><pre>' +
        escapeHtml(clip(sanitizeUserFacingText(actions.join('\n\n')), 16000)) + '</pre></details>'
      : '';
    return '<section class="chat-turn" aria-label="' + turnLabel + '">' +
      '<div class="chat-turn-label">' + turnLabel + '</div>' +
      '<div class="chat-row chat-row-user"><span class="chat-avatar" aria-hidden="true">依</span><div class="chat-message"><div class="chat-speaker">依頼者 <span>あなた</span><time>' + escapeHtml(promptTime) + '</time></div>' +
      '<div class="chat-bubble"><pre>' + escapeHtml(prompt || '記録はありません') + '</pre></div>' +
      '</div></div><div class="chat-row chat-row-assistant"><span class="chat-avatar" aria-hidden="true">AI</span><div class="chat-message"><div class="chat-speaker">ChatGPT <span>実行器</span><time>' + escapeHtml(responseTime) + '</time></div>' +
      '<div class="chat-bubble"><pre>' + escapeHtml(response || '記録はありません') + '</pre></div>' +
      metadata + '</div></div></section>';
  }).join('');
}

function phaseDescription(value) {
  var phases = {
    INSPECT: ['調査中', '対象ファイルや現在の状態を確認しています'],
    PLAN: ['実装方針を整理中', '変更方法と影響範囲を決めています'],
    EDIT: ['ファイルを変更中', 'Ubuntu上の正規ワークスペースを編集しています'],
    TEST: ['テスト中', '変更が正しく動くか確認しています'],
    BLOCKED: ['停止・要確認', '自動処理を続けられない状態です']
  };
  return phases[String(value || '').toUpperCase()] || ['状態確認中', '現在の工程を確認しています'];
}

function transactionsText(values) {
  if (!Array.isArray(values) || !values.length) return 'まだファイル変更は記録されていません。';
  return values.map(function (item, index) {
    var status = item.status === 'applied' ? '適用済み' : item.status === 'failed' ? '失敗' : (item.status || '状態不明');
    return (index + 1) + '. ' + (item.file || '対象不明') + ' — ' + status +
      (item.operation ? '\n   操作: ' + item.operation : '') +
      (item.at ? '\n   時刻: ' + formatDate(item.at) : '');
  }).join('\n\n');
}

function recoveryHistoryText(values) {
  if (!Array.isArray(values) || !values.length) return 'まだ実装方針の切り替えはありません。';
  var classes = {patch_apply: 'パッチを適用できなかった', inspection_loop: '調査が続き実装へ進めなかった', no_progress: '変更の受け入れまで進まなかった', edit_syntax: '編集指示の形式が不正だった'};
  return values.map(function (item, index) {
    return (index + 1) + '. 第' + (item.pass || index + 2) + '案へ切り替え' +
      (item.at ? '（' + formatDate(item.at) + '）' : '') + '\n   理由: ' +
      (classes[item.errorClass] || item.reason || '前の方法では完了できなかった');
  }).join('\n\n');
}

function humanErrorText(value) {
  var raw = String(value || '').trim();
  if (!raw) return '停止・失敗は記録されていません。';
  var explanation = '処理中に問題が発生しました。下の技術情報を確認してください。';
  if (raw.includes('UBUNTU_WORKSPACE_DIRTY')) explanation = 'Ubuntuの正規ワークスペースに未完了の変更が残っているため、安全のため開始できませんでした。';
  else if (raw.includes('CHATGPT_THROTTLED')) explanation = 'ChatGPTのリクエスト制限（Too many requests）が待機リトライ後も解除されなかったため停止しました。数分後に再実行してください。';
  else if (raw.includes('MODEL_USAGE_LIMIT')) explanation = 'ChatGPTの利用上限に達したため、自動実行を停止しました。';
  else if (raw.includes('Waiting failed') || raw.includes('unresponsive')) explanation = 'ChatGPTの応答を時間内に受け取れなかったため停止しました。';
  else if (raw.includes('Permission denied')) explanation = '必要なファイルまたはサービスを操作する権限がありませんでした。';
  return explanation + '\n\n技術情報:\n' + raw;
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

function conversationDetail(job) {
  var value = conversationHtml(job.conversationTurns);
  if (!value) return '';
  var title = 'ChatGPTとの会話を表示';
  var key = job.id + ':' + title;
  var isOpen = detailStates.has(key) ? detailStates.get(key) : true;
  return '<details class="conversation-details" data-conversation-style="slack" data-detail-key="' + escapeHtml(key) + '"' +
    (isOpen ? ' open' : '') + '><summary><span class="chat-summary-icon" aria-hidden="true">#</span>' +
    '<span class="chat-summary-copy"><strong>依頼者 ↔ ChatGPT</strong><small>Slack風のスレッドで会話を表示</small></span>' +
    '<span class="chat-turn-count">' + job.conversationTurns.length + 'ターン</span>' +
    '<span class="visually-hidden">' + title + '</span>' +
    '</summary><div class="chat-thread" role="log" aria-label="ChatGPTとの会話">' + value + '</div></details>';
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
  var phase = phaseDescription(job.phase || 'INSPECT');
  var runtime = job.workerId ? '<div class="runtime">Worker: ' + escapeHtml(job.workerId) +
    ' · PID: ' + escapeHtml(job.pid || '-') + ' · 最終heartbeat: ' + escapeHtml(formatDate(job.heartbeatAt)) + '</div>' : '';
  return '<article id="job-' + escapeHtml(job.id) + '" class="job" data-job-id="' + escapeHtml(job.id) + '" data-updated-at="' +
    escapeHtml(job.updatedAt) + '"><div class="job-head"><div><h3>' + escapeHtml(job.title || '無題') +
    '</h3><p class="meta">登録: ' + escapeHtml(formatDate(job.createdAt)) + ' · ' + escapeHtml(job.project) +
    ' · ' + escapeHtml(job.id) + '</p></div>' + badges(job) + '</div>' +
    '<div class="facts"><span>現在の状態: <strong>' + escapeHtml(job.displayStatus || job.stage) +
    '</strong></span><span>試行回数: <strong>' + escapeHtml(job.attempts) +
    '</strong></span><span>更新: <strong>' + escapeHtml(formatDate(job.updatedAt)) + '</strong></span></div>' +
    '<div class="facts facts-explained"><span>現在の工程: <strong>' + escapeHtml(phase[0]) +
    '</strong><small>' + escapeHtml(phase[1]) + '</small></span><span>ChatGPTとの残り往復: <strong>' + escapeHtml(job.remainingTurns) + '回</strong><small>この実行で追加質問できる残り回数です</small></span>' +
    '<span>調査回数: <strong>' + escapeHtml(job.inspectTurns || 0) + '回</strong><small>現在の実装方針で確認を行った回数です</small></span>' +
    '<span>実装方針: <strong>第' + escapeHtml(job.strategyPass || 1) + '案</strong><small>行き詰まると別の方法へ自動で切り替えます</small></span>' +
    '<span>変更ファイル: <strong>' + escapeHtml((job.changedFiles || []).length) + '件</strong><small>今回のジョブが変更したファイル数です</small></span></div>' +
    runtime + recoveryInfo(job) + jobActions(job) + handoffActions(job) +
    '<div class="job-download"><a href="/api/jobs/' + encodeURIComponent(job.id) +
    '/transcript" download="transcript.json">このジョブのやり取りをダウンロード</a></div>' +
    detail(job.id, '指示を表示', job.instruction, false) +
    conversationDetail(job) +
    detail(job.id, '最終結果を表示', job.result, true) +
    detail(job.id, 'ワーカーログを表示', job.workerLog, false) +
    detail(job.id, 'ファイル変更の記録を表示', transactionsText(job.transactions), false) +
    detail(job.id, '実装方針を切り替えた履歴を表示', recoveryHistoryText(job.recoveryHistory), false) +
    detail(job.id, '再開時に使う作業メモを表示', job.checkpoint || '作業メモはまだありません。', false) +
    detail(job.id, '停止・失敗の理由を表示', humanErrorText(job.lastError), false) + historyDetail(job) + '</article>';
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
const configuredExecutionMode = ["github_direct", "local", "verify_only"].includes(config.executionMode)
? config.executionMode
: (git.enabled && git.repository ? "github_direct" : "local");
const executionMode = configuredExecutionMode;
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
codexCliOnly: false,
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

function extractRequesterMessage(value) {
let text = sanitizeUserFacingText(value);
const marker = "\nTask instruction:\n";
const markerIndex = text.lastIndexOf(marker);
if (markerIndex >= 0) text = text.slice(markerIndex + marker.length);
[
"\n\nGIT AUTHORING CONTRACT:",
"\n\nREQUEST-CONSOLE SPECIAL RULE:",
"\n\nThis is an infrastructure retry."
].forEach(function(stop) {
const index = text.indexOf(stop);
if (index >= 0) text = text.slice(0, index);
});
return compactText(text.trim(), 5000);
}

function extractAssistantMessage(value) {
return compactText(sanitizeUserFacingText(value)
.replace(/--- RESPONSE ---/g, "")
.replace(/--- END ---/g, "")
.replace(/===RUN:[\s\S]*?===/g, "")
.replace(/===RUN===[\s\S]*?===ENDRUN===/g, "")
.replace(/===PATCH===[\s\S]*?===ENDPATCH===/g, "")
.replace(/===EDIT===[\s\S]*?===ENDEDIT===/g, "")
.replace(/===REPLACE===[\s\S]*?===ENDREPLACE===/g, "")
.replace(/===FILE(?::[^\n]*)?===[\s\S]*?===ENDFILE===/g, "")
.replace(/===TASK_COMPLETE===/g, "")
.trim(), 7000);
}

function renderConversationHtml(turns) {
const values = Array.isArray(turns) ? turns.slice(-20) : [];
if (!values.length) return "";
return values.map(function(turn) {
const prompt = extractRequesterMessage(turn.prompt);
const response = extractAssistantMessage(turn.response);
const actions = [];
if (Array.isArray(turn.runCommands) && turn.runCommands.length) {
actions.push("Ubuntuで実行したコマンド:\n" + turn.runCommands.join("\n"));
}
if (Array.isArray(turn.fileChanges) && turn.fileChanges.length) {
actions.push("変更対象のファイル:\n" + turn.fileChanges.map(function(change) {
return "- " + String(change.path || "");
}).join("\n"));
}
if (Array.isArray(turn.commandResults) && turn.commandResults.length) {
actions.push("コマンド結果:\n" + turn.commandResults.map(function(result) {
const status = result.rejected ? "拒否" : result.timedOut ? "タイムアウト" :
result.exitStatus == null ? "状態不明" : "終了 " + result.exitStatus;
return "[" + status + "] " + String(result.command || "") +
(result.output ? "\n" + compactText(sanitizeUserFacingText(result.output), 5000) : "");
}).join("\n\n"));
}
if (Array.isArray(turn.checkResults) && turn.checkResults.length) {
actions.push("検証結果:\n" + turn.checkResults.map(function(result) {
return "[終了 " + (result.exitStatus == null ? "?" : result.exitStatus) + "] " +
String(result.command || "") +
(result.output ? "\n" + compactText(sanitizeUserFacingText(result.output), 5000) : "");
}).join("\n\n"));
}
const turnLabel = "ターン " + escapeHtml(turn.turn || "?");
const promptTime = turn.sentAt ? formatDateForDisplay(turn.sentAt) : "";
const responseTime = turn.responseReceivedAt ? formatDateForDisplay(turn.responseReceivedAt) : "";
const metadata = actions.length
? '<details class="chat-meta"><summary><span>実行・変更の詳細</span><small>' +
actions.length + "項目</small></summary><pre>" +
escapeHtml(compactText(sanitizeUserFacingText(actions.join("\n\n")), 16000)) + "</pre></details>"
: "";
return [
'<section class="chat-turn" aria-label="', turnLabel, '">',
'<div class="chat-turn-label">', turnLabel, "</div>",
'<div class="chat-row chat-row-user"><span class="chat-avatar" aria-hidden="true">依</span><div class="chat-message"><div class="chat-speaker">依頼者 <span>あなた</span><time>', escapeHtml(promptTime), "</time></div>",
'<div class="chat-bubble"><pre>', escapeHtml(prompt || "記録はありません"), "</pre></div></div></div>",
'<div class="chat-row chat-row-assistant"><span class="chat-avatar" aria-hidden="true">AI</span><div class="chat-message"><div class="chat-speaker">ChatGPT <span>実行器</span><time>', escapeHtml(responseTime), "</time></div>",
'<div class="chat-bubble"><pre>', escapeHtml(response || "記録はありません"), "</pre></div>",
metadata, "</div></div></section>"
].join("");
}).join("");
}

function describePhase(value) {
const phases = {
INSPECT: ["調査中", "対象ファイルや現在の状態を確認しています"],
PLAN: ["実装方針を整理中", "変更方法と影響範囲を決めています"],
EDIT: ["ファイルを変更中", "Ubuntu上の正規ワークスペースを編集しています"],
TEST: ["テスト中", "変更が正しく動くか確認しています"],
BLOCKED: ["停止・要確認", "自動処理を続けられない状態です"]
};
return phases[String(value || "").toUpperCase()] || ["状態確認中", "現在の工程を確認しています"];
}

function renderTransactionsText(values) {
if (!Array.isArray(values) || !values.length) return "まだファイル変更は記録されていません。";
return values.map(function(item, index) {
const status = item.status === "applied" ? "適用済み" : item.status === "failed" ? "失敗" : (item.status || "状態不明");
return (index + 1) + ". " + (item.file || "対象不明") + " — " + status +
(item.operation ? "\n   操作: " + item.operation : "") +
(item.at ? "\n   時刻: " + formatDateForDisplay(item.at) : "");
}).join("\n\n");
}

function renderRecoveryHistoryText(values) {
if (!Array.isArray(values) || !values.length) return "まだ実装方針の切り替えはありません。";
const classes = {
patch_apply: "パッチを適用できなかった",
inspection_loop: "調査が続き実装へ進めなかった",
no_progress: "変更の受け入れまで進まなかった",
edit_syntax: "編集指示の形式が不正だった"
};
return values.map(function(item, index) {
return (index + 1) + ". 第" + (item.pass || index + 2) + "案へ切り替え" +
(item.at ? "（" + formatDateForDisplay(item.at) + "）" : "") + "\n   理由: " +
(classes[item.errorClass] || item.reason || "前の方法では完了できなかった");
}).join("\n\n");
}

function renderHumanErrorText(value) {
const raw = String(value || "").trim();
if (!raw) return "停止・失敗は記録されていません。";
let explanation = "処理中に問題が発生しました。下の技術情報を確認してください。";
if (raw.includes("UBUNTU_WORKSPACE_DIRTY")) explanation = "Ubuntuの正規ワークスペースに未完了の変更が残っているため、安全のため開始できませんでした。";
else if (raw.includes("CHATGPT_THROTTLED")) explanation = "ChatGPTのリクエスト制限（Too many requests）が待機リトライ後も解除されなかったため停止しました。数分後に再実行してください。";
else if (raw.includes("MODEL_USAGE_LIMIT")) explanation = "ChatGPTの利用上限に達したため、自動実行を停止しました。";
else if (raw.includes("Waiting failed") || raw.includes("unresponsive")) explanation = "ChatGPTの応答を時間内に受け取れなかったため停止しました。";
else if (raw.includes("Permission denied")) explanation = "必要なファイルまたはサービスを操作する権限がありませんでした。";
return explanation + "\n\n技術情報:\n" + raw;
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
pid: boundedInteger(value.pid, 1, 2147483647, null),
preflight: value.preflight === true
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

// Failures that a "different implementation strategy" cannot fix: the job
// never reached ChatGPT (preflight) or the environment itself is exhausted
// (model usage limit). Spawning continuations for these only chains identical
// failures until the auto-handoff limit.
const NON_CONTINUABLE_FAILURE_PATTERN = new RegExp([
"UBUNTU_WORKSPACE_DIRTY",
"UBUNTU_WORKSPACE_NOT_ON_MAIN",
"UBUNTU_WORKSPACE_COMMIT_MISMATCH",
"AGENT_LAUNCHER_NOT_EXECUTABLE",
"AGENT_LAUNCH_FAILED",
"Dispatcher rejected the project path",
"Dispatcher preflight failed",
"MODEL_USAGE_LIMIT",
"Model usage limit detected",
"CHATGPT_THROTTLED"
].join("|"));

function isNonContinuableFailure(result) {
if (result.preflight === true) return true;
const evidence = String(result.lastError || "") + "\n" + String(result.workerLog || "");
return NON_CONTINUABLE_FAILURE_PATTERN.test(evidence);
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
if (isNonContinuableFailure(result)) {
job.autoHandoffStatus = "環境要因の失敗（開始前チェックまたは利用上限）のため自動継続なし（回復後に再実行してください）";
job.autoHandoffCreatedAt = new Date().toISOString();
} else {
createContinuationJob(
jobs,
job,
job.lastError || "最終失敗を検知",
true
);
}
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

function renderConversationDetails(job) {
const value = renderConversationHtml(job.conversationTurns);
if (!value) return "";
const title = "ChatGPTとの会話を表示";
return [
'<details class="conversation-details" data-conversation-style="slack" data-detail-key="',
escapeHtml(job.id + ":" + title),
'" open>',
'<summary><span class="chat-summary-icon" aria-hidden="true">#</span>',
'<span class="chat-summary-copy"><strong>依頼者 ↔ ChatGPT</strong><small>Slack風のスレッドで会話を表示</small></span>',
'<span class="chat-turn-count">', String(job.conversationTurns.length), 'ターン</span>',
'<span class="visually-hidden">', title, '</span></summary>',
'<div class="chat-thread" role="log" aria-label="ChatGPTとの会話">',
value,
"</div></details>"
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
const phase = describePhase(job.phase);
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
"<span>現在の状態: <strong>",
escapeHtml(job.displayStatus || job.stage),
"</strong></span>",
"<span>試行回数: <strong>",
escapeHtml(job.attempts),
"</strong></span>",
"<span>更新: <strong>",
escapeHtml(formatDateForDisplay(job.updatedAt)),
"</strong></span>",
"</div>",
'<div class="facts facts-explained"><span>現在の工程: <strong>', escapeHtml(phase[0]),
'</strong><small>', escapeHtml(phase[1]), '</small></span>',
'<span>ChatGPTとの残り往復: <strong>', escapeHtml(job.remainingTurns), '回</strong><small>この実行で追加質問できる残り回数です</small></span>',
'<span>調査回数: <strong>', escapeHtml(job.inspectTurns || 0), '回</strong><small>現在の実装方針で確認を行った回数です</small></span>',
'<span>実装方針: <strong>第', escapeHtml(job.strategyPass), '案</strong><small>行き詰まると別の方法へ自動で切り替えます</small></span>',
'<span>変更ファイル: <strong>', escapeHtml(job.changedFiles.length), '件</strong><small>今回のジョブが変更したファイル数です</small></span></div>',
renderRuntime(job),
renderRecoveryInfo(job),
renderJobActions(job),
renderHandoffActions(job),
['<div class="job-download"><a href="/api/jobs/', encodeURIComponent(job.id), '/transcript" download="transcript.json">このジョブのやり取りをダウンロード</a></div>'].join(""),
renderDetails(job.id, "指示を表示", job.instruction, false, false),
renderConversationDetails(job),
renderDetails(job.id, "最終結果を表示", job.result, false, true),
renderDetails(job.id, "ワーカーログを表示", job.workerLog, false, false),
renderDetails(job.id, "ファイル変更の記録を表示", renderTransactionsText(job.transactions), false, false),
renderDetails(job.id, "実装方針を切り替えた履歴を表示", renderRecoveryHistoryText(job.recoveryHistory), false, false),
renderDetails(job.id, "再開時に使う作業メモを表示", job.checkpoint || "作業メモはまだありません。", false, false),
renderDetails(job.id, "停止・失敗の理由を表示", renderHumanErrorText(job.lastError), job.stage === "failed", false),
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
const note = summary.codexCliOnly
? '<div class="project-note"><strong>固定ルール:</strong> 自己改修は Ubuntu の Codex CLI で専用 branch / PR を作成します。Ubuntu main は GitHub main を pull --ff-only し、同一 commit だけを deploy します。このコンソールのブラウザ agent は自己改修に使用しません。</div>'
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

const CONSOLE_UI_SCRIPT = String.raw`<script>
(function () {
  var selectedJobId = "";
  var jobsById = new Map();
  var observer = null;
  var syncTimer = null;
  var detailViewStates = new Map();

  function detailContent(detailsNode) {
    return detailsNode.querySelector(":scope > pre, :scope > .chat-thread, :scope > .history-log") ||
      detailsNode.querySelector(".history-log");
  }

  function rememberDetailView(detailsNode, userScrolled) {
    if (!detailsNode || !detailsNode.dataset.detailKey) return;
    var content = detailContent(detailsNode);
    var previous = detailViewStates.get(detailsNode.dataset.detailKey) || {};
    detailViewStates.set(detailsNode.dataset.detailKey, {
      open: detailsNode.open,
      scrollTop: content ? content.scrollTop : 0,
      userScrolled: userScrolled === undefined ? Boolean(previous.userScrolled) : userScrolled
    });
  }

  function setDetailScroll(detailsNode, scrollTop, restoring) {
    var content = detailContent(detailsNode);
    if (!content) return;
    if (restoring) detailsNode.dataset.detailScrollRestoring = "true";
    requestAnimationFrame(function () {
      content.scrollTop = scrollTop;
      requestAnimationFrame(function () {
        delete detailsNode.dataset.detailScrollRestoring;
      });
    });
  }

  function scrollDetailToBottom(detailsNode) {
    var content = detailContent(detailsNode);
    if (!content) return;
    setDetailScroll(detailsNode, content.scrollHeight, true);
  }

  function captureDetailViews(root) {
    if (!root) return;
    root.querySelectorAll(".detail-job details[data-detail-key]").forEach(function (detailsNode) {
      rememberDetailView(detailsNode);
    });
  }

  function restoreDetailViews(root) {
    if (!root) return;
    root.querySelectorAll(".detail-job details[data-detail-key]").forEach(function (detailsNode) {
      var state = detailViewStates.get(detailsNode.dataset.detailKey);
      if (!state) return;
      detailsNode.open = Boolean(state.open);
      if (!detailsNode.open) return;
      if (state.userScrolled) setDetailScroll(detailsNode, state.scrollTop, true);
      else scrollDetailToBottom(detailsNode);
    });
  }

  function setText(node, value) {
    var next = String(value == null ? "" : value);
    if (node.textContent !== next) node.textContent = next;
  }

  function stageLabel(job) {
    var labels = {
      queued: "実行待ち",
      sending_to_chatgpt: "ChatGPTへ送信中",
      waiting_chatgpt: "ChatGPT応答待ち",
      executing_command: "コマンド実行中",
      writing_file: "ファイル更新中",
      verifying: "検証中",
      completed: "完了",
      failed: "失敗",
      stopped: "停止",
      blocked: "保留"
    };
    return labels[job.stage] || job.displayStatus || job.stage || "不明";
  }

  function ownerLabel(job) {
    if (job.workerId) return job.workerId;
    return job.assignee || "未割当";
  }

  function relativeTime(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    var seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 10) return "たった今";
    if (seconds < 60) return seconds + "秒前";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "分前";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "時間前";
    return Math.floor(hours / 24) + "日前";
  }

  function formatCreatedAt(value) {
var date = new Date(value);
if (Number.isNaN(date.getTime())) return "-";
return new Intl.DateTimeFormat("ja-JP", {
timeZone: "Asia/Tokyo",
year: "numeric",
month: "2-digit",
day: "2-digit",
hour: "2-digit",
minute: "2-digit",
second: "2-digit",
hourCycle: "h23"
}).format(date) + " JST";
}

function createCell(className, value) {
    var node = document.createElement("span");
    node.className = className;
    node.textContent = value;
    return node;
  }

  function buildRowSummary(card, job) {
    var summary = card.querySelector(":scope > .job-row-summary");
    if (!summary) {
      summary = document.createElement("div");
      summary.className = "job-row-summary";
      card.prepend(summary);
    }
    summary.replaceChildren();

    var identity = document.createElement("span");
    identity.className = "job-identity";
    var title = document.createElement("strong");
    title.textContent = job.title || "無題";
var created = document.createElement("small");
created.className = "job-created";
created.textContent = "作成 " + formatCreatedAt(job.createdAt);
    var id = document.createElement("small");
    id.textContent = String(job.id || "").slice(0, 8);
    identity.append(title, created, id);

    var state = createCell("job-state stage-" + String(job.stage || "queued"), stageLabel(job));
    summary.append(
      identity,
      createCell("job-project", job.project || "-"),
      state,
      createCell("job-worker", ownerLabel(job)),
      createCell("job-updated", relativeTime(job.updatedAt))
    );
    card.dataset.stage = job.stage || "";
    card.dataset.updatedAt = job.updatedAt || "";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", (job.title || "無題") + " の詳細を表示");
  }

  function renderDetail(openOnMobile) {
    var panel = document.getElementById("job-detail-panel");
    if (!panel) return;
    captureDetailViews(panel);
    var card = selectedJobId
      ? document.querySelector('#jobs .job[data-job-id="' + CSS.escape(selectedJobId) + '"]')
      : null;
    if (!card || card.hidden) {
      card = Array.from(document.querySelectorAll("#jobs .job")).find(function (item) {
        return !item.hidden;
      }) || null;
      selectedJobId = card ? card.dataset.jobId : "";
    }

    document.querySelectorAll("#jobs .job").forEach(function (item) {
      item.classList.toggle("is-selected", item.dataset.jobId === selectedJobId);
      item.setAttribute("aria-selected", item.dataset.jobId === selectedJobId ? "true" : "false");
    });

    if (!card) {
      panel.innerHTML = '<div class="detail-empty"><strong>表示できるジョブがありません</strong><p>検索条件を変更するか、新しいジョブを登録してください。</p></div>';
      closeMobileDetail();
      return;
    }

    var selectedJob = jobsById.get(selectedJobId) || {};
    var mobileHeading = document.createElement("div");
    mobileHeading.className = "mobile-detail-heading";

    var closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "mobile-detail-close";
    closeButton.dataset.closeJobDetail = "";
    closeButton.textContent = "← 一覧へ戻る";

    var selectedState = document.createElement("strong");
    selectedState.className = "mobile-detail-state stage-" + String(selectedJob.stage || "queued");
    selectedState.textContent = stageLabel(selectedJob);

    var selectedTitle = document.createElement("span");
    selectedTitle.className = "mobile-detail-title";
    var selectedLabel = document.createElement("small");
    selectedLabel.textContent = "選択中のジョブ";
    var selectedName = document.createElement("strong");
    selectedName.textContent = selectedJob.title || "無題";
    selectedTitle.append(selectedLabel, selectedName);
    mobileHeading.append(closeButton, selectedState, selectedTitle);

    var clone = card.cloneNode(true);
    clone.classList.add("detail-job");
    clone.classList.remove("is-selected");
    clone.hidden = false;
    clone.removeAttribute("id");
    clone.removeAttribute("role");
    clone.removeAttribute("tabindex");
    clone.removeAttribute("aria-selected");
    var summary = clone.querySelector(":scope > .job-row-summary");
    if (summary) summary.remove();

    panel.replaceChildren(mobileHeading, clone);
    restoreDetailViews(panel);
    if (openOnMobile && window.matchMedia("(max-width: 780px)").matches) {
      panel.classList.add("is-mobile-open");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      document.body.classList.add("job-detail-open");
      panel.scrollTop = 0;
      closeButton.focus({ preventScroll: true });
    }
  }

  function closeMobileDetail() {
    var panel = document.getElementById("job-detail-panel");
    if (panel) {
      panel.classList.remove("is-mobile-open");
      panel.removeAttribute("role");
      panel.removeAttribute("aria-modal");
    }
    document.body.classList.remove("job-detail-open");
    var selectedCard = selectedJobId
      ? document.querySelector('#jobs .job[data-job-id="' + CSS.escape(selectedJobId) + '"]')
      : null;
    if (selectedCard) selectedCard.focus({ preventScroll: true });
  }

  function updateKpis(jobs) {
    var values = {
      running: jobs.filter(function (job) { return job.status === "running"; }).length,
      queued: jobs.filter(function (job) { return job.stage === "queued"; }).length,
      attention: jobs.filter(function (job) { return job.stage === "failed" || job.stage === "blocked"; }).length,
      completed: jobs.filter(function (job) { return job.stage === "completed"; }).length
    };
    Object.keys(values).forEach(function (key) {
      var node = document.querySelector('[data-kpi-value="' + key + '"]');
      if (node) setText(node, values[key]);
    });
  }

  function applyJobs(jobs) {
    jobsById = new Map(jobs.map(function (job) { return [job.id, job]; }));
    if (observer) observer.disconnect();
    document.querySelectorAll("#jobs .job").forEach(function (card) {
      var job = jobsById.get(card.dataset.jobId);
      if (job) buildRowSummary(card, job);
    });
    renderDetail();
    updateKpis(jobs);
    if (observer) {
      var list = document.getElementById("jobs");
      if (list) observer.observe(list, { childList: true, subtree: true });
    }
  }

  async function syncUi() {
    try {
      var response = await fetch("/api/jobs", { cache: "no-store" });
      if (!response.ok) return;
      var payload = await response.json();
      applyJobs(Array.isArray(payload.jobs) ? payload.jobs : []);
    } catch (_error) {
      return;
    }
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncUi, 80);
  }

  document.addEventListener("toggle", function (event) {
    var detailsNode = event.target;
    if (!detailsNode || !detailsNode.matches || !detailsNode.matches("#job-detail-panel .detail-job details[data-detail-key]")) return;
    if (detailsNode.open) {
      detailViewStates.set(detailsNode.dataset.detailKey, {open: true, scrollTop: 0, userScrolled: false});
      scrollDetailToBottom(detailsNode);
    } else {
      rememberDetailView(detailsNode, false);
    }
  }, true);

  document.addEventListener("scroll", function (event) {
    var content = event.target;
    if (!content || !content.closest) return;
    var detailsNode = content.closest("#job-detail-panel .detail-job details[data-detail-key]");
    if (!detailsNode || content !== detailContent(detailsNode)) return;
    if (detailsNode.dataset.detailScrollRestoring === "true") return;
    rememberDetailView(detailsNode, true);
  }, true);

  document.addEventListener("click", function (event) {
    var toggle = event.target.closest && event.target.closest("[data-new-job-toggle]");
    if (toggle) {
      var panel = document.getElementById("new-job-panel");
      if (panel) {
        panel.hidden = !panel.hidden;
        toggle.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
        if (!panel.hidden) {
          var title = panel.querySelector('input[name="title"]');
          if (title) title.focus();
        }
      }
      return;
    }

    var close = event.target.closest && event.target.closest("[data-new-job-close]");
    if (close) {
      var newJobPanel = document.getElementById("new-job-panel");
      if (newJobPanel) newJobPanel.hidden = true;
      var opener = document.querySelector("[data-new-job-toggle]");
      if (opener) opener.setAttribute("aria-expanded", "false");
      return;
    }

    var detailClose = event.target.closest && event.target.closest("[data-close-job-detail]");
    if (detailClose) {
      closeMobileDetail();
      return;
    }

    var card = event.target.closest && event.target.closest("#jobs .job");
    if (!card || event.target.closest("button,a,input,select,textarea")) return;
    selectedJobId = card.dataset.jobId;
    renderDetail(true);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      var panel = document.getElementById("job-detail-panel");
      if (panel && panel.classList.contains("is-mobile-open")) {
        event.preventDefault();
        closeMobileDetail();
      }
      return;
    }
    var card = event.target.closest && event.target.closest("#jobs .job");
    if (!card || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    selectedJobId = card.dataset.jobId;
    renderDetail(true);
  });

  document.addEventListener("input", function (event) {
    if (event.target.matches("#job-search")) setTimeout(renderDetail, 0);
  });
  document.addEventListener("change", function (event) {
    if (event.target.matches("#job-status-filter")) setTimeout(renderDetail, 0);
  });

  var list = document.getElementById("jobs");
  if (list) {
    observer = new MutationObserver(scheduleSync);
    observer.observe(list, { childList: true, subtree: true });
  }
  window.addEventListener("resize", function () {
    if (!window.matchMedia("(max-width: 780px)").matches) closeMobileDetail();
  });
  void syncUi();
}());
</script>`;

function renderPage(jobs, message) {
  const messageHtml = message
  ? '<div class="message" role="status">' + escapeHtml(message) + "</div>"
  : "";
  const runningCount = jobs.filter(function(job) { return job.status === "running"; }).length;
  const queuedCount = jobs.filter(function(job) { return job.stage === "queued"; }).length;
  const attentionCount = jobs.filter(function(job) {
    return job.stage === "failed" || job.stage === "blocked";
  }).length;
  const completedCount = jobs.filter(function(job) { return job.stage === "completed"; }).length;

  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Pseudo Codex Console</title>",
    "<style>",
    ':root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0f172a;background:#f4f7fb;line-height:1.45;color-scheme:light}',
    '*{box-sizing:border-box}',
    'html{scroll-behavior:smooth}',
    'body{margin:0;min-width:320px;background:#f4f7fb}',
    'button,input,textarea,select{font:inherit}',
    'button,a,summary{touch-action:manipulation}',
    'button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,.job:focus-visible{outline:3px solid rgba(37,99,235,.25);outline-offset:2px}',
    '.app-shell{min-height:100dvh;display:grid;grid-template-columns:220px minmax(0,1fr);grid-template-rows:72px minmax(0,1fr) 32px}',
    '.sidebar{grid-row:1/4;background:#101826;color:#cbd5e1;padding:24px 12px 16px;display:flex;flex-direction:column;position:sticky;top:0;height:100dvh;z-index:20}',
    '.brand{padding:0 12px 22px;border-bottom:1px solid #273449}.brand strong{display:block;color:#f8fafc;font-size:.94rem;letter-spacing:.04em}.brand span{display:block;color:#94a3b8;font-size:.75rem;margin-top:3px}',
    '.side-nav{display:grid;gap:6px;margin-top:16px}.side-nav a{display:flex;align-items:center;gap:12px;min-height:42px;padding:0 13px;border-radius:10px;color:#cbd5e1;text-decoration:none;font-size:.88rem;font-weight:650}.side-nav a:hover{background:#172235;color:#fff}.side-nav a:first-child{background:#2563eb;color:#fff}.nav-mark{width:18px;text-align:center;color:#94a3b8}.side-nav a:first-child .nav-mark{color:#fff}',
    '.server-status{margin-top:auto;border-radius:12px;background:#172235;padding:14px 12px;color:#94a3b8;font-size:.72rem}.server-status strong{display:flex;align-items:center;gap:8px;color:#e2e8f0;font-size:.78rem;margin-bottom:8px}.online-dot{width:8px;height:8px;border-radius:999px;background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.1)}.server-status span{display:block;margin-top:6px}',
    '.topbar{grid-column:2;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:0 32px;background:#fff;border-bottom:1px solid #e2e8f0;position:sticky;top:0;z-index:15}.topbar h1{font-size:1.25rem;margin:0}.topbar p{font-size:.75rem;color:#64748b;margin:2px 0 0}.topbar-actions{display:flex;align-items:center;gap:12px}.top-search{width:min(320px,30vw);border:1px solid #cbd5e1;border-radius:10px;padding:10px 12px;background:#f8fafc;color:#0f172a}.primary-button,.secondary-button,.danger-button{border:0;border-radius:9px;padding:10px 16px;font-weight:750;cursor:pointer}.primary-button{background:#2563eb;color:#fff}.secondary-button{background:#fff;color:#334155;border:1px solid #cbd5e1}.danger-button{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}',
    '.main{grid-column:2;min-width:0;padding:28px 32px 34px}.message{padding:10px 12px;border-radius:9px;background:#ecfdf3;color:#166534;border:1px solid #bbf7d0;margin-bottom:14px}',
    '.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:24px}.kpi{position:relative;overflow:hidden;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:17px 18px 16px;min-height:108px}.kpi::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:var(--accent)}.kpi-label{font-size:.72rem;font-weight:750;color:#64748b}.kpi-value{display:block;font-size:1.8rem;line-height:1.1;margin-top:10px}.kpi-note{display:inline-flex;margin-top:9px;padding:5px 9px;border-radius:8px;background:var(--tint);color:var(--accent);font-size:.68rem;font-weight:700}',
    '.new-job-panel{background:#fff;border:1px solid #bfdbfe;border-radius:14px;padding:20px;margin-bottom:20px;box-shadow:0 18px 45px rgba(15,23,42,.08)}.new-job-panel[hidden]{display:none}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:10px}.panel-heading h2{font-size:1.05rem;margin:0}.panel-heading p{color:#64748b;font-size:.78rem;margin:4px 0 0}.icon-button{border:0;background:transparent;color:#64748b;font-size:1.4rem;cursor:pointer;padding:0 6px}.new-job-form{display:grid;grid-template-columns:minmax(180px,.7fr) minmax(220px,1.3fr) auto;gap:12px;align-items:end}.field label{display:block;font-size:.72rem;font-weight:750;color:#475569;margin-bottom:6px}.field input,.field textarea,.field select{width:100%;border:1px solid #cbd5e1;border-radius:9px;padding:10px 11px;background:#fff;color:#0f172a}.field textarea{min-height:42px;max-height:140px;resize:vertical}.submit-field button{width:100%}',
    '.workspace{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(440px,1.1fr);gap:16px;align-items:start}.queue-card,.detail-panel{background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden}.queue-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px}.queue-toolbar h2{font-size:1.1rem;margin:0}.queue-toolbar p{color:#64748b;font-size:.74rem;margin:3px 0 0}.filters{display:flex;align-items:end;gap:9px}.filters .field{min-width:140px}.filters .field:first-child{min-width:190px}.filters input,.filters select{padding:9px 10px}.result-count{font-size:.7rem;color:#64748b;white-space:nowrap;padding-bottom:10px}',
    '.job-table-header{display:grid;grid-template-columns:minmax(220px,2fr) minmax(110px,1fr) 118px 135px 92px;gap:12px;padding:12px 20px;background:#f8fafc;border-top:1px solid #eef2f7;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:.62rem;font-weight:800;letter-spacing:.04em}.jobs{min-height:320px}.jobs>.job{margin:0;border:0;border-bottom:1px solid #e2e8f0;border-radius:0;background:#fff;padding:0;box-shadow:none;cursor:pointer;transition:background .15s ease}.jobs>.job:hover{background:#f8fafc}.jobs>.job.is-selected{background:#eff6ff}.jobs>.job:last-child{border-bottom:0}.jobs>.job>:not(.job-row-summary){display:none}.job-row-summary{display:grid;grid-template-columns:minmax(220px,2fr) minmax(110px,1fr) 118px 135px 92px;gap:12px;align-items:center;min-height:88px;padding:13px 20px;font-size:.72rem}.job-identity{min-width:0}.job-identity strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.8rem;color:#0f172a}.job-identity small{display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.64rem}.job-created{color:#475569;font-weight:700}.job-id{color:#94a3b8}.job-project,.job-worker,.job-updated{color:#475569;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.job-updated{color:#64748b}.job-state{justify-self:start;border-radius:999px;padding:5px 9px;font-size:.64rem;font-weight:750;white-space:nowrap}',
    '.stage-queued{background:#fef3c7;color:#92400e}.stage-sending_to_chatgpt,.stage-waiting_chatgpt{background:#dcfce7;color:#166534}.stage-executing_command,.stage-writing_file,.stage-verifying{background:#dbeafe;color:#1d4ed8}.stage-completed{background:#dcfce7;color:#166534}.stage-failed{background:#fee2e2;color:#b91c1c}.stage-stopped{background:#e2e8f0;color:#475569}.stage-blocked{background:#fef3c7;color:#92400e}',
    '.detail-panel{position:sticky;top:92px;max-height:calc(100dvh - 124px);overflow:auto;overscroll-behavior:contain}.mobile-detail-heading{display:none}.detail-empty{padding:48px 26px;text-align:center;color:#64748b}.detail-empty strong{display:block;color:#334155}.detail-empty p{font-size:.78rem}.detail-job{padding:20px}.detail-job>.job-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:1px solid #e2e8f0;padding-bottom:15px}.detail-job h3{font-size:1.05rem;margin:0}.detail-job .meta{font-size:.68rem;color:#94a3b8;overflow-wrap:anywhere}.detail-job .badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.badge{display:inline-flex;border-radius:999px;padding:5px 9px;font-size:.66rem;font-weight:750;white-space:nowrap}.assignee-Ubuntu{background:#dbeafe;color:#1d4ed8}.assignee-ChatGPT{background:#dcfce7;color:#166534}.assignee-完了{background:#dcfce7;color:#166534}.assignee-失敗{background:#fee2e2;color:#b91c1c}.assignee-停止{background:#e2e8f0;color:#475569}.assignee-保留{background:#fef3c7;color:#92400e}.detail-job .facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:12px 0}.detail-job .facts span{background:#f8fafc;border-radius:8px;padding:9px 10px;color:#64748b;font-size:.7rem}.detail-job .facts strong{display:block;color:#0f172a;font-size:.78rem;margin-top:2px}.detail-job .runtime{font-size:.68rem;color:#64748b;background:#f8fafc;padding:9px 10px;border-radius:8px;overflow-wrap:anywhere}.detail-job .recovery-info{margin-top:10px;padding:10px;border-left:3px solid #d97706;background:#fffbeb;color:#78350f;font-size:.72rem}.job-actions,.handoff-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.job-actions button,.handoff-actions button{margin:0;border-radius:8px;padding:8px 11px;border:1px solid #cbd5e1;background:#fff;color:#334155;font-size:.7rem;font-weight:750;cursor:pointer}.job-actions button{background:#fef2f2;border-color:#fecaca;color:#b91c1c}.handoff-actions a,.job-download a{font-size:.7rem;font-weight:700;color:#1d4ed8;text-decoration:none}.handoff-actions span{font-size:.68rem;color:#166534}.job-download{margin-top:10px}',
    '.detail-job details{margin-top:10px;border:1px solid #e2e8f0;border-radius:9px;background:#fff;overflow:hidden}.detail-job summary{cursor:pointer;font-weight:750;font-size:.74rem;padding:10px 12px;list-style:none}.detail-job summary::-webkit-details-marker{display:none}.detail-job summary::after{content:"＋";float:right;color:#94a3b8}.detail-job details[open] summary::after{content:"−"}.detail-job pre{white-space:pre-wrap;word-break:break-word;margin:0;padding:11px 12px;border-top:1px solid #e2e8f0;background:#0f172a;color:#dbeafe;font:500 .7rem/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.result-details pre{max-block-size:min(56dvh,32rem);overflow:auto;overscroll-behavior:contain}.history-toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:9px 11px;border-top:1px solid #e2e8f0;background:#f8fafc}.history-toolbar button{margin:0;padding:6px 9px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#334155;font-size:.66rem;font-weight:700}.history-status{font-size:.66rem;font-weight:700;color:#92400e}.history-log{display:block;max-block-size:min(48dvh,28rem);min-block-size:10rem;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;user-select:text;cursor:text}',
    '.visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}.detail-job{--job-detail-content-height:clamp(22rem,52dvh,31rem)}.detail-job .facts-explained{grid-template-columns:repeat(2,minmax(0,1fr))}.detail-job .facts-explained small{display:block;margin-top:5px;color:#64748b;font-size:.64rem;line-height:1.45}.detail-job>details>pre,.detail-job>details>.chat-thread{display:block;box-sizing:border-box;block-size:var(--job-detail-content-height);max-block-size:none;overflow:auto;overscroll-behavior:contain}.detail-job>details>.history-log{block-size:var(--job-detail-content-height);max-block-size:none;min-block-size:0}.detail-job .conversation-details{border:1px solid #8faac2;box-shadow:0 8px 24px rgba(30,64,91,.12)}.detail-job .conversation-details>summary{display:flex;align-items:center;gap:9px;min-height:58px;padding:10px 12px;background:#f7fbff;color:#17324a}.detail-job .conversation-details>summary::after{margin-left:4px}.chat-summary-icon{display:grid;place-items:center;flex:0 0 30px;width:30px;height:30px;border-radius:50%;background:#06c755;color:#fff;font-size:.65rem;box-shadow:0 0 0 4px #e6f8ed}.chat-summary-copy{display:flex;flex:1;min-width:0;flex-direction:column}.chat-summary-copy strong{font-size:.78rem}.chat-summary-copy small{margin-top:2px;color:#5d7183;font-size:.61rem;font-weight:600}.chat-turn-count{flex:0 0 auto;border-radius:999px;padding:4px 7px;background:#e4eef7;color:#33536e;font-size:.6rem;font-weight:800}.chat-thread{padding:16px 13px 22px;background-color:#b7cbe0;background-image:linear-gradient(135deg,rgba(255,255,255,.08) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.08) 75%);background-size:24px 24px;border-top:1px solid #9fb5ca;scrollbar-gutter:stable}.chat-turn{display:grid;gap:13px;margin-bottom:22px}.chat-turn:last-child{margin-bottom:0}.chat-turn-label{justify-self:center;border-radius:999px;padding:4px 10px;background:rgba(34,57,78,.55);color:#fff;font-size:.6rem;font-weight:800;letter-spacing:.02em}.chat-row{display:flex;align-items:flex-start;gap:8px}.chat-row-user{justify-content:flex-end}.chat-row-assistant{justify-content:flex-start}.chat-avatar{display:grid;place-items:center;flex:0 0 30px;width:30px;height:30px;margin-top:19px;border-radius:50%;background:#fff;color:#35536e;border:1px solid rgba(53,83,110,.2);box-shadow:0 1px 3px rgba(15,23,42,.16);font-size:.62rem;font-weight:850}.chat-row-user .chat-avatar{background:#06c755;color:#fff;border-color:#05a947}.chat-message{display:flex;flex-direction:column;align-items:flex-start;max-width:78%;min-width:0}.chat-row-user .chat-message{align-items:flex-end}.chat-speaker{margin:0 8px 5px;color:#29465f;font-size:.65rem;font-weight:850}.chat-speaker span{margin-left:4px;color:#526b80;font-size:.58rem;font-weight:650}.chat-bubble{position:relative;min-width:48px;border-radius:17px;padding:10px 12px;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.16)}.chat-row-user .chat-bubble{background:#91e85f;border-top-right-radius:5px}.chat-row-assistant .chat-bubble{border-top-left-radius:5px}.chat-row-user .chat-bubble::after{content:"";position:absolute;top:0;right:-7px;border:0 solid transparent;border-top-width:11px;border-left:9px solid #91e85f}.chat-row-assistant .chat-bubble::before{content:"";position:absolute;top:0;left:-7px;border:0 solid transparent;border-top-width:11px;border-right:9px solid #fff}.chat-bubble pre,.chat-meta pre{border:0!important;background:transparent!important;color:#102235!important;padding:0!important;font:500 .75rem/1.65 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;tab-size:2}.chat-message time{margin:4px 8px 0;color:#36546d;font-size:.56rem;font-weight:650}.chat-meta{align-self:stretch;margin-top:8px!important;border-color:rgba(51,83,110,.3)!important;background:rgba(247,251,255,.86)!important}.chat-meta summary{display:flex;justify-content:space-between;gap:8px;padding:8px 10px!important;font-size:.63rem!important;color:#29465f}.chat-meta summary small{color:#60778b;font-size:.58rem}.chat-meta pre{max-height:14rem;overflow:auto;padding:9px 10px!important;border-top:1px solid rgba(51,83,110,.18)!important;font-family:ui-monospace,SFMono-Regular,Consolas,monospace!important;font-size:.66rem!important}',
    '[data-conversation-style="slack"]{border-color:#d8d8d8!important;box-shadow:0 2px 8px rgba(29,28,29,.08)!important}[data-conversation-style="slack"]>summary{background:#f8f8f8!important;color:#1d1c1d!important}[data-conversation-style="slack"] .chat-summary-icon{border-radius:8px;background:#4a154b;box-shadow:none;color:#fff;font-size:1rem}[data-conversation-style="slack"] .chat-summary-copy small{color:#616061}[data-conversation-style="slack"] .chat-turn-count{background:#f0e8f1;color:#4a154b}[data-conversation-style="slack"] .chat-thread{padding:12px 8px 18px;background:#fff;background-image:none;border-top-color:#d8d8d8}[data-conversation-style="slack"] .chat-turn{gap:6px;margin-bottom:14px}[data-conversation-style="slack"] .chat-turn-label{justify-self:start;margin-left:48px;border:1px solid #ddd;border-radius:999px;padding:3px 8px;background:#fff;color:#616061;font-weight:700}[data-conversation-style="slack"] .chat-row,[data-conversation-style="slack"] .chat-row-user,[data-conversation-style="slack"] .chat-row-assistant{justify-content:flex-start;gap:10px;border-radius:6px;padding:7px 8px}[data-conversation-style="slack"] .chat-row:hover{background:#f8f8f8}[data-conversation-style="slack"] .chat-avatar{flex-basis:36px;width:36px;height:36px;margin-top:1px;border:0;border-radius:8px;background:#1264a3;color:#fff;box-shadow:none;font-size:.68rem}[data-conversation-style="slack"] .chat-row-user .chat-avatar{background:#4a154b;border:0}[data-conversation-style="slack"] .chat-message,[data-conversation-style="slack"] .chat-row-user .chat-message{align-items:stretch;flex:1;max-width:none}[data-conversation-style="slack"] .chat-speaker{display:flex;align-items:baseline;gap:6px;margin:0 0 2px;color:#1d1c1d;font-size:.76rem}[data-conversation-style="slack"] .chat-speaker span{margin:0;color:#616061}[data-conversation-style="slack"] .chat-speaker time{margin:0;color:#616061;font-size:.58rem;font-weight:500}[data-conversation-style="slack"] .chat-bubble,[data-conversation-style="slack"] .chat-row-user .chat-bubble,[data-conversation-style="slack"] .chat-row-assistant .chat-bubble{width:100%;border-radius:0;padding:0;background:transparent;box-shadow:none}[data-conversation-style="slack"] .chat-row-user .chat-bubble::after,[data-conversation-style="slack"] .chat-row-assistant .chat-bubble::before{content:none}[data-conversation-style="slack"] .chat-bubble pre{color:#1d1c1d!important;font-size:.75rem!important;line-height:1.5!important}[data-conversation-style="slack"] .chat-meta{border-color:#ddd!important;background:#f8f8f8!important}[data-conversation-style="slack"] .chat-meta summary{color:#1d1c1d}',
    '.queue-summary{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}.empty{padding:48px 20px;text-align:center;color:#64748b}',
    '.settings-area{margin-top:20px;display:grid;gap:12px}.settings-details{background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}.settings-details>summary{display:flex;align-items:center;justify-content:space-between;min-height:52px;padding:15px 18px;font-size:.92rem;list-style:none}.settings-details>summary::-webkit-details-marker{display:none}.settings-details>summary::after{content:"＋"}.settings-details[open]>summary::after{content:"−"}.settings-content{padding:0 18px 18px}.project-grid{display:grid;gap:12px}.project-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px}.project-card-head{display:flex;justify-content:space-between;gap:12px}.project-card h3{margin:0;font-size:.88rem}.project-card a{color:#1d4ed8;font-weight:700}.project-facts{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;color:#64748b;font-size:.7rem}.project-note{margin-top:9px;padding:9px 10px;border-left:3px solid #16a34a;background:#f0fdf4;color:#166534;font-size:.7rem}.project-config-form{display:grid;gap:12px}.project-config-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.project-config-form label{display:block;font-size:.7rem;font-weight:750;color:#475569;margin-bottom:5px}.project-config-form input,.project-config-form select{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px}.project-git-box{border:1px solid #e2e8f0;border-radius:10px;padding:13px;background:#f8fafc}.checkbox-row{display:flex;gap:14px;flex-wrap:wrap}.checkbox-row label{display:inline-flex;align-items:center;gap:7px;margin:0}.checkbox-row input{width:auto}.helper{font-size:.72rem;color:#64748b}',
    '.footer{grid-column:2;display:flex;align-items:center;justify-content:space-between;padding:0 24px;background:#fff;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:.62rem;position:sticky;bottom:0;z-index:14}',
    '@media(max-width:1050px){.app-shell{grid-template-columns:76px minmax(0,1fr)}.brand{padding:0 4px 18px;text-align:center}.brand strong{font-size:.7rem}.brand span,.side-nav .nav-label,.server-status span{display:none}.side-nav a{justify-content:center;padding:0}.nav-mark{color:inherit}.server-status{padding:12px 8px}.server-status strong{justify-content:center;font-size:0}.topbar,.main{grid-column:2}.footer{grid-column:2}.topbar{padding:0 20px}.main{padding:22px 20px}.workspace{grid-template-columns:minmax(0,1.25fr) minmax(360px,1fr)}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.job-table-header,.job-row-summary{grid-template-columns:minmax(190px,1.8fr) minmax(100px,1fr) 105px 110px}.job-table-header span:last-child,.job-updated{display:none}}',
    '@media(max-width:780px){.app-shell{display:block}.sidebar{height:auto;position:static;padding:12px}.brand{display:flex;justify-content:space-between;align-items:center;padding:0 4px 10px}.brand span{display:block}.side-nav{display:flex;overflow:auto;margin-top:7px}.side-nav a{min-width:max-content;padding:0 12px}.side-nav .nav-label{display:inline}.server-status{display:none}.topbar{position:sticky;height:auto;min-height:72px;padding:12px 14px;align-items:flex-start;flex-direction:column;gap:10px}.topbar p{display:none}.topbar-actions{width:100%;min-width:0;gap:7px}.top-search{width:auto;min-width:0;flex:1 1 auto}.topbar-actions .primary-button{flex:0 0 auto;white-space:nowrap;writing-mode:horizontal-tb}.main{padding:16px 12px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.kpi{min-height:94px;padding:14px}.workspace{display:block}.detail-panel{display:none}.detail-panel.is-mobile-open{display:block;position:fixed;inset:0;z-index:100;max-height:none;margin:0;border:0;border-radius:0;overflow:auto;background:#fff}.job-detail-open{overflow:hidden}.mobile-detail-heading{display:grid;position:sticky;top:0;z-index:5;grid-template-columns:1fr auto;align-items:center;gap:8px 12px;min-height:82px;padding:10px 14px;background:#eff6ff;border-bottom:1px solid #bfdbfe;box-shadow:0 2px 8px rgba(15,23,42,.08)}.mobile-detail-close{justify-self:start;min-height:40px;border:1px solid #93c5fd;border-radius:9px;padding:8px 12px;background:#fff;color:#1d4ed8;font-size:.76rem;font-weight:800}.mobile-detail-state{justify-self:end;border-radius:999px;padding:6px 10px;font-size:.7rem;white-space:nowrap}.mobile-detail-title{grid-column:1/-1;min-width:0}.mobile-detail-title small{display:block;color:#64748b;font-size:.62rem;font-weight:750}.mobile-detail-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0f172a;font-size:.84rem}.detail-job{padding:16px 14px 32px}.queue-toolbar{display:block}.filters{margin-top:12px;flex-wrap:wrap}.filters .field,.filters .field:first-child{min-width:0;flex:1}.job-table-header{display:none}.job-row-summary{grid-template-columns:minmax(0,1fr) auto;gap:8px;min-height:82px}.job-project,.job-worker,.job-updated{display:none}.job-state{grid-column:2;grid-row:1}.new-job-form,.project-config-grid{grid-template-columns:1fr}.footer{position:static;padding:10px 14px;gap:10px;flex-wrap:wrap}.footer span:last-child{display:none}}',
    '@media(max-width:780px){.detail-job{--job-detail-content-height:clamp(22rem,58dvh,34rem)}.detail-job .facts-explained{grid-template-columns:1fr}.chat-message{max-width:calc(100% - 42px)}.chat-thread{padding:14px 10px 20px}.chat-bubble{padding:9px 10px}.chat-summary-copy small{display:none}}',
    "</style>",
    "</head>",
    "<body>",
    '<div class="app-shell">',
    '<aside class="sidebar">',
    '<div class="brand"><strong>PSEUDO CODEX</strong><span>Operations Console</span></div>',
    '<nav class="side-nav" aria-label="主要メニュー">',
    '<a href="#overview"><span class="nav-mark">⌂</span><span class="nav-label">概要</span></a>',
    '<a href="#jobs-section"><span class="nav-mark">▤</span><span class="nav-label">ジョブ</span></a>',
    '<a href="#projects-section"><span class="nav-mark">◇</span><span class="nav-label">プロジェクト</span></a>',
    '<a href="#settings-section"><span class="nav-mark">⚙</span><span class="nav-label">設定</span></a>',
    "</nav>",
    '<div class="server-status"><strong><span class="online-dot"></span>System online</strong><span>Ubuntu / ChatGPT dispatcher</span><span>Port 8090 · v0.1.3</span></div>',
    "</aside>",
    '<header class="topbar">',
    '<div><h1>Operations overview</h1><p>ChatGPTとUbuntuの処理状況をリアルタイム監視</p></div>',
    '<div class="topbar-actions">',
    '<input id="job-search" class="top-search" type="search" autocomplete="off" placeholder="ジョブ・プロジェクト・IDを検索" aria-label="ジョブ検索">',
    '<button type="button" class="primary-button" data-new-job-toggle aria-expanded="false">＋ 新規ジョブ</button>',
    "</div>",
    "</header>",
    '<main class="main" id="overview">',
    messageHtml,
    '<section class="kpis" aria-label="ジョブ状況">',
    '<article class="kpi" style="--accent:#2563eb;--tint:#eff6ff"><span class="kpi-label">実行中</span><strong class="kpi-value" data-kpi-value="running">', String(runningCount), '</strong><span class="kpi-note">Workerが処理中</span></article>',
    '<article class="kpi" style="--accent:#d97706;--tint:#fffbeb"><span class="kpi-label">実行待ち</span><strong class="kpi-value" data-kpi-value="queued">', String(queuedCount), '</strong><span class="kpi-note">キューに待機</span></article>',
    '<article class="kpi" style="--accent:#dc2626;--tint:#fef2f2"><span class="kpi-label">要対応</span><strong class="kpi-value" data-kpi-value="attention">', String(attentionCount), '</strong><span class="kpi-note">失敗・保留</span></article>',
    '<article class="kpi" style="--accent:#16a34a;--tint:#f0fdf4"><span class="kpi-label">完了</span><strong class="kpi-value" data-kpi-value="completed">', String(completedCount), '</strong><span class="kpi-note">保存済み</span></article>',
    "</section>",
    '<section id="new-job-panel" class="new-job-panel" hidden>',
    '<div class="panel-heading"><div><h2>新規ジョブ</h2><p>既存の登録APIをそのまま使用します。</p></div><button type="button" class="icon-button" data-new-job-close aria-label="閉じる">×</button></div>',
    '<form method="post" action="/jobs" class="new-job-form">',
    '<div class="field"><label for="project">プロジェクト</label><select id="project" name="project" required>', renderProjectOptions(), '</select></div>',
    '<div class="field"><label for="title">ジョブタイトル</label><input id="title" name="title" maxlength="200" required></div>',
    '<div class="field" style="grid-column:1/-1"><label for="instruction">詳細な自然言語指示</label><textarea id="instruction" name="instruction" maxlength="20000" required></textarea></div>',
    '<div class="submit-field" style="grid-column:1/-1"><button type="submit" class="primary-button">キューへ登録</button></div>',
    "</form>",
    "</section>",
    renderQueueSummary(jobs),
    '<section id="jobs-section" class="workspace">',
    '<div class="queue-card">',
    '<div class="queue-toolbar"><div><h2>ジョブキュー</h2><p>全プロジェクトの実行状態</p></div>',
    '<div class="filters" role="search" aria-label="ジョブ検索・絞り込み">',
    '<div class="field"><label for="job-status-filter">状態</label><select id="job-status-filter"><option value="all">すべて</option><option value="queued">実行待ち</option><option value="running">実行中</option><option value="completed">完了</option><option value="failed">失敗</option><option value="stopped">停止</option></select></div>',
    '<output id="job-result-count" class="result-count" aria-live="polite">表示 ', String(jobs.length), ' / 全 ', String(jobs.length), ' 件</output>',
    "</div></div>",
    '<div class="job-table-header" aria-hidden="true"><span>ジョブ</span><span>プロジェクト</span><span>状態</span><span>担当</span><span>更新</span></div>',
    '<div id="jobs" class="jobs">', renderJobs(jobs), "</div>",
    "</div>",
    '<aside id="job-detail-panel" class="detail-panel" aria-live="polite"><div class="detail-empty"><strong>ジョブを選択</strong><p>一覧からジョブを選ぶと、指示・会話・結果・ログ・操作をここに表示します。</p></div></aside>',
    "</section>",
    '<section class="settings-area" id="projects-section">',
    '<details class="settings-details"><summary>プロジェクト設定を表示</summary><div class="settings-content"><p class="helper">登録済みプロジェクトと実行方式を確認できます。</p><div class="project-grid">', renderProjectCatalog(), "</div></div></details>",
    '<details class="settings-details" id="settings-section"><summary>プロジェクトを追加・更新</summary><div class="settings-content"><p class="helper">既存の設定項目と保存処理は変更していません。</p>', renderProjectConfigForm(), "</div></details>",
    "</section>",
    "</main>",
    '<footer class="footer"><span>Pseudo Codex Console v0.1.3</span><span>3秒ごとに更新 · JST表示</span></footer>',
    "</div>",
    CLIENT_SCRIPT_TAG,
    CONSOLE_UI_SCRIPT,
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
