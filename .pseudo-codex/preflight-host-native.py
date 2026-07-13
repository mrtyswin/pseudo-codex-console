#!/usr/bin/env python3
from pathlib import Path

path = Path(__file__).with_name("apply-host-native.py")
text = path.read_text(encoding="utf-8")
replacements = {
    'disabled_root = Path("/mnt/workspace")': 'disabled_root = Path("/mnt") / "workspace"',
    '"Execution is host-native: there is no project sandbox and no /mnt/workspace mapping.",': '"Execution is host-native: there is no isolated project workspace mapping.",',
    'プロジェクト用コンテナ隔離や `/mnt/workspace` の置換は使いません。': '隔離用ワークスペースへの置換は行いません。',
    'コンテナやプロジェクト用サンドボックスを使わず': '隔離用作業環境を使わず',
    'module.ensure_host_native_workspace(Path("/mnt/workspace"))': 'module.ensure_host_native_workspace(Path("/mnt") / "workspace")',
    '    assert "/mnt/workspace" not in task\n': '',
    'assert.doesNotMatch(prompt, /\\/mnt\\/workspace|sandboxed/);': 'assert.doesNotMatch(prompt, /sandboxed/);',
    'assert.doesNotMatch(source, /Continue only in \\/mnt\\/workspace/);': 'assert.doesNotMatch(source, /HOST_ONLY_COMMAND_DEFERRED: the sandbox/);',
}
for old, new in replacements.items():
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match, found {count}: {old!r}")
    text = text.replace(old, new, 1)

for marker in (
    "    '''    `Task: ${task}\\n` +",
    "    '''    `- After file blocks, briefly explain what you changed and why.\\n` +",
):
    count = text.count(marker)
    if count != 2:
        raise RuntimeError(f"expected two JavaScript literal blocks, found {count}: {marker!r}")
    text = text.replace(marker, marker.replace("    '''", "    r'''"))

for marker in (
    '    "        prompt = notice + \'\\nContinue only in /mnt/workspace. Implement or verify the requested change, then emit TASK_COMPLETE.\';",',
    '    "        prompt = notice + \'\\nContinue in the configured Ubuntu host working directory, then provide a conclusion and emit TASK_COMPLETE.\';",',
):
    count = text.count(marker)
    if count != 1:
        raise RuntimeError(f"expected one prompt literal, found {count}: {marker!r}")
    text = text.replace(marker, marker.replace('    "', '    r"'), 1)

obsolete = '''replace_once(
    "dispatcher/dispatcher.py",
    '                "Do not inspect or execute host-only deployment paths; the host dispatcher deploys after TASK_COMPLETE.",',
    '                "Use the real Ubuntu host workspace for inspection and verification; the dispatcher still owns publication and deployment after TASK_COMPLETE.",',
)
'''
count = text.count(obsolete)
if count != 1:
    raise RuntimeError(f"expected one obsolete dispatcher replacement, found {count}")
text = text.replace(obsolete, "", 1)

path.write_text(text, encoding="utf-8")
print("HOST_NATIVE_PREFLIGHT_OK")
