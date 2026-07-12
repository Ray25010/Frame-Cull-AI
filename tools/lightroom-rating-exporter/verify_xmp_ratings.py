"""核验本地相机文件夹已写入的 XMP sidecar：数量、星级分布、抽样内容。"""
import collections
import os
import re

RATING_RE = re.compile(r"<xmp:Rating>\s*(\d+)\s*</xmp:Rating>")


def main() -> int:
    folder = os.environ["FC_CAMERA_DIR"]
    files = os.listdir(folder)
    xmps = [f for f in files if f.upper().endswith(".XMP")]
    print("XMP 总数:", len(xmps))

    dist = collections.Counter()
    orphan = []
    for x in xmps:
        base = os.path.splitext(x)[0]
        if not os.path.exists(os.path.join(folder, base + ".ARW")):
            orphan.append(x)
        text = open(os.path.join(folder, x), encoding="utf-8", errors="replace").read()
        m = RATING_RE.search(text)
        dist[int(m.group(1)) if m else "no-rating"] += 1

    print("星级分布:", dict(sorted(dist.items(), key=lambda kv: str(kv[0]))))
    print("没有对应 ARW 的孤儿 XMP:", len(orphan), orphan[:5])

    sample = sorted(xmps)[0]
    print(f"\n=== 抽样内容 {sample} ===")
    print(open(os.path.join(folder, sample), encoding="utf-8").read())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
