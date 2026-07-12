"""把回传的 1/2/3 星写成 ARW 同名 XMP sidecar（不改原始 RAW）。

设计要点：
- 只针对本地存在的 ARW；星级来自回传 ratings.csv（去重同一 catalog 的双挂载路径）。
- 生成 `<baseName>.xmp`，写 `xmp:Rating`，与 Lightroom Classic 兼容。
- 若本地已存在同名 XMP：默认保护已有的 4/5 星不被覆盖（用户后续手动补打），
  仅在 --overwrite 时强制覆盖，或对没有 rating 的 XMP 补写。
- 默认 dry-run，仅预览；加 --apply 才真正写盘。

环境变量：
  FC_CAMERA_DIR   本地相机文件夹
  FC_RATINGS_CSV  ratings.csv 路径
"""
import argparse
import collections
import csv
import os
import re

CANONICAL_CATALOG = "/Users/kkeria1/Pictures/1/1.lrcat"

XMP_TEMPLATE = (
    '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="FrameCull LR Rating Injector 1.0">\n'
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
    '  <rdf:Description rdf:about=""\n'
    '    xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n'
    "   <xmp:Rating>{rating}</xmp:Rating>\n"
    "  </rdf:Description>\n"
    " </rdf:RDF>\n"
    "</x:xmpmeta>\n"
    '<?xpacket end="w"?>\n'
)

RATING_RE = re.compile(r"<xmp:Rating>\s*(\d+)\s*</xmp:Rating>")
RATING_ATTR_RE = re.compile(r'xmp:Rating\s*=\s*"(\d+)"')


def load_ratings(csv_path: str) -> dict:
    rows = list(csv.DictReader(open(csv_path, encoding="utf-8-sig")))
    cam = [
        r
        for r in rows
        if r["catalog"] == CANONICAL_CATALOG and "相机" in r["folderPath"]
    ]
    ratings: dict = {}
    for r in cam:
        base = r["baseName"]
        rating = int(r["rating"])
        # 同名取较高星级，避免 ARW/JPG 两条记录打架
        if base not in ratings or rating > ratings[base]:
            ratings[base] = rating
    return ratings


def existing_rating(xmp_path: str):
    try:
        text = open(xmp_path, encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    m = RATING_RE.search(text) or RATING_ATTR_RE.search(text)
    return int(m.group(1)) if m else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写盘（缺省仅 dry-run 预览）")
    ap.add_argument(
        "--overwrite",
        action="store_true",
        help="覆盖已存在 XMP 里的 rating（默认保护已有 4/5 星）",
    )
    args = ap.parse_args()

    folder = os.environ["FC_CAMERA_DIR"]
    csv_path = os.environ["FC_RATINGS_CSV"]

    ratings = load_ratings(csv_path)
    files = os.listdir(folder)
    arw_base = {
        os.path.splitext(f)[0]: f for f in files if f.upper().endswith(".ARW")
    }

    stats = collections.Counter()
    plan = []
    for base, rating in sorted(ratings.items()):
        if base not in arw_base:
            stats["skip_no_local_arw"] += 1
            continue
        xmp_path = os.path.join(folder, base + ".xmp")
        if os.path.exists(xmp_path):
            cur = existing_rating(xmp_path)
            if cur is not None and not args.overwrite:
                # 保护用户手动补的高星级，仅在已有星级更低或缺失时补写
                if cur >= rating:
                    stats["skip_existing_protected"] += 1
                    continue
            stats["update_existing"] += 1
        else:
            stats["create_new"] += 1
        plan.append((base, rating, xmp_path))

    print("=== 注入计划 ===")
    print("待写入条目:", len(plan))
    by_rating = collections.Counter(r for _, r, _ in plan)
    print("按星级:", dict(sorted(by_rating.items())))
    print("统计:", dict(stats))
    print("样例:", [(b, r) for b, r, _ in plan[:8]])

    if not args.apply:
        print("\n[dry-run] 未写盘。确认无误后加 --apply 执行。")
        return 0

    written = 0
    for base, rating, xmp_path in plan:
        with open(xmp_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(XMP_TEMPLATE.format(rating=rating))
        written += 1
    print(f"\n[applied] 已写入 {written} 个 XMP sidecar 到 {folder}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
