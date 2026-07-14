#!/usr/bin/env python3
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import threading


class Handler(BaseHTTPRequestHandler):
    jobs: list[dict[str, str]] = []

    def do_GET(self) -> None:
        body = json.dumps({"jobs": self.jobs}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


root = Path(__file__).resolve().parents[1]
script = root / "scripts" / "check-browser-restart-safe.py"
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
url = f"http://127.0.0.1:{server.server_port}"


def check(jobs: list[dict[str, str]], deploy_job: str, expected: int) -> str:
    Handler.jobs = jobs
    result = subprocess.run(
        ["python3", str(script), url, deploy_job],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == expected, result.stdout + result.stderr
    return result.stdout


try:
    one = [{"id": "deploying", "status": "running"}]
    two = one + [{"id": "unrelated", "status": "running"}]
    assert "BROWSER_RESTART_SAFE" in check([], "", 0)
    assert "BROWSER_RESTART_SAFE" in check(one, "deploying", 0)
    assert "other jobs are running: unrelated" in check(two, "deploying", 75)
    assert "other jobs are running: deploying" in check(one, "", 75)
    print("BROWSER_RESTART_CONCURRENCY_GUARD_OK")
finally:
    server.shutdown()
    server.server_close()
