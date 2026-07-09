#!/usr/bin/env python3
"""Pre-seed the ort-sys prebuilt-binary cache from a hash-verified tarball.

ort-sys downloads ONNX Runtime prebuilt binaries during the build, but the CDN
truncates the large CUDA tarball mid-stream on this host. A manual download of
the exact same URL succeeds and matches the dist hash, so we decode it here
(raw LZMA2 -> tar) into the cache dir the build checks. When the extract dir
already exists, ort-sys skips the download entirely.

Cache layout (Windows): %LOCALAPPDATA%/ort.pyke.io/dfbin/<target>/<hash>/
"""
import argparse
import hashlib
import io
import lzma
import os
import tarfile
from pathlib import Path

DICT_SIZE = 1 << 26


def decode_lzma2(raw: bytes) -> bytes:
    dec = lzma.LZMADecompressor(
        format=lzma.FORMAT_RAW,
        filters=[{"id": lzma.FILTER_LZMA2, "dict_size": DICT_SIZE}],
    )
    return dec.decompress(raw)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tarball", required=True)
    parser.add_argument("--hash", required=True)
    parser.add_argument("--target", default="x86_64-pc-windows-msvc")
    args = parser.parse_args()

    tarball = Path(args.tarball)
    raw = tarball.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != args.hash:
        raise SystemExit(f"hash mismatch: got {digest}, expected {args.hash}")

    cache_root = os.environ.get("ORT_CACHE_DIR")
    if cache_root:
        cache_root = Path(cache_root)
    else:
        cache_root = Path(os.environ["LOCALAPPDATA"]) / "ort.pyke.io"
    extract_dir = cache_root / "dfbin" / args.target / args.hash
    if extract_dir.exists():
        print(f"cache already present: {extract_dir}")
        return

    print("decoding lzma2 ...")
    tar_bytes = decode_lzma2(raw)
    print(f"decoded tar size: {len(tar_bytes)} bytes")

    tmp_dir = extract_dir.parent / f"tmp.seed.{args.hash}"
    if tmp_dir.exists():
        import shutil

        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as tar:
        members = tar.getnames()
        tar.extractall(tmp_dir)
    print(f"extracted {len(members)} entries")

    tmp_dir.rename(extract_dir)
    print(f"seeded: {extract_dir}")
    for entry in sorted(extract_dir.rglob("*"))[:40]:
        print("  ", entry.relative_to(extract_dir))


if __name__ == "__main__":
    main()
