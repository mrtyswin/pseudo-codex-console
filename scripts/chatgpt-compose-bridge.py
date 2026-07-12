#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import struct
import subprocess
import threading
import time

import yaml


MAX_REQUEST_BYTES = 65536
MAX_OUTPUT_CHARS = 200000
TOKEN_RE = re.compile(r"^[a-f0-9]{64}$")
ALLOWED_ACTIONS = {
    "build",
    "config",
    "down",
    "logs",
    "ps",
    "pull",
    "restart",
    "start",
    "stop",
    "up",
}
DENIED_SERVICE_KEYS = {
    "cap_add",
    "cgroup",
    "cgroup_parent",
    "container_name",
    "credential_spec",
    "device_cgroup_rules",
    "devices",
    "extends",
    "gpus",
    "ipc",
    "network_mode",
    "pid",
    "privileged",
    "provider",
    "security_opt",
    "use_api_socket",
    "userns_mode",
    "uts",
    "volumes_from",
}
DEFAULT_COMPOSE_FILES = (
    "compose.yaml",
    "compose.yml",
    "docker-compose.yml",
    "docker-compose.yaml",
)


class BridgeError(Exception):
    pass


def resolve_within(root: Path, value: str, base: Path | None = None) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise BridgeError("Invalid path in Compose configuration")
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = (base or root) / candidate
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise BridgeError(f"Path is outside the project: {value}") from error
    return resolved


def validate_path_value(root: Path, value, base: Path | None = None) -> None:
    if isinstance(value, str):
        resolve_within(root, value, base)
        return
    if isinstance(value, dict):
        path_value = value.get("path") or value.get("file")
        if path_value:
            resolve_within(root, path_value, base)
            return
    raise BridgeError("Unsupported path value in Compose configuration")


def validate_raw_compose(raw: dict, project: Path) -> None:
    if not isinstance(raw, dict):
        raise BridgeError("Compose file must contain a mapping")
    if raw.get("include"):
        raise BridgeError("Compose include is not allowed")

    services = raw.get("services")
    if not isinstance(services, dict) or not services:
        raise BridgeError("Compose file must define at least one service")

    for service_name, service in services.items():
        if not isinstance(service, dict):
            raise BridgeError(f"Invalid service definition: {service_name}")
        denied = sorted(key for key in DENIED_SERVICE_KEYS if service.get(key))
        if denied:
            raise BridgeError(
                f"Service {service_name} uses denied settings: {', '.join(denied)}"
            )

        env_files = service.get("env_file", [])
        if isinstance(env_files, (str, dict)):
            env_files = [env_files]
        for env_file in env_files or []:
            validate_path_value(project, env_file)

        build = service.get("build")
        if build:
            if isinstance(build, str):
                build_context = resolve_within(project, build)
            elif isinstance(build, dict):
                build_context = resolve_within(project, build.get("context", "."))
                if build.get("dockerfile"):
                    resolve_within(project, build["dockerfile"], build_context)
                if build.get("ssh"):
                    raise BridgeError("Build SSH forwarding is not allowed")
            else:
                raise BridgeError(f"Invalid build configuration: {service_name}")

        for volume in service.get("volumes", []) or []:
            if isinstance(volume, dict):
                volume_type = volume.get("type", "volume")
                if volume_type == "bind":
                    resolve_within(project, volume.get("source", ""))
                elif volume_type not in {"volume", "tmpfs"}:
                    raise BridgeError(f"Unsupported volume type: {volume_type}")
            elif isinstance(volume, str):
                source = volume.split(":", 1)[0]
                if source.startswith(('.', '/', '~')) or "/" in source:
                    resolve_within(project, source)
            else:
                raise BridgeError(f"Invalid volume in service: {service_name}")

    for section_name in ("configs", "secrets"):
        section = raw.get(section_name, {}) or {}
        if not isinstance(section, dict):
            raise BridgeError(f"Invalid top-level {section_name}")
        for item_name, item in section.items():
            if isinstance(item, dict) and item.get("external"):
                raise BridgeError(f"External {section_name} are not allowed: {item_name}")
            if isinstance(item, dict) and item.get("file"):
                resolve_within(project, item["file"])

    for section_name in ("networks", "volumes"):
        section = raw.get(section_name, {}) or {}
        if not isinstance(section, dict):
            raise BridgeError(f"Invalid top-level {section_name}")
        for item_name, item in section.items():
            if isinstance(item, dict) and item.get("external"):
                raise BridgeError(f"External {section_name} are not allowed: {item_name}")
            if isinstance(item, dict) and item.get("driver_opts"):
                raise BridgeError(f"Driver options are not allowed: {item_name}")


def validate_normalized_compose(config: dict, project: Path) -> None:
    services = config.get("services", {})
    if not isinstance(services, dict) or not services:
        raise BridgeError("Normalized Compose configuration has no services")

    for service_name, service in services.items():
        if not isinstance(service, dict):
            raise BridgeError(f"Invalid normalized service: {service_name}")
        denied = sorted(key for key in DENIED_SERVICE_KEYS if service.get(key))
        if denied:
            raise BridgeError(
                f"Service {service_name} uses denied settings: {', '.join(denied)}"
            )

        build = service.get("build")
        if isinstance(build, dict) and build.get("context"):
            resolve_within(project, build["context"])

        for volume in service.get("volumes", []) or []:
            if not isinstance(volume, dict):
                raise BridgeError(f"Unexpected normalized volume: {service_name}")
            volume_type = volume.get("type")
            if volume_type == "bind":
                resolve_within(project, volume.get("source", ""))
            elif volume_type not in {"volume", "tmpfs"}:
                raise BridgeError(f"Unsupported normalized volume type: {volume_type}")

        for port in service.get("ports", []) or []:
            if not isinstance(port, dict):
                raise BridgeError(f"Unexpected port configuration: {service_name}")
            published = port.get("published")
            if published in (None, ""):
                continue
            published_text = str(published)
            try:
                lowest_port = int(published_text.split("-", 1)[0])
            except ValueError as error:
                raise BridgeError(f"Invalid published port: {published_text}") from error
            if lowest_port < 1024 or lowest_port > 65535:
                raise BridgeError(f"Published port is outside 1024-65535: {published_text}")


class ComposeBridge:
    def __init__(self, socket_path: Path, sessions_dir: Path, projects_root: Path):
        self.socket_path = socket_path
        self.sessions_dir = sessions_dir.resolve()
        self.projects_root = projects_root.resolve()
        self.docker_host = f"unix:///run/user/{os.getuid()}/docker.sock"
        self.command_lock = threading.Lock()

    def load_session(self, token: str) -> Path:
        if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
            raise BridgeError("Invalid Compose session token")
        session_file = self.sessions_dir / f"{token}.json"
        try:
            session = json.loads(session_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise BridgeError("Compose session is missing or invalid") from error
        if float(session.get("expires", 0)) < time.time():
            raise BridgeError("Compose session has expired")
        project = Path(session.get("project", "")).resolve()
        try:
            project.relative_to(self.projects_root)
        except ValueError as error:
            raise BridgeError("Compose project is outside the allowed root") from error
        if not project.is_dir():
            raise BridgeError("Compose project directory does not exist")
        return project

    def compose_file(self, project: Path, requested: str) -> Path:
        if requested == "auto":
            for file_name in DEFAULT_COMPOSE_FILES:
                candidate = project / file_name
                if candidate.is_file():
                    return candidate.resolve()
            raise BridgeError("No Compose file found in the project")
        if not isinstance(requested, str) or Path(requested).is_absolute():
            raise BridgeError("Compose file must be a relative path")
        compose_file = resolve_within(project, requested)
        if compose_file.suffix not in {".yaml", ".yml"} or not compose_file.is_file():
            raise BridgeError("Compose file does not exist or is not YAML")
        return compose_file

    def docker_environment(self) -> dict[str, str]:
        return {
            "DOCKER_HOST": self.docker_host,
            "HOME": "/home/ubuntu",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
        }

    def validate(self, project: Path, compose_file: Path, project_name: str) -> None:
        try:
            raw = yaml.safe_load(compose_file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, yaml.YAMLError) as error:
            raise BridgeError(f"Unable to parse Compose YAML: {error}") from error
        validate_raw_compose(raw, project)

        command = [
            "docker",
            "--host",
            self.docker_host,
            "compose",
            "--project-directory",
            str(project),
            "--file",
            str(compose_file),
            "--project-name",
            project_name,
            "config",
            "--format",
            "json",
        ]
        result = subprocess.run(
            command,
            cwd=project,
            env=self.docker_environment(),
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
        )
        if result.returncode != 0:
            raise BridgeError(f"docker compose config failed: {result.stderr.strip()}")
        try:
            normalized = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise BridgeError("docker compose config returned invalid JSON") from error
        validate_normalized_compose(normalized, project)

    def run(self, request: dict) -> dict:
        action = request.get("action")
        if action not in ALLOWED_ACTIONS:
            raise BridgeError(f"Unsupported Compose action: {action}")
        project = self.load_session(request.get("token", ""))
        compose_file = self.compose_file(project, request.get("file", "auto"))
        project_hash = hashlib.sha256(str(project).encode("utf-8")).hexdigest()[:12]
        project_name = f"cba_{project_hash}"
        self.validate(project, compose_file, project_name)

        if action == "config":
            return {"exit_code": 0, "stdout": "Compose configuration is valid\n", "stderr": ""}

        base = [
            "docker",
            "--host",
            self.docker_host,
            "compose",
            "--project-directory",
            str(project),
            "--file",
            str(compose_file),
            "--project-name",
            project_name,
        ]
        action_args = {
            "build": ["build"],
            "down": ["down", "--remove-orphans"],
            "logs": [
                "logs",
                "--no-color",
                "--tail",
                str(max(1, min(int(request.get("tail", 200)), 500))),
            ],
            "ps": ["ps", "--all"],
            "pull": ["pull"],
            "restart": ["restart"],
            "start": ["start"],
            "stop": ["stop"],
            "up": ["up", "--detach", "--remove-orphans"],
        }[action]
        timeout = 900 if action in {"build", "pull", "up"} else 120

        with self.command_lock:
            result = subprocess.run(
                base + action_args,
                cwd=project,
                env=self.docker_environment(),
                text=True,
                capture_output=True,
                timeout=timeout,
                check=False,
            )
        return {
            "exit_code": result.returncode,
            "stdout": result.stdout[-MAX_OUTPUT_CHARS:],
            "stderr": result.stderr[-MAX_OUTPUT_CHARS:],
        }


class BridgeHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        peer_pid, peer_uid, _ = struct.unpack(
            "3i",
            self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")),
        )
        if peer_uid != os.getuid():
            self.write_response({"exit_code": 1, "stdout": "", "stderr": "Peer UID denied\n"})
            return
        request_bytes = self.rfile.readline(MAX_REQUEST_BYTES + 1)
        if len(request_bytes) > MAX_REQUEST_BYTES:
            self.write_response({"exit_code": 1, "stdout": "", "stderr": "Request too large\n"})
            return
        request = None
        try:
            request = json.loads(request_bytes.decode("utf-8"))
            if not isinstance(request, dict):
                raise BridgeError("Request must be a JSON object")
            response = self.server.bridge.run(request)
        except (BridgeError, ValueError, subprocess.TimeoutExpired) as error:
            response = {"exit_code": 1, "stdout": "", "stderr": f"{error}\n"}
        self.write_response(response)
        print(f"peer_pid={peer_pid} action={request.get('action') if isinstance(request, dict) else '?'} exit={response['exit_code']}", flush=True)

    def write_response(self, response: dict) -> None:
        self.wfile.write(json.dumps(response, ensure_ascii=True).encode("utf-8") + b"\n")


class BridgeServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, socket_path: str, bridge: ComposeBridge):
        self.bridge = bridge
        super().__init__(socket_path, BridgeHandler)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--sessions", required=True)
    parser.add_argument("--projects", required=True)
    args = parser.parse_args()

    socket_path = Path(args.socket)
    sessions_dir = Path(args.sessions)
    projects_root = Path(args.projects)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    sessions_dir.mkdir(parents=True, exist_ok=True)
    projects_root.mkdir(parents=True, exist_ok=True)
    sessions_dir.chmod(0o700)
    if socket_path.exists() or socket_path.is_socket():
        socket_path.unlink()

    bridge = ComposeBridge(socket_path, sessions_dir, projects_root)
    server = BridgeServer(str(socket_path), bridge)
    socket_path.chmod(0o600)
    print(f"Compose bridge listening on {socket_path}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        if socket_path.exists() or socket_path.is_socket():
            socket_path.unlink()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
