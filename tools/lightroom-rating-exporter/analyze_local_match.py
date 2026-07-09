"""核对本地相机文件夹与回传星级表的匹配情况（只读分析，不写任何文件）。

路径从环境变量读取，避免中文路径在命令行被转义破坏：
  FC_CAMERA_DIR   本地相机文件夹
  FC_RATINGS_CSV  ratings.csv 路径
"""
import collections
import csv
import os

CANONICAL_CATALOG = "/Users/kkeria1/Pictures/1/1.lrcat"


def main() -> int:
    folder = os.environ["FC_CAMERA_DIR"]
    csv_path = os.environ["FC_RATINGS_CSV"]

    files = os.listdir(folder)
    exts = collections.Counter(os.path.splitext(f)[1].upper() for f in files)
    print("文件夹总文件数:", len(files))
    print("扩展名分布:", dict(exts))

    arw = [f for f in files if f.upper().endswith(".ARW")]
    xmp = [f for f in files if f.upper().endswith(".XMP")]
    print("ARW 数:", len(arw), "; 现有 XMP 数:", len(xmp))

    rows = list(csv.DictReader(open(csv_path, encoding="utf-8-sig")))
    cam = [
        r
        for r in rows
        if r["catalog"] == CANONICAL_CATALOG and "相机" in r["folderPath"]
    ]
    rated = {r["baseName"]: int(r["rating"]) for r in cam}
    print("星级表中相机条目:", len(cam), "; 去重 baseName:", len(rated))
    print("星级表扩展名:", dict(collections.Counter(r["extension"] for r in cam)))

    local_base = {os.path.splitext(f)[0]: f for f in arw}
    matched = [b for b in rated if b in local_base]
    missing_local = [b for b in rated if b not in local_base]
    print("能匹配上的 ARW:", len(matched))
    print("星级表有但本地缺失:", len(missing_local), missing_local[:10])
    print("匹配上的星级分布:", dict(collections.Counter(rated[b] for b in matched)))

    # JPG 星级条目（如本地也有同名 JPG）
    jpg_rated = {
        r["baseName"]: int(r["rating"]) for r in cam if r["extension"].upper() == "JPG"
    }
    print("星级表中 JPG 条目:", len(jpg_rated))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
