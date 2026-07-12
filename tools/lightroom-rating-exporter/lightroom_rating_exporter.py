#!/usr/bin/env python3
"""Recover Lightroom Classic star ratings into portable FrameCull label files.

This tool is intentionally standalone and read-only. It searches Lightroom
Classic catalog files, reads ratings from the SQLite catalog, and writes a
small return package that can be sent back without copying RAW files.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import platform
import queue
import sqlite3
import sys
import threading
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SCHEMA = "framecull-lightroom-rating-export-v1"
IMAGE_EXTENSIONS = {".arw", ".nef", ".cr2", ".cr3", ".raf", ".dng", ".rw2", ".orf", ".jpg", ".jpeg", ".tif", ".tiff"}
DEFAULT_LIMIT = 200


@dataclass(frozen=True)
class LocalPhoto:
    path: Path
    key: str
    base_name: str
    extension: str


@dataclass
class CatalogPhoto:
    catalog_path: Path
    absolute_path: str
    folder_path: str
    file_name: str
    base_name: str
    extension: str
    rating: int | None
    pick: int | None
    image_id: int
    file_id: int

    @property
    def file_key(self) -> str:
        return normalize_key(f"{self.base_name}.{self.extension}")

    @property
    def source_path(self) -> str:
        return join_catalog_path(self.absolute_path, self.folder_path, self.file_name)


def main() -> int:
    args = parse_args()
    if args.gui:
        return run_gui()

    output_dir = Path(args.output).expanduser().resolve()
    photo_dir = Path(args.photo_dir).expanduser().resolve() if args.photo_dir else None
    catalogs = [Path(value).expanduser().resolve() for value in args.catalog] if args.catalog else None
    result = export_ratings(
        output_dir=output_dir,
        photo_dir=photo_dir,
        catalogs=catalogs,
        search_extra=[Path(value).expanduser().resolve() for value in args.search_dir],
        limit=args.limit,
        log=print,
    )
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export Lightroom Classic ratings for FrameCull.")
    parser.add_argument("--gui", action="store_true", help="Open the simple GUI.")
    parser.add_argument("--output", help="Output folder for the return package.")
    parser.add_argument("--photo-dir", help="Optional folder containing the photos to match.")
    parser.add_argument("--catalog", action="append", default=[], help="Optional .lrcat path. May be repeated.")
    parser.add_argument("--search-dir", action="append", default=[], help="Extra directory to search for .lrcat files.")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="Maximum .lrcat files to inspect.")
    args = parser.parse_args()
    if not args.gui and not args.output:
        parser.error("--output is required unless --gui is used")
    return args


def export_ratings(
    *,
    output_dir: Path,
    photo_dir: Path | None,
    catalogs: list[Path] | None,
    search_extra: list[Path] | None = None,
    limit: int = DEFAULT_LIMIT,
    log: Any = None,
) -> dict[str, Any]:
    logger = log or (lambda message: None)
    started = time.time()
    output_dir.mkdir(parents=True, exist_ok=True)
    run_dir = output_dir / f"framecull-lr-ratings-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}"
    run_dir.mkdir(parents=True, exist_ok=False)

    local_photos = index_photo_folder(photo_dir, logger) if photo_dir else {}
    if catalogs:
        catalog_paths = [path for path in catalogs if path.exists() and path.suffix.lower() == ".lrcat"]
    else:
        logger("正在搜索 Lightroom catalog...")
        catalog_paths = discover_catalogs(search_extra or [], limit=limit)
    logger(f"找到 {len(catalog_paths)} 个 catalog。")

    all_rows: list[CatalogPhoto] = []
    catalog_reports: list[dict[str, Any]] = []
    for catalog_path in catalog_paths:
        logger(f"读取: {catalog_path}")
        report, rows = read_catalog(catalog_path)
        catalog_reports.append(report)
        all_rows.extend(rows)

    matched_rows, collisions = match_rows(all_rows, local_photos)
    export_rows = matched_rows if photo_dir else [row for row in all_rows if row.rating is not None and row.rating > 0]
    write_outputs(run_dir, export_rows, collisions, catalog_reports, local_photos, photo_dir, started)
    zip_path = zip_run_dir(run_dir)
    summary = build_summary(run_dir, zip_path, export_rows, collisions, catalog_reports, local_photos, photo_dir, started)
    (run_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_dir / "README.txt").write_text(build_return_readme(summary), encoding="utf-8")
    with zipfile.ZipFile(zip_path, "a", compression=zipfile.ZIP_DEFLATED) as package:
        package.write(run_dir / "summary.json", "summary.json")
        package.write(run_dir / "README.txt", "README.txt")
    logger(f"完成: {zip_path}")
    return {"summary": summary, "outputDir": str(run_dir), "zipPath": str(zip_path)}


def discover_catalogs(extra_dirs: list[Path], limit: int) -> list[Path]:
    roots = candidate_search_roots(extra_dirs)
    seen: set[str] = set()
    catalogs: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for path in safe_rglob_lrcat(root):
            key = str(path.resolve()).lower()
            if key in seen:
                continue
            seen.add(key)
            catalogs.append(path)
            if len(catalogs) >= limit:
                return sort_catalogs(catalogs)
    return sort_catalogs(catalogs)


def candidate_search_roots(extra_dirs: list[Path]) -> list[Path]:
    home = Path.home()
    roots = [
        home / "Pictures" / "Lightroom",
        home / "Pictures",
        home / "Documents",
        home / "Desktop",
    ]
    if platform.system().lower() == "darwin":
        volumes = Path("/Volumes")
        if volumes.exists():
            roots.extend(path for path in volumes.iterdir() if path.is_dir())
    roots.extend(extra_dirs)
    deduped: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        try:
            key = str(root.resolve()).lower()
        except OSError:
            key = str(root).lower()
        if key not in seen:
            seen.add(key)
            deduped.append(root)
    return deduped


def safe_rglob_lrcat(root: Path):
    try:
        yield from root.rglob("*.lrcat")
    except (OSError, PermissionError):
        return


def sort_catalogs(catalogs: list[Path]) -> list[Path]:
    def sort_key(path: Path) -> tuple[float, int, str]:
        try:
            stat = path.stat()
            return (-stat.st_mtime, -stat.st_size, str(path).lower())
        except OSError:
            return (0, 0, str(path).lower())

    return sorted(catalogs, key=sort_key)


def read_catalog(catalog_path: Path) -> tuple[dict[str, Any], list[CatalogPhoto]]:
    report = {
        "catalogPath": str(catalog_path),
        "status": "OK",
        "photos": 0,
        "ratedPhotos": 0,
        "ratingCounts": {},
        "error": "",
    }
    rows: list[CatalogPhoto] = []
    try:
        uri = f"file:{catalog_path.as_posix()}?mode=ro"
        with sqlite3.connect(uri, uri=True) as connection:
            connection.row_factory = sqlite3.Row
            query = """
                SELECT
                    ai.id_local AS image_id,
                    ai.rating AS rating,
                    ai.pick AS pick,
                    lf.id_local AS file_id,
                    lf.baseName AS base_name,
                    lf.extension AS extension,
                    lf.idx_filename AS idx_filename,
                    lf.originalFilename AS original_filename,
                    folder.pathFromRoot AS folder_path,
                    root.absolutePath AS absolute_path
                FROM Adobe_images ai
                JOIN AgLibraryFile lf ON lf.id_local = ai.rootFile
                JOIN AgLibraryFolder folder ON folder.id_local = lf.folder
                JOIN AgLibraryRootFolder root ON root.id_local = folder.rootFolder
                WHERE lower(lf.extension) IN ({})
            """.format(",".join("?" for _ in IMAGE_EXTENSIONS))
            for raw in connection.execute(query, [ext.lstrip(".") for ext in IMAGE_EXTENSIONS]):
                rating = parse_rating(raw["rating"])
                extension = str(raw["extension"] or "").strip().lstrip(".")
                base_name = str(raw["base_name"] or "").strip()
                file_name = str(raw["idx_filename"] or raw["original_filename"] or f"{base_name}.{extension}").strip()
                if "." not in file_name and extension:
                    file_name = f"{file_name}.{extension}"
                row = CatalogPhoto(
                    catalog_path=catalog_path,
                    absolute_path=str(raw["absolute_path"] or ""),
                    folder_path=str(raw["folder_path"] or ""),
                    file_name=file_name,
                    base_name=base_name,
                    extension=extension,
                    rating=rating,
                    pick=parse_pick(raw["pick"]),
                    image_id=int(raw["image_id"]),
                    file_id=int(raw["file_id"]),
                )
                rows.append(row)
                if rating is not None and rating > 0:
                    key = str(rating)
                    report["ratingCounts"][key] = report["ratingCounts"].get(key, 0) + 1
        report["photos"] = len(rows)
        report["ratedPhotos"] = sum(1 for row in rows if row.rating is not None and row.rating > 0)
    except Exception as exc:
        report["status"] = "ERROR"
        report["error"] = repr(exc)
    return report, rows


def parse_rating(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        rating = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, min(5, rating))


def parse_pick(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def index_photo_folder(photo_dir: Path | None, logger: Any) -> dict[str, list[LocalPhoto]]:
    if not photo_dir or not photo_dir.exists():
        return {}
    logger(f"索引照片文件夹: {photo_dir}")
    index: dict[str, list[LocalPhoto]] = {}
    for path in photo_dir.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        item = LocalPhoto(
            path=path,
            key=normalize_key(path.name),
            base_name=path.stem,
            extension=path.suffix.lower().lstrip("."),
        )
        index.setdefault(item.key, []).append(item)
    logger(f"照片文件夹里找到 {sum(len(items) for items in index.values())} 张可匹配图片。")
    return index


def match_rows(rows: list[CatalogPhoto], local_index: dict[str, list[LocalPhoto]]) -> tuple[list[CatalogPhoto], list[dict[str, Any]]]:
    if not local_index:
        return [row for row in rows if row.rating is not None and row.rating > 0], []

    matched: list[CatalogPhoto] = []
    collisions: list[dict[str, Any]] = []
    for row in rows:
        if row.rating is None or row.rating <= 0:
            continue
        local_matches = local_index.get(row.file_key, [])
        if len(local_matches) == 1:
            matched.append(row)
        elif len(local_matches) > 1:
            collisions.append({
                "fileName": row.file_name,
                "catalogPath": row.source_path,
                "rating": row.rating,
                "localMatches": [str(item.path) for item in local_matches],
            })
    return matched, collisions


def write_outputs(
    run_dir: Path,
    rows: list[CatalogPhoto],
    collisions: list[dict[str, Any]],
    catalog_reports: list[dict[str, Any]],
    local_index: dict[str, list[LocalPhoto]],
    photo_dir: Path | None,
    started: float,
) -> None:
    label_rows, label_collisions = choose_unambiguous_label_rows(rows)
    collisions.extend(label_collisions)
    labels: dict[str, int] = {}
    source_names: dict[str, str] = {}
    source_paths: dict[str, str] = {}
    items: list[dict[str, Any]] = []
    for row in label_rows:
        photo_id = row.base_name
        labels[photo_id] = int(row.rating or 0)
        source_names[photo_id] = row.file_name
        source_paths[photo_id] = row.source_path
    for row in rows:
        items.append(row_to_dict(row))

    manifest = {
        "schema": SCHEMA,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "lightroom-classic-catalog",
        "photoDir": str(photo_dir) if photo_dir else "",
        "catalogs": catalog_reports,
        "photoCountInFolder": sum(len(value) for value in local_index.values()) if local_index else None,
        "labeledCount": len(labels),
        "positiveDefinition": "rating >= 3",
        "negativeDefinition": "rating 0/1",
        "labels": labels,
        "sourceNames": source_names,
        "sourcePaths": source_paths,
        "items": items,
        "unambiguousLabelCount": len(label_rows),
        "ambiguousLabelCount": len(label_collisions),
        "elapsedSeconds": round(time.time() - started, 2),
    }
    (run_dir / "labels-from-lrcat.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(run_dir / "ratings.csv", [row_to_dict(row) for row in rows])
    write_json(run_dir / "catalog-report.json", catalog_reports)
    if collisions:
        write_csv(run_dir / "collision-report.csv", collisions)
    else:
        (run_dir / "collision-report.csv").write_text("", encoding="utf-8")


def choose_unambiguous_label_rows(rows: list[CatalogPhoto]) -> tuple[list[CatalogPhoto], list[dict[str, Any]]]:
    by_id: dict[str, list[CatalogPhoto]] = {}
    for row in rows:
        by_id.setdefault(row.base_name, []).append(row)

    chosen: list[CatalogPhoto] = []
    collisions: list[dict[str, Any]] = []
    for photo_id, group in by_id.items():
        unique = {
            (row.source_path, row.file_name, row.extension.lower(), row.rating)
            for row in group
        }
        if len(unique) == 1:
            chosen.append(group[0])
            continue
        collisions.append({
            "type": "labelIdCollision",
            "baseName": photo_id,
            "candidateCount": len(group),
            "ratings": sorted({str(row.rating) for row in group}),
            "sourcePaths": " | ".join(sorted({row.source_path for row in group})[:12]),
        })
    return chosen, collisions


def row_to_dict(row: CatalogPhoto) -> dict[str, Any]:
    return {
        "catalog": str(row.catalog_path),
        "absolutePath": row.absolute_path,
        "folderPath": row.folder_path,
        "sourcePath": row.source_path,
        "fileName": row.file_name,
        "baseName": row.base_name,
        "extension": row.extension,
        "rating": row.rating,
        "pick": row.pick,
        "imageId": row.image_id,
        "fileId": row.file_id,
    }


def build_summary(
    run_dir: Path,
    zip_path: Path,
    rows: list[CatalogPhoto],
    collisions: list[dict[str, Any]],
    catalog_reports: list[dict[str, Any]],
    local_index: dict[str, list[LocalPhoto]],
    photo_dir: Path | None,
    started: float,
) -> dict[str, Any]:
    rating_counts: dict[str, int] = {}
    for row in rows:
        key = str(row.rating or 0)
        rating_counts[key] = rating_counts.get(key, 0) + 1
    return {
        "schema": SCHEMA,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "outputDir": str(run_dir),
        "zipPath": str(zip_path),
        "photoDir": str(photo_dir) if photo_dir else "",
        "photoCountInFolder": sum(len(value) for value in local_index.values()) if local_index else None,
        "catalogsScanned": len(catalog_reports),
        "catalogsWithRatings": sum(1 for report in catalog_reports if report.get("ratedPhotos", 0) > 0),
        "ratedPhotos": len(rows),
        "ratingCounts": dict(sorted(rating_counts.items())),
        "collisions": len(collisions),
        "elapsedSeconds": round(time.time() - started, 2),
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    for row in rows:
        for key in row.keys():
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def zip_run_dir(run_dir: Path) -> Path:
    zip_path = run_dir.with_suffix(".zip")
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for file_path in run_dir.iterdir():
            if file_path.is_file():
                package.write(file_path, file_path.name)
    return zip_path


def build_return_readme(summary: dict[str, Any]) -> str:
    return (
        "FrameCull Lightroom 星级回传文件\n"
        "\n"
        "把这个 zip 发回给 FrameCull 使用者即可。里面包含 labels-from-lrcat.json、ratings.csv、catalog-report.json。\n"
        "本工具只读取 Lightroom Classic catalog，不修改照片，也不修改 catalog。\n"
        "\n"
        f"已导出有星级照片: {summary['ratedPhotos']}\n"
        f"星级分布: {json.dumps(summary['ratingCounts'], ensure_ascii=False)}\n"
        f"输出目录: {summary['outputDir']}\n"
    )


def normalize_key(name: str) -> str:
    return name.replace("\\", "/").split("/")[-1].lower()


def join_catalog_path(root: str, folder: str, file_name: str) -> str:
    root = (root or "").replace("\\", "/")
    folder = (folder or "").replace("\\", "/")
    if root and not root.endswith("/"):
        root += "/"
    if folder and not folder.endswith("/"):
        folder += "/"
    return root + folder + file_name


def run_gui() -> int:
    try:
        import tkinter as tk
        from tkinter import filedialog, messagebox, ttk
    except Exception as exc:
        print(f"GUI is unavailable because tkinter could not be loaded: {exc}", file=sys.stderr)
        return 3

    root = tk.Tk()
    root.title("FrameCull Lightroom 星级回收")
    root.geometry("760x520")
    root.minsize(720, 480)

    output_var = tk.StringVar(value=str(Path.home() / "Desktop"))
    photo_var = tk.StringVar(value="")
    status_var = tk.StringVar(value="选择输出文件夹后，点击开始。照片文件夹可选。")
    events: "queue.Queue[tuple[str, Any]]" = queue.Queue()

    frame = ttk.Frame(root, padding=18)
    frame.pack(fill="both", expand=True)

    title = ttk.Label(frame, text="FrameCull Lightroom 星级回收", font=("", 18, "bold"))
    title.pack(anchor="w")
    ttk.Label(frame, text="一键搜索 Lightroom Classic catalog，生成可回传的星级文件。").pack(anchor="w", pady=(4, 16))

    def choose_output() -> None:
        value = filedialog.askdirectory(title="选择回传文件输出位置", initialdir=output_var.get() or str(Path.home()))
        if value:
            output_var.set(value)

    def choose_photo() -> None:
        value = filedialog.askdirectory(title="可选：选择照片文件夹，用于只匹配这一组照片", initialdir=str(Path.home()))
        if value:
            photo_var.set(value)

    def clear_photo() -> None:
        photo_var.set("")

    def row(label: str, variable: tk.StringVar, command: Any, button_text: str) -> None:
        wrapper = ttk.Frame(frame)
        wrapper.pack(fill="x", pady=6)
        ttk.Label(wrapper, text=label, width=14).pack(side="left")
        ttk.Entry(wrapper, textvariable=variable).pack(side="left", fill="x", expand=True, padx=(0, 8))
        ttk.Button(wrapper, text=button_text, command=command).pack(side="left")

    row("输出文件夹", output_var, choose_output, "选择")
    photo_row = ttk.Frame(frame)
    photo_row.pack(fill="x", pady=6)
    ttk.Label(photo_row, text="照片文件夹", width=14).pack(side="left")
    ttk.Entry(photo_row, textvariable=photo_var).pack(side="left", fill="x", expand=True, padx=(0, 8))
    ttk.Button(photo_row, text="选择", command=choose_photo).pack(side="left")
    ttk.Button(photo_row, text="不指定", command=clear_photo).pack(side="left", padx=(6, 0))

    log_box = tk.Text(frame, height=14, wrap="word")
    log_box.pack(fill="both", expand=True, pady=(14, 8))
    log_box.insert("end", "提示：朋友不知道 catalog 在哪也没关系。直接点开始，工具会自动搜索常见 Lightroom 位置。\n")
    log_box.configure(state="disabled")

    progress = ttk.Progressbar(frame, mode="indeterminate")
    progress.pack(fill="x", pady=(4, 8))

    buttons = ttk.Frame(frame)
    buttons.pack(fill="x")
    start_button = ttk.Button(buttons, text="开始生成回传文件")
    start_button.pack(side="right")
    ttk.Label(buttons, textvariable=status_var).pack(side="left")

    def append_log(message: str) -> None:
        log_box.configure(state="normal")
        log_box.insert("end", message + "\n")
        log_box.see("end")
        log_box.configure(state="disabled")

    def worker() -> None:
        try:
            result = export_ratings(
                output_dir=Path(output_var.get()).expanduser(),
                photo_dir=Path(photo_var.get()).expanduser() if photo_var.get().strip() else None,
                catalogs=None,
                search_extra=[],
                limit=DEFAULT_LIMIT,
                log=lambda message: events.put(("log", message)),
            )
            events.put(("done", result))
        except Exception as exc:
            events.put(("error", repr(exc)))

    def start() -> None:
        if not output_var.get().strip():
            messagebox.showwarning("缺少输出文件夹", "请先选择输出文件夹。")
            return
        start_button.configure(state="disabled")
        progress.start(10)
        status_var.set("正在搜索和导出...")
        threading.Thread(target=worker, daemon=True).start()

    def poll_events() -> None:
        try:
            while True:
                kind, payload = events.get_nowait()
                if kind == "log":
                    append_log(str(payload))
                elif kind == "done":
                    progress.stop()
                    start_button.configure(state="normal")
                    summary = payload["summary"]
                    status_var.set(f"完成：{summary['ratedPhotos']} 张有星级")
                    append_log(f"回传 zip: {payload['zipPath']}")
                    messagebox.showinfo("完成", f"已生成回传文件：\n{payload['zipPath']}")
                elif kind == "error":
                    progress.stop()
                    start_button.configure(state="normal")
                    status_var.set("失败")
                    append_log("错误: " + str(payload))
                    messagebox.showerror("失败", str(payload))
        except queue.Empty:
            pass
        root.after(200, poll_events)

    start_button.configure(command=start)
    root.after(200, poll_events)
    root.after(80, lambda: force_initial_draw(root))
    root.mainloop()
    return 0


def force_initial_draw(root: Any) -> None:
    """Work around a macOS Tk bug where the window renders blank/white until it
    is resized or refocused. We nudge the window forward and force a redraw."""
    try:
        root.deiconify()
        root.lift()
        root.focus_force()
        root.attributes("-topmost", True)
        root.update_idletasks()
        root.update()
        root.attributes("-topmost", False)
        width = root.winfo_width() or 760
        height = root.winfo_height() or 520
        # A 1px geometry toggle forces the content area to repaint on macOS.
        root.geometry(f"{width}x{height + 1}")
        root.update_idletasks()
        root.geometry(f"{width}x{height}")
        root.update_idletasks()
    except Exception:
        # Drawing nudges are best-effort; never block the GUI on them.
        pass


if __name__ == "__main__":
    raise SystemExit(main())
