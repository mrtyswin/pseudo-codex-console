#!/usr/bin/env python3
import argparse
import json
import os
import socket
import sys


ACTIONS = ("build", "config", "down", "logs", "ps", "pull", "restart", "start", "stop", "up")


def main() -> int:
    parser = argparse.ArgumentParser(prog="chatgpt-compose")
    parser.add_argument("action", choices=ACTIONS)
    parser.add_argument("--file", default="auto")
    parser.add_argument("--tail", type=int, default=200)
    args = parser.parse_args()

    token = os.environ.get("CHATGPT_COMPOSE_TOKEN")
    socket_path = os.environ.get("CHATGPT_COMPOSE_SOCKET")
    if not token or not socket_path:
        print(
            "Docker Compose access is available only for configured host projects under "
            "/home/ubuntu/chatgpt-projects.",
            file=sys.stderr,
        )
        return 2

    request = {
        "action": args.action,
        "file": args.file,
        "tail": args.tail,
        "token": token,
    }
    payload = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(920)
        client.connect(socket_path)
        client.sendall(payload)
        response_bytes = b""
        while not response_bytes.endswith(b"\n"):
            chunk = client.recv(65536)
            if not chunk:
                break
            response_bytes += chunk

    response = json.loads(response_bytes.decode("utf-8"))
    sys.stdout.write(response.get("stdout", ""))
    sys.stderr.write(response.get("stderr", ""))
    return int(response.get("exit_code", 1))


if __name__ == "__main__":
    raise SystemExit(main())
