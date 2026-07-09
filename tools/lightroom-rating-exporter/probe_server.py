"""探测服务器上的"相机"文件夹与 FrameCullModelLab 结构。

密码从环境变量 FC_SSH_PASS 读取，不写入脚本。仅做只读探测。
"""
import os
import sys

import paramiko

HOST = os.environ.get("FC_SSH_HOST", "")
PORT = int(os.environ.get("FC_SSH_PORT", "22"))
USER = os.environ.get("FC_SSH_USER", "")


def main() -> int:
    password = os.environ.get("FC_SSH_PASS")
    if not HOST or not USER or not password:
        print("missing FC_SSH_HOST / FC_SSH_USER / FC_SSH_PASS", file=sys.stderr)
        return 2
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=password, timeout=30)

    def run(cmd: str) -> str:
        _in, out, err = client.exec_command(cmd)
        o = out.read().decode("utf-8", "replace")
        e = err.read().decode("utf-8", "replace")
        return o + (("\n[stderr] " + e) if e.strip() else "")

    print("=== whoami / HOME ===")
    print(run('whoami; echo "HOME=$HOME"'))

    print('=== 查找名为 "相机" 的目录 ===')
    print(run('find /home /data /mnt /srv -maxdepth 7 -type d -name "相机" 2>/dev/null'))

    print("=== /data/FrameCullModelLab 顶层 ===")
    print(run("ls -la /data/FrameCullModelLab 2>/dev/null | head -50"))

    print("=== 在 FrameCullModelLab 下找含 DSC07 的相机原片 ===")
    print(run('find /data/FrameCullModelLab -maxdepth 8 -iname "DSC073*.ARW" 2>/dev/null | head -10'))

    print("=== 全盘找 DSC0 开头 ARW 所在目录(采样) ===")
    print(run('find /home /data /mnt -iname "DSC0*.ARW" 2>/dev/null | head -10'))

    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
