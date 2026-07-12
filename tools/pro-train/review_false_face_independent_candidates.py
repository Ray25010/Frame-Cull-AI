#!/usr/bin/env python
"""Review zero-overlap independent false-face candidates with a lightweight GUI."""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


FIELD_MANUAL = "manualLabel"
FIELD_REAL = "hasRealHumanFace"
FIELD_ROLE = "sampleRole"
FIELD_SCENE = "scene"
FIELD_REASON = "illusionReason"
FIELD_NOTES = "notes"

MANUAL_VALUES = ["", "human-confirmed", "rejected"]
REAL_VALUES = ["", "true", "false"]
ROLE_VALUES = ["", "false_face_positive", "real_face_control"]
SCENE_VALUES = [
    "",
    "landscape",
    "product_object",
    "empty_scene",
    "event",
    "food",
    "documentary_moment",
    "other",
]

WINDOW_TITLE = "FrameCull v13 独立假脸候选审核"
TOOLBAR_HINT = "快捷键：← / → 切图，Ctrl+S 保存，Ctrl+Enter 保存并下一张"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input-csv",
        default="output/semantic-false-face-diagnosis/v13-eval/wutai-landscape-food-seed.csv",
    )
    parser.add_argument("--output-csv", default="")
    parser.add_argument("--summary-json", default="")
    parser.add_argument("--start-index", type=int, default=0)
    parser.add_argument("--readonly", action="store_true")
    parser.add_argument("--no-autosave", action="store_true")
    return parser.parse_args()


def read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        return list(reader.fieldnames or []), rows


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def is_nonblank(value: str) -> bool:
    return bool(str(value or "").strip())


def normalize_bool_text(value: str) -> str:
    text = str(value or "").strip().lower()
    if text in {"true", "1", "yes", "y"}:
        return "true"
    if text in {"false", "0", "no", "n"}:
        return "false"
    return ""


def is_review_complete(row: dict[str, str]) -> bool:
    manual = str(row.get(FIELD_MANUAL, "") or "").strip().lower()
    if manual == "rejected":
        return True
    if manual != "human-confirmed":
        return False
    return all(
        is_nonblank(row.get(field, ""))
        for field in (FIELD_REAL, FIELD_ROLE, FIELD_SCENE, FIELD_REASON)
    )


def build_summary(rows: list[dict[str, str]]) -> dict[str, Any]:
    def count_nonblank(field: str) -> int:
        return sum(1 for row in rows if is_nonblank(row.get(field, "")))

    return {
        "rows": len(rows),
        "completedRows": sum(1 for row in rows if is_review_complete(row)),
        "pendingRows": sum(1 for row in rows if not is_review_complete(row)),
        "manualConfirmedCount": sum(1 for row in rows if str(row.get(FIELD_MANUAL, "")).strip().lower() == "human-confirmed"),
        "rejectedCount": sum(1 for row in rows if str(row.get(FIELD_MANUAL, "")).strip().lower() == "rejected"),
        "filled": {
            FIELD_MANUAL: count_nonblank(FIELD_MANUAL),
            FIELD_REAL: count_nonblank(FIELD_REAL),
            FIELD_ROLE: count_nonblank(FIELD_ROLE),
            FIELD_SCENE: count_nonblank(FIELD_SCENE),
            FIELD_REASON: count_nonblank(FIELD_REASON),
        },
    }


def resolve_summary_path(input_csv: Path, output_csv: Path, summary_json_arg: str) -> Path:
    if summary_json_arg:
        return Path(summary_json_arg).resolve()
    base = output_csv if output_csv != input_csv else input_csv
    return base.with_name(f"{base.stem}.review-summary.json")


def write_summary(path: Path, rows: list[dict[str, str]]) -> dict[str, Any]:
    summary = build_summary(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def suggested_reason(scene: str, has_real_face: str, role: str) -> str:
    scene = (scene or "").strip().lower()
    has_real_face = normalize_bool_text(has_real_face)
    role = (role or "").strip().lower()
    if has_real_face == "true" or role == "real_face_control":
        return "visible real human face is present in the frame"
    templates = {
        "landscape": "rock, branch, cloud, or terrain pattern resembles a face, but no real human face is visible",
        "product_object": "object contour, opening, or highlight arrangement resembles eyes and mouth, but no real human face is visible",
        "empty_scene": "scene structure or object arrangement resembles a face, but no real human face is visible",
        "event": "decoration, clothing fold, sign, or lighting arrangement resembles a face, but no real human face is visible",
        "food": "food plating or highlight pattern resembles a face, but no real human face is visible",
        "documentary_moment": "background object or lighting pattern resembles a face, but no real human face is visible",
        "other": "object or texture arrangement resembles a face, but no real human face is visible",
    }
    return templates.get(scene, templates["other"])


def run_gui(
    input_csv: Path,
    output_csv: Path,
    summary_path: Path,
    fieldnames: list[str],
    rows: list[dict[str, str]],
    start_index: int,
    readonly: bool,
    autosave: bool,
) -> int:
    try:
        import tkinter as tk
        from tkinter import filedialog, messagebox, ttk
        from PIL import Image, ImageOps, ImageTk
    except Exception as exc:
        print(f"GUI unavailable: {exc}", file=sys.stderr)
        return 3

    if not rows:
        print("No rows found.", file=sys.stderr)
        return 2

    root = tk.Tk()
    root.title(WINDOW_TITLE)
    root.geometry("1440x920")
    root.minsize(1280, 840)
    root.after(
        80,
        lambda: (
            root.deiconify(),
            root.lift(),
            root.focus_force(),
            root.attributes("-topmost", True),
            root.after(320, lambda: root.attributes("-topmost", False)),
        ),
    )

    index_var = tk.IntVar(value=max(0, min(start_index, len(rows) - 1)))
    manual_var = tk.StringVar(value="")
    real_var = tk.StringVar(value="")
    role_var = tk.StringVar(value="")
    scene_var = tk.StringVar(value="")
    status_var = tk.StringVar(value="")
    progress_var = tk.StringVar(value="")
    output_var = tk.StringVar(value=str(output_csv))
    dirty_var = tk.BooleanVar(value=False)

    photo_ref: dict[str, Any] = {"photo": None}

    frame = ttk.Frame(root, padding=12)
    frame.pack(fill="both", expand=True)

    header = ttk.Frame(frame)
    header.pack(fill="x")
    ttk.Label(header, text=WINDOW_TITLE, font=("", 18, "bold")).pack(side="left")
    header_right = ttk.Frame(header)
    header_right.pack(side="right")
    ttk.Label(header_right, textvariable=progress_var).pack(side="right")

    header_nav = ttk.Frame(header_right)
    header_nav.pack(side="right", padx=(0, 12))

    toolbar = ttk.Frame(frame)
    toolbar.pack(fill="x", pady=(10, 0))

    body = ttk.PanedWindow(frame, orient="horizontal")
    body.pack(fill="both", expand=True, pady=(12, 8))

    left = ttk.Frame(body, padding=(0, 0, 8, 0))
    right = ttk.Frame(body)
    body.add(left, weight=3)
    body.add(right, weight=2)

    image_wrap = ttk.Frame(left)
    image_wrap.pack(fill="both", expand=True)
    image_label = ttk.Label(image_wrap, anchor="center")
    image_label.pack(fill="both", expand=True)

    meta_text = tk.Text(left, height=13, wrap="word")
    meta_text.pack(fill="x", pady=(10, 0))
    meta_text.configure(state="disabled")

    form = ttk.Frame(right)
    form.pack(fill="both", expand=True)

    def add_labeled_value(parent: Any, label: str, textvariable: Any, readonly_entry: bool = False) -> None:
        row = ttk.Frame(parent)
        row.pack(fill="x", pady=4)
        ttk.Label(row, text=label, width=14).pack(side="left")
        entry = ttk.Entry(row, textvariable=textvariable)
        entry.pack(side="left", fill="x", expand=True)
        if readonly_entry:
            entry.configure(state="readonly")

    photo_id_var = tk.StringVar()
    path_var = tk.StringVar()
    source_dir_var = tk.StringVar()
    add_labeled_value(form, "photoId", photo_id_var, readonly_entry=True)
    add_labeled_value(form, "来源目录", source_dir_var, readonly_entry=True)
    add_labeled_value(form, "本地图片", path_var, readonly_entry=True)

    ttk.Separator(form, orient="horizontal").pack(fill="x", pady=10)

    def make_combo(parent: Any, label: str, variable: tk.StringVar, values: list[str]) -> ttk.Combobox:
        row = ttk.Frame(parent)
        row.pack(fill="x", pady=4)
        ttk.Label(row, text=label, width=14).pack(side="left")
        combo = ttk.Combobox(row, textvariable=variable, values=values, state="readonly")
        combo.pack(side="left", fill="x", expand=True)
        return combo

    make_combo(form, "人工标记", manual_var, MANUAL_VALUES)
    make_combo(form, "是否真人脸", real_var, REAL_VALUES)
    make_combo(form, "样本角色", role_var, ROLE_VALUES)
    scene_combo = make_combo(form, "场景", scene_var, SCENE_VALUES)

    ttk.Label(form, text="幻视原因").pack(anchor="w", pady=(12, 4))
    reason_text = tk.Text(form, height=8, wrap="word")
    reason_text.pack(fill="x", expand=False)

    ttk.Label(form, text="备注").pack(anchor="w", pady=(12, 4))
    notes_text = tk.Text(form, height=6, wrap="word")
    notes_text.pack(fill="both", expand=False)

    quick_frame = ttk.LabelFrame(form, text="快速标记")
    quick_frame.pack(fill="x", pady=(12, 0))

    bottom = ttk.Frame(frame)
    bottom.pack(fill="x", pady=(8, 0))
    ttk.Label(bottom, textvariable=status_var).pack(side="left")
    nav = ttk.Frame(bottom)
    nav.pack(side="right")

    def set_text(widget: Any, value: str) -> None:
        widget.delete("1.0", "end")
        widget.insert("1.0", value or "")
        widget.edit_modified(False)

    def get_text(widget: Any) -> str:
        return widget.get("1.0", "end").strip()

    def mark_dirty(*_args: Any) -> None:
        dirty_var.set(True)

    for variable in (manual_var, real_var, role_var, scene_var):
        variable.trace_add("write", mark_dirty)

    def bind_text_dirty(widget: Any) -> None:
        def _on_modified(_event: Any = None) -> None:
            if widget.edit_modified():
                dirty_var.set(True)
                widget.edit_modified(False)

        widget.bind("<<Modified>>", _on_modified)
        widget.edit_modified(False)

    bind_text_dirty(reason_text)
    bind_text_dirty(notes_text)

    def current_row() -> dict[str, str]:
        return rows[index_var.get()]

    def first_incomplete_index() -> int:
        for idx, row in enumerate(rows):
            if not is_review_complete(row):
                return idx
        return 0

    def update_meta_box(row: dict[str, str]) -> None:
        lines = [
            f"relativePath: {row.get('relativePath', '')}",
            f"fileName: {row.get('fileName', '')}",
            f"seedScene: {row.get('scene', '')}",
            f"seedNotes: {row.get('notes', '')}",
        ]
        meta_text.configure(state="normal")
        meta_text.delete("1.0", "end")
        meta_text.insert("1.0", "\n".join(lines))
        meta_text.configure(state="disabled")

    def load_image(row: dict[str, str]) -> None:
        path = Path(str(row.get("absolutePath") or ""))
        try:
            with Image.open(path) as opened:
                image = opened.convert("RGB")
        except Exception:
            image = Image.new("RGB", (900, 620), (42, 45, 51))
        image = ImageOps.contain(image, (900, 620), method=Image.Resampling.LANCZOS)
        photo = ImageTk.PhotoImage(image)
        image_label.configure(image=photo, text="")
        photo_ref["photo"] = photo

    def load_row(idx: int) -> None:
        idx = max(0, min(idx, len(rows) - 1))
        index_var.set(idx)
        row = rows[idx]
        photo_id_var.set(str(row.get("photoId", "")))
        source_dir_var.set(str(row.get("sourceDir", "")))
        path_var.set(str(row.get("absolutePath", "")))
        manual_var.set(str(row.get(FIELD_MANUAL, "") or ""))
        real_var.set(normalize_bool_text(row.get(FIELD_REAL, "")))
        role_var.set(str(row.get(FIELD_ROLE, "") or ""))
        scene_value = str(row.get(FIELD_SCENE, "") or "")
        if scene_value not in SCENE_VALUES:
            scene_combo.configure(state="normal")
            scene_combo["values"] = SCENE_VALUES + [scene_value]
            scene_combo.configure(state="readonly")
        scene_var.set(scene_value)
        set_text(reason_text, str(row.get(FIELD_REASON, "")))
        set_text(notes_text, str(row.get(FIELD_NOTES, "")))
        update_meta_box(row)
        load_image(row)
        summary = build_summary(rows)
        progress_var.set(
            f"{idx + 1}/{len(rows)}   已完成 {summary['completedRows']}/{summary['rows']}   已确认 {summary['manualConfirmedCount']}   已拒绝 {summary['rejectedCount']}"
        )
        status = "未完成"
        if is_review_complete(row):
            status = str(row.get(FIELD_MANUAL, "") or "已完成")
        status_var.set(f"当前行状态：{status}")
        dirty_var.set(False)

    def apply_form_to_row() -> None:
        row = current_row()
        row[FIELD_MANUAL] = manual_var.get().strip()
        row[FIELD_REAL] = real_var.get().strip()
        row[FIELD_ROLE] = role_var.get().strip()
        row[FIELD_SCENE] = scene_var.get().strip()
        row[FIELD_REASON] = get_text(reason_text)
        row[FIELD_NOTES] = get_text(notes_text)
        dirty_var.set(False)

    def persist(target: Path, silent: bool = False) -> None:
        write_csv(target, fieldnames, rows)
        summary = write_summary(summary_path, rows)
        output_var.set(str(target))
        if not silent:
            status_var.set(
                f"已保存到 {target}；已完成 {summary['completedRows']}/{summary['rows']}，已确认 {summary['manualConfirmedCount']}，已拒绝 {summary['rejectedCount']}"
            )

    def maybe_apply_before_nav() -> bool:
        if readonly:
            return True
        apply_form_to_row()
        if autosave:
            persist(Path(output_var.get()), silent=True)
        return True

    def fill_reason_if_empty() -> None:
        if not get_text(reason_text):
            set_text(reason_text, suggested_reason(scene_var.get(), real_var.get(), role_var.get()))
            dirty_var.set(True)

    def quick_false_face(advance: bool = False) -> None:
        manual_var.set("human-confirmed")
        real_var.set("false")
        role_var.set("false_face_positive")
        if not scene_var.get().strip():
            scene_var.set(str(current_row().get("scene", "") or "landscape"))
        fill_reason_if_empty()
        if advance:
            go(1)
        else:
            status_var.set("已标记为假脸正样本。")

    def quick_real_face(advance: bool = False) -> None:
        manual_var.set("human-confirmed")
        real_var.set("true")
        role_var.set("real_face_control")
        if not scene_var.get().strip():
            scene_var.set("event")
        fill_reason_if_empty()
        if advance:
            go(1)
        else:
            status_var.set("已标记为真人脸对照。")

    def quick_reject(advance: bool = False) -> None:
        manual_var.set("rejected")
        if advance:
            go(1)
        else:
            status_var.set("已标记为拒绝。")

    def fill_default_reason() -> None:
        fill_reason_if_empty()
        status_var.set("已填默认原因。")

    def go(delta: int) -> None:
        if not maybe_apply_before_nav():
            return
        load_row(index_var.get() + delta)

    def save_to(path: Path) -> None:
        if readonly:
            status_var.set("当前是只读模式，不能保存。")
            return
        apply_form_to_row()
        persist(path, silent=False)

    def save() -> None:
        save_to(Path(output_var.get()))

    def save_and_next() -> None:
        save()
        go(1)

    def save_as() -> None:
        target = filedialog.asksaveasfilename(
            title="另存为候选 CSV",
            defaultextension=".csv",
            initialfile=Path(output_var.get()).name,
            initialdir=str(Path(output_var.get()).parent),
            filetypes=[("CSV", "*.csv")],
        )
        if target:
            save_to(Path(target))

    def jump_to_next_unfilled() -> None:
        start = index_var.get() + 1
        for offset in range(len(rows)):
            idx = (start + offset) % len(rows)
            if not is_review_complete(rows[idx]):
                if maybe_apply_before_nav():
                    load_row(idx)
                return
        status_var.set("没有找到未完成条目。")

    def open_image_folder() -> None:
        row = current_row()
        path = Path(str(row.get("absolutePath") or ""))
        target = path if path.exists() else path.parent
        try:
            subprocess.Popen(["explorer", str(target)])
        except Exception as exc:
            from tkinter import messagebox

            messagebox.showerror("打开失败", str(exc))

    ttk.Button(toolbar, text="上一张", width=10, command=lambda: go(-1)).pack(side="left", padx=(0, 8))
    ttk.Button(toolbar, text="下一张", width=10, command=lambda: go(1)).pack(side="left", padx=(0, 8))
    ttk.Button(toolbar, text="保存并下一张", width=12, command=save_and_next).pack(side="left", padx=(0, 8))
    ttk.Button(toolbar, text="下一条未完成", width=12, command=jump_to_next_unfilled).pack(side="left", padx=(0, 8))
    ttk.Button(toolbar, text="打开图片位置", width=12, command=open_image_folder).pack(side="left", padx=(0, 8))
    ttk.Separator(toolbar, orient="vertical").pack(side="left", fill="y", padx=6)
    ttk.Label(toolbar, text=TOOLBAR_HINT).pack(side="left")

    nav_buttons = [
        ("上一张", lambda: go(-1)),
        ("下一张", lambda: go(1)),
        ("跳到下一条未完成", jump_to_next_unfilled),
        ("打开图片位置", open_image_folder),
        ("保存", save),
        ("另存为", save_as),
    ]
    for label, command in nav_buttons:
        ttk.Button(nav, text=label, command=command).pack(side="left", padx=4)

    header_nav_buttons = [
        ("上一张", lambda: go(-1)),
        ("下一张", lambda: go(1)),
        ("下一条未完成", jump_to_next_unfilled),
        ("保存", save),
    ]
    for label, command in header_nav_buttons:
        ttk.Button(header_nav, text=label, command=command).pack(side="left", padx=3)

    quick_buttons = [
        ("假脸正样本", lambda: quick_false_face(False)),
        ("真人脸对照", lambda: quick_real_face(False)),
        ("拒绝", lambda: quick_reject(False)),
        ("填默认原因", fill_default_reason),
    ]
    for idx, (label, command) in enumerate(quick_buttons):
        ttk.Button(quick_frame, text=label, command=command).grid(row=idx // 2, column=idx % 2, padx=4, pady=4, sticky="ew")
    quick_frame.columnconfigure(0, weight=1)
    quick_frame.columnconfigure(1, weight=1)

    if readonly:
        status_var.set("当前为只读模式。")

    def handle_prev(_event: Any = None) -> str:
        go(-1)
        return "break"

    def handle_next(_event: Any = None) -> str:
        go(1)
        return "break"

    def handle_save(_event: Any = None) -> str:
        save()
        return "break"

    def handle_save_and_next(_event: Any = None) -> str:
        save_and_next()
        return "break"

    def handle_next_unfilled(_event: Any = None) -> str:
        jump_to_next_unfilled()
        return "break"

    def handle_quick_false(_event: Any = None) -> str:
        quick_false_face(True)
        return "break"

    def handle_quick_real(_event: Any = None) -> str:
        quick_real_face(True)
        return "break"

    def handle_quick_reject(_event: Any = None) -> str:
        quick_reject(True)
        return "break"

    def on_close() -> None:
        from tkinter import messagebox

        if not readonly and dirty_var.get():
            if autosave:
                save()
            elif messagebox.askyesno("保存修改", "当前条目有未保存修改，关闭前先保存吗？"):
                save()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    root.bind("<Left>", handle_prev)
    root.bind("<Right>", handle_next)
    root.bind("<Control-s>", handle_save)
    root.bind("<Control-S>", handle_save)
    root.bind("<Control-Return>", handle_save_and_next)
    root.bind("<Control-KP_Enter>", handle_save_and_next)
    root.bind("<Control-Shift-N>", handle_next_unfilled)
    root.bind("<Control-Shift-n>", handle_next_unfilled)
    root.bind("<Control-1>", handle_quick_false)
    root.bind("<Control-2>", handle_quick_real)
    root.bind("<Control-3>", handle_quick_reject)

    initial_index = index_var.get()
    if initial_index == 0:
        initial_index = first_incomplete_index()
    load_row(initial_index)
    root.mainloop()
    return 0


def main() -> int:
    args = parse_args()
    input_csv = Path(args.input_csv).resolve()
    if not input_csv.exists():
        print(f"Input CSV not found: {input_csv}", file=sys.stderr)
        return 2

    fieldnames, rows = read_csv(input_csv)
    output_csv = Path(args.output_csv).resolve() if args.output_csv else input_csv
    summary_path = resolve_summary_path(input_csv, output_csv, args.summary_json)
    summary = write_summary(summary_path, rows)
    if args.readonly:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    return run_gui(
        input_csv,
        output_csv,
        summary_path,
        fieldnames,
        rows,
        args.start_index,
        args.readonly,
        autosave=not args.no_autosave,
    )


if __name__ == "__main__":
    raise SystemExit(main())
