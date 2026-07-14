#!/usr/bin/env python3
"""Refuse a shared-browser restart while another console job is running."""

from __future__ import annotations

import json
import sys
from urllib import request


def running_job_ids(console_url: str) -> list[str]:
    with request.urlopen(console_url.rstrip("/") + "/api/jobs", timeout=10) as response:
        payload = json.load(response)
    jobs = payload.get("jobs", []) if isinstance(payload, dict) else []
    return [
        str(job.get("id", ""))
        for job in jobs
        if isinstance(job, dict) and job.get("status") == "running"
    ]


def main() -> int:
    console_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8090"
    deploy_job_id = sys.argv[2] if len(sys.argv) > 2 else ""
    running = running_job_ids(console_url)
    other_jobs = [job_id for job_id in running if not deploy_job_id or job_id != deploy_job_id]
    if other_jobs:
        print(
            "AUTO_DEPLOY_FAILED browser agent restart deferred; other jobs are running: "
            + ",".join(other_jobs)
        )
        return 75
    print(
        "BROWSER_RESTART_SAFE running="
        + str(len(running))
        + " deploy_job="
        + (deploy_job_id or "manual")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
