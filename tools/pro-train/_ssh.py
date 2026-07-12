#!/usr/bin/env python
"""Stable SSH/SFTP helper for the FrameCull 5090 server.

Usage:
  python _ssh.py run "<command>"            # run a remote command, stream output
  python _ssh.py put <local> <remote>       # upload a file via SFTP
  python _ssh.py get <remote> <local>       # download a file via SFTP
  python _ssh.py putscript <local> <remote> # upload then chmod +x

Connection settings are read from FC_SSH_HOST / FC_SSH_PORT / FC_SSH_USER.
Password is read from env FC_SSH_PASS.
All remote commands are run through bash -lc so login env (proxy) is available
only if explicitly sourced; prefer absolute paths + explicit exports inside the
command string itself.
"""
import os
import sys
import time
import subprocess
from pathlib import Path

import paramiko

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HOST = os.environ.get("FC_SSH_HOST", "")
PORT = int(os.environ.get("FC_SSH_PORT", "22"))
USER = os.environ.get("FC_SSH_USER", "")
CONNECT_RETRIES = 4
CONNECT_RETRY_DELAYS_S = (1.5, 3.0, 6.0)


def _client():
    pw = os.environ.get("FC_SSH_PASS")
    if not HOST or not USER or not pw:
        print("ERROR: set FC_SSH_HOST, FC_SSH_USER, and FC_SSH_PASS env vars", file=sys.stderr)
        sys.exit(2)
    last_error = None
    for attempt in range(1, CONNECT_RETRIES + 1):
        cli = paramiko.SSHClient()
        cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            cli.connect(
                HOST,
                port=PORT,
                username=USER,
                password=pw,
                look_for_keys=False,
                allow_agent=False,
                timeout=30,
                banner_timeout=30,
                auth_timeout=30,
            )
            return cli
        except (OSError, TimeoutError, paramiko.SSHException) as error:
            last_error = error
            try:
                cli.close()
            except Exception:
                pass
            if attempt >= CONNECT_RETRIES:
                break
            delay = CONNECT_RETRY_DELAYS_S[min(attempt - 1, len(CONNECT_RETRY_DELAYS_S) - 1)]
            print(
                f"[ssh-helper] connect attempt {attempt}/{CONNECT_RETRIES} failed: {error}. "
                f"Retrying in {delay:.1f}s...",
                file=sys.stderr,
            )
            time.sleep(delay)
    raise last_error


def run(cmd):
    cli = _client()
    try:
        # Use bash -c with the raw command; caller is responsible for exports.
        stdin, stdout, stderr = cli.exec_command(cmd, timeout=None, get_pty=False)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        sys.stdout.write(out)
        if err.strip():
            sys.stderr.write(err)
        sys.stdout.write(f"\n[exit={code}]\n")
        return code
    finally:
        cli.close()


def put(local, remote):
    cli = _client()
    try:
        sftp = cli.open_sftp()
        sftp.put(local, remote)
        st = sftp.stat(remote)
        print(f"uploaded {local} -> {remote} ({st.st_size} bytes)")
        sftp.close()
    finally:
        cli.close()


def _mkdir_p(sftp, remote_dir):
    remote_dir = remote_dir.rstrip("/")
    if not remote_dir:
        return
    parts = []
    cur = remote_dir
    while cur not in ("", "/"):
        parts.append(cur)
        cur = os.path.dirname(cur)
    parts.reverse()
    for path in parts:
        try:
            sftp.stat(path)
        except IOError:
            try:
                sftp.mkdir(path)
            except IOError:
                pass


def putdir(local_dir, remote_dir):
    local_root = Path(local_dir)
    if not local_root.is_dir():
        raise SystemExit(f"local dir not found: {local_dir}")
    cli = _client()
    uploaded = 0
    skipped = 0
    try:
        sftp = cli.open_sftp()
        _mkdir_p(sftp, remote_dir)
        for root, _, files in os.walk(local_root):
            rel_root = Path(root).relative_to(local_root)
            remote_root = remote_dir if str(rel_root) == "." else remote_dir.rstrip("/") + "/" + rel_root.as_posix()
            _mkdir_p(sftp, remote_root)
            for name in files:
                local_path = Path(root) / name
                remote_path = remote_root.rstrip("/") + "/" + name
                try:
                    sftp.put(str(local_path), remote_path)
                    uploaded += 1
                    if uploaded % 50 == 0:
                        print(f"uploaded {uploaded} files ... {local_path}")
                except Exception as exc:
                    skipped += 1
                    print(f"FAILED {local_path} -> {remote_path}: {exc}", file=sys.stderr)
        print(f"uploaded {uploaded} files, skipped {skipped}")
        sftp.close()
    finally:
        cli.close()


def putdir_tar(local_dir, remote_dir):
    local_root = Path(local_dir)
    if not local_root.is_dir():
        raise SystemExit(f"local dir not found: {local_dir}")
    parent = local_root.parent
    name = local_root.name
    cli = _client()
    try:
        sftp = cli.open_sftp()
        _mkdir_p(sftp, remote_dir)
        sftp.close()
        cmd = f"mkdir -p {remote_dir!s} && tar -xf - -C {remote_dir!s}"
        stdin, stdout, stderr = cli.exec_command(cmd, timeout=None, get_pty=False)
        tar_cmd = ["tar.exe", "-cf", "-", "-C", str(parent), name]
        proc = subprocess.Popen(tar_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        sent = 0
        last_report = 0
        try:
            while True:
                chunk = proc.stdout.read(1024 * 1024)
                if not chunk:
                    break
                stdin.write(chunk)
                sent += len(chunk)
                if sent - last_report >= 512 * 1024 * 1024:
                    print(f"sent {sent / (1024**3):.2f} GiB ...")
                    last_report = sent
            stdin.close()
            tar_err = proc.stderr.read().decode("utf-8", "replace")
            tar_code = proc.wait()
            remote_out = stdout.read().decode("utf-8", "replace")
            remote_err = stderr.read().decode("utf-8", "replace")
            code = stdout.channel.recv_exit_status()
            if tar_err.strip():
                print(tar_err, file=sys.stderr)
            if remote_out.strip():
                sys.stdout.write(remote_out)
            if remote_err.strip():
                sys.stderr.write(remote_err)
            print(f"local tar exit={tar_code}, remote exit={code}, sent={sent} bytes")
        finally:
            try:
                proc.kill()
            except Exception:
                pass
    finally:
        cli.close()


def get(remote, local):
    cli = _client()
    try:
        sftp = cli.open_sftp()
        sftp.get(remote, local)
        print(f"downloaded {remote} -> {local}")
        sftp.close()
    finally:
        cli.close()


def putscript(local, remote):
    cli = _client()
    try:
        sftp = cli.open_sftp()
        sftp.put(local, remote)
        sftp.chmod(remote, 0o755)
        print(f"uploaded+chmod {local} -> {remote}")
        sftp.close()
    finally:
        cli.close()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    op = sys.argv[1]
    if op == "run":
        sys.exit(run(sys.argv[2]))
    elif op == "put":
        put(sys.argv[2], sys.argv[3])
    elif op == "putdir":
        putdir(sys.argv[2], sys.argv[3])
    elif op == "putdirtar":
        putdir_tar(sys.argv[2], sys.argv[3])
    elif op == "get":
        get(sys.argv[2], sys.argv[3])
    elif op == "putscript":
        putscript(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
