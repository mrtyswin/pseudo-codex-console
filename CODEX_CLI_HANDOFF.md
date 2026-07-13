# Ubuntu Codex CLI Handoff

## Purpose

Continue maintaining Pseudo Codex Console directly from the always-on Ubuntu host. The repository is the source of truth; do not modify `/opt/pseudo-codex-console` or `/home/ubuntu/chatgpt-browser-agent` directly except through the repository deploy script.

## Host and Repository

- Ubuntu user: `ubuntu` (SSH host is intentionally not recorded here)
- Repository: `/home/ubuntu/chatgpt-projects/request-console`
- GitHub: `mrtyswin/pseudo-codex-console`
- Production console: `http://127.0.0.1:8090/` on the Ubuntu host
- Console service: `pseudo-codex-console.service`
- Dispatcher service: `pseudo-codex-dispatcher.service`
- Browser service: `chatgpt-browser-agent.service`

## Required Workflow

1. `cd /home/ubuntu/chatgpt-projects/request-console`
2. `git status --short --branch` and preserve unrelated user changes.
3. `git pull --ff-only origin main` before inspecting or editing.
4. Make changes only in the repository.
5. Run `npm run check` and `npm run check:syntax`.
6. For dispatcher changes, also run `python3 tests/dispatcher-host-native.check.py` and `python3 tests/dispatcher-parallel.check.py`.
7. Create an `agent/<description>` branch. Never commit on Ubuntu `main`.
8. Commit and push only that branch, then open a pull request into GitHub `main`.
9. After the pull request is merged, return Ubuntu to `main` and run `scripts/deploy-request-console-main` as user `ubuntu` (not through `sudo`). It performs `pull --ff-only`, all checks, deploy, health, and dispatcher checks.

Do not use the request-console browser queue to modify request-console itself. Self-maintenance is exclusively an Ubuntu Codex CLI workflow. `verify_only` may still be used for read-only browser diagnostics.

## Current Design Constraints

- Normal queued jobs execute on the real Ubuntu host.
- `request-console` self-maintenance is Codex CLI-only and GitHub-first. Ubuntu `main` only fast-forwards and deploys; it never authors commits.
- A single logged-in ChatGPT browser is one external interaction channel. `PSEUDO_CODEX_MAX_WORKERS=1` is required. Jobs may queue, but must not run in parallel through one Chrome profile.
- The dispatcher is the sole owner of terminal job states. The browser agent emits progress and markers only; it must not independently mark jobs done, failed, or blocked.
- Browser agent runtime files are deployed from `agent/agent.js` and `agent/chatgpt.js`.

## Known Recent Fixes

- Browser prompts use the ChatGPT send button, with Enter only as fallback.
- New browser jobs start at `https://chatgpt.com/`, because the prior GPT `/project` route is a chat list and does not reliably start a conversation.
- Retry and auto-continuation were previously racing. This has been fixed by centralizing terminal decisions in the dispatcher.
- Browser responses remain externally intermittent. A missing or disabled send button must be recorded as a transport issue; do not start multiple browser workers to compensate.

## Immediate Verification Plan

Run these one at a time on project `agent-architecture-smoke`:

1. Read-only question, confirm `done` and no changed files.
2. Create one disposable text file, verify host content.
3. Update that file, verify exact content.
4. Delete that file, verify absence.
5. Stop a running disposable job, confirm no queued/running descendants remain.

Do not claim parallel browser execution is supported unless separate browser profiles and independent authenticated sessions are implemented and tested.

## Useful Diagnostics

```bash
curl -fsS http://127.0.0.1:8090/health
systemctl --user status pseudo-codex-dispatcher.service --no-pager
systemctl --user status chatgpt-browser-agent.service --no-pager
tail -n 200 /home/ubuntu/.local/state/pseudo-codex/dispatcher.log
tail -n 200 /home/ubuntu/.chatgpt-poc-daemon.log
```

Do not store passwords, API keys, browser cookies, OpenAI credentials, SSH keys, or copied ChatGPT conversations in this repository or handoff file.
