from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


app_path = Path("app.js")
app = app_path.read_text(encoding="utf-8")

app = replace_once(
    app,
    "    historyStates.set(jobId, {paused: false, text: '', scrollTop: 0, status: ''});",
    "    historyStates.set(jobId, {paused: false, text: '', scrollTop: 0, status: '', autoScrolling: false});",
    "history state",
)

app = replace_once(
    app,
    """function restoreCard(card) {
  var history = card.querySelector('details.history-details');
  if (!history) return;
  var state = historyState(history.dataset.historyJobId);
  var log = history.querySelector('.history-log');
  if (log) requestAnimationFrame(function () {
    log.scrollTop = state.paused ? state.scrollTop : log.scrollHeight;
    state.scrollTop = log.scrollTop;
  });
}
""",
    """function scrollHistoryToBottom(detailsNode, state) {
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
""",
    "restore helper",
)

app = replace_once(
    app,
    """        existing.replaceWith(fresh);
        restoreCard(fresh);
        existing = fresh;
      } else if (!existing) {
        var holder = document.createElement('div');
        holder.innerHTML = renderJob(job);
        existing = holder.firstElementChild;
        var reference = container.children[index] || null;
        container.insertBefore(existing, reference);
        restoreCard(existing);
      }
""",
    """        existing.replaceWith(fresh);
        existing = fresh;
      } else if (!existing) {
        var holder = document.createElement('div');
        holder.innerHTML = renderJob(job);
        existing = holder.firstElementChild;
        var reference = container.children[index] || null;
        container.insertBefore(existing, reference);
      }
      if (existing) restoreCard(existing);
""",
    "refresh restore",
)

app = replace_once(
    app,
    """    if (node.open && node.matches('details.history-details')) {
      var state = historyState(node.dataset.historyJobId);
      var log = node.querySelector('.history-log');
      if (log && !state.paused) {
        requestAnimationFrame(function () {
          log.scrollTop = log.scrollHeight;
          state.scrollTop = log.scrollTop;
        });
      }
    }
""",
    """    if (node.open && node.matches('details.history-details')) {
      var state = historyState(node.dataset.historyJobId);
      if (!state.paused) scrollHistoryToBottom(node, state);
    }
""",
    "toggle restore",
)

app = replace_once(
    app,
    """document.addEventListener('pointerdown', function (event) {
  var detailsNode = event.target.closest && event.target.closest('details.history-details');
  if (!detailsNode) return;
  var state = historyState(detailsNode.dataset.historyJobId);
  state.paused = true;
  state.status = '更新停止中';
}, true);
""",
    """document.addEventListener('pointerdown', function (event) {
  var log = event.target.closest && event.target.closest('.history-log');
  if (!log) return;
  var detailsNode = log.closest('details.history-details');
  var state = historyState(detailsNode.dataset.historyJobId);
  state.paused = true;
  state.status = '更新停止中';
}, true);
""",
    "pointer interaction",
)

app = replace_once(
    app,
    """  var detailsNode = log.closest('details.history-details');
  var state = historyState(detailsNode.dataset.historyJobId);
  state.paused = true;
  state.scrollTop = log.scrollTop;
  state.status = '更新停止中';
""",
    """  var detailsNode = log.closest('details.history-details');
  var state = historyState(detailsNode.dataset.historyJobId);
  state.scrollTop = log.scrollTop;
  if (state.autoScrolling) return;
  state.paused = true;
  state.status = '更新停止中';
""",
    "scroll guard",
)

app = replace_once(
    app,
    """    if (historyButton.dataset.historyAction === 'latest') {
      state.paused = false;
      state.status = '';
      await refreshJobs();
""",
    """    if (historyButton.dataset.historyAction === 'latest') {
      state.paused = false;
      state.status = '';
      scrollHistoryToBottom(historyNode, state);
      await refreshJobs();
""",
    "latest action",
)

app_path.write_text(app, encoding="utf-8")

check_path = Path("check.js")
check = check_path.read_text(encoding="utf-8")
check = replace_once(
    check,
    """assert.ok(clientScript.includes("log.scrollTop = state.paused ? state.scrollTop : log.scrollHeight;"));
assert.ok(clientScript.includes("restoreCard(existing);"));
assert.ok(clientScript.includes("node.open && node.matches('details.history-details')"));
""",
    """assert.ok(clientScript.includes("function scrollHistoryToBottom(detailsNode, state)"));
assert.ok(clientScript.includes("state.autoScrolling = true;"));
assert.ok(clientScript.includes("if (existing) restoreCard(existing);"));
assert.ok(clientScript.includes("event.target.closest('.history-log')"));
assert.ok(clientScript.includes("if (state.autoScrolling) return;"));
assert.ok(clientScript.includes("scrollHistoryToBottom(historyNode, state);"));
assert.ok(clientScript.includes("node.open && node.matches('details.history-details')"));
""",
    "regression checks",
)
check_path.write_text(check, encoding="utf-8")
