from pathlib import Path

path = Path("app.js")
text = path.read_text(encoding="utf-8")

replacements = [
    (
        "  if (log) requestAnimationFrame(function () { log.scrollTop = state.scrollTop; });",
        "  if (log) requestAnimationFrame(function () {\n"
        "    log.scrollTop = state.paused ? state.scrollTop : log.scrollHeight;\n"
        "    state.scrollTop = log.scrollTop;\n"
        "  });",
    ),
    (
        "        container.insertBefore(existing, reference);\n      }",
        "        container.insertBefore(existing, reference);\n"
        "        restoreCard(existing);\n"
        "      }",
    ),
    (
        "    detailStates.set(node.dataset.detailKey, node.open);\n  }\n}, true);",
        "    detailStates.set(node.dataset.detailKey, node.open);\n"
        "    if (node.open && node.matches('details.history-details')) {\n"
        "      var state = historyState(node.dataset.historyJobId);\n"
        "      var log = node.querySelector('.history-log');\n"
        "      if (log && !state.paused) {\n"
        "        requestAnimationFrame(function () {\n"
        "          log.scrollTop = log.scrollHeight;\n"
        "          state.scrollTop = log.scrollTop;\n"
        "        });\n"
        "      }\n"
        "    }\n"
        "  }\n"
        "}, true);",
    ),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match, found {count}: {old[:80]!r}")
    text = text.replace(old, new, 1)

path.write_text(text, encoding="utf-8")

check_path = Path("check.js")
check_text = check_path.read_text(encoding="utf-8")
anchor = "assert.ok(clientScript.includes(\"button[data-job-action]\"));"
addition = "\n".join([
    anchor,
    "assert.ok(clientScript.includes(\"log.scrollTop = state.paused ? state.scrollTop : log.scrollHeight;\"));",
    "assert.ok(clientScript.includes(\"restoreCard(existing);\"));",
    "assert.ok(clientScript.includes(\"node.open && node.matches('details.history-details')\"));",
])
if check_text.count(anchor) != 1:
    raise SystemExit("check.js anchor mismatch")
check_text = check_text.replace(anchor, addition, 1)
check_path.write_text(check_text, encoding="utf-8")
