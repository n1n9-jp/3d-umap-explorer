#!/usr/bin/env python3
"""MNIST 1万点の3次元UMAP座標を事前計算し、public/data/mnist/ へ配信用データを書き出す。

入力の取得（SHA-256 で照合）、UMAP計算、正規化、空間の構造（クラスタ・密度・全体範囲）の追加、
書き出し、簡単な検証までを1コマンドで行う。
    python scripts/precompute/mnist_umap.py
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from importlib.metadata import version
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

import add_structure

REPO_URL = "https://github.com/tensorflow/embedding-projector-standalone"
COMMIT = "6ff71f7233ac5947450409e7938b58ec14d1e24c"
# 入力ファイル: キー -> (ファイル名, SHA-256)。取得直後と .cache/ の再利用時に照合する
SRC_FILES = {
    "tensors": ("mnist_10k_784d_tensors.bytes", "f35429bfdd77d51c5dea063ef595c6fa242921aa69ee648056c8f26e2c2d370a"),
    "labels": ("mnist_10k_784d_labels.tsv", "b00c1c90c51a6005aa65dbdac2843589c7580a99541ad50ec435a545b6c25947"),
    "sprite": ("mnist_10k_sprite.png", "9221b2e9866f9590d5c90a092aea5a1904e83e0e02d8125098bbe51d1cbe055d"),
}

COUNT = 10_000
DIM = 784
CELL = 28

UMAP_PARAMS = dict(
    n_components=3,
    n_neighbors=15,
    min_dist=0.1,
    metric="euclidean",
    random_state=42,
    n_jobs=1,  # 単一スレッドで実行する（並列実行では結果が変わりうる）
    # umap-learn 0.6 の既定値は将来変わる。0.5系と同じ処理（旧パイプライン）に固定して再現性を保つ
    compatibility_layout=True,
)

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(__file__).resolve().parent / ".cache"
OUT = ROOT / "public" / "data" / "mnist"


def run(cmd: list[str], cwd: Path) -> None:
    subprocess.run(cmd, cwd=cwd, check=True)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def is_valid(path: Path, expected: str) -> bool:
    return path.is_file() and sha256(path) == expected


def fetch_inputs() -> dict[str, Path]:
    """oss_data/ の3ファイルだけを、固定コミットから .cache/ へ取得する。

    取得済みのファイルも SHA-256 で照合し、一致しないものは取得し直す。
    """
    paths = {key: CACHE / name for key, (name, _) in SRC_FILES.items()}
    stale = []
    for key, (_, digest) in SRC_FILES.items():
        if is_valid(paths[key], digest):
            continue
        if paths[key].exists():
            print(f"{paths[key]} の SHA-256 が一致しません。取得し直します")
        stale.append(key)
    if not stale:
        return paths

    CACHE.mkdir(parents=True, exist_ok=True)
    work = CACHE / "_clone"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir()
    run(["git", "init", "-q"], work)
    run(["git", "remote", "add", "origin", REPO_URL + ".git"], work)
    run(["git", "sparse-checkout", "init", "--no-cone"], work)
    run(["git", "sparse-checkout", "set", *[f"/oss_data/{SRC_FILES[k][0]}" for k in stale]], work)
    run(["git", "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", COMMIT], work)
    run(["git", "checkout", "-q", "FETCH_HEAD"], work)
    for key in stale:
        name, digest = SRC_FILES[key]
        src = work / "oss_data" / name
        if not is_valid(src, digest):
            raise SystemExit(f"取得した {name} の SHA-256 が想定と一致しません")
        # 一時ファイルへ書いてから名前を変える（途中で切れたファイルを .cache/ に残さない）
        tmp = paths[key].with_name(paths[key].name + ".tmp")
        shutil.copyfile(src, tmp)
        os.replace(tmp, paths[key])
    shutil.rmtree(work)
    return paths


def load_inputs(paths: dict[str, Path]):
    x = np.fromfile(paths["tensors"], dtype="<f4").reshape(COUNT, DIM)

    raw = np.array([int(s) for s in paths["labels"].read_text().split()], dtype=np.int64)
    if raw.shape != (COUNT,) or raw.min() < 0 or raw.max() > 9:
        raise SystemExit("labels.tsv の内容が想定と異なります")
    return x, raw.astype(np.uint8)


def normalize(y: np.ndarray) -> np.ndarray:
    """バウンディングボックスの中心を原点に移し、等方スケールで絶対値の最大を1にする。"""
    y = y.astype(np.float64)
    center = (y.min(axis=0) + y.max(axis=0)) / 2
    y = y - center
    y = y / np.abs(y).max()
    return y.astype("<f4")


def build_manifest(sprite_src: Path, umap_version: str) -> dict:
    """スプライトを検証し、初期状態の manifest を返す。"""
    with Image.open(sprite_src) as im:
        width, height = im.size
    if width % CELL or height % CELL:
        raise SystemExit(f"sprite.png のサイズ {width}x{height} がセル {CELL}px の倍数ではありません")
    columns, rows = width // CELL, height // CELL
    if columns * rows < COUNT:
        raise SystemExit("sprite.png のセル数が点の数に足りません")

    return {
        "name": "MNIST 10k",
        "count": COUNT,
        "positions": {"file": "positions.f32", "dtype": "float32", "components": 3},
        "labels": {"file": "labels.u8", "dtype": "uint8", "names": [str(i) for i in range(10)]},
        "sprite": {"file": "sprite.png", "cellSize": [CELL, CELL], "columns": columns, "rows": rows},
        "umap": {
            "library": f"umap-learn {umap_version}",
            "nComponents": UMAP_PARAMS["n_components"],
            "nNeighbors": UMAP_PARAMS["n_neighbors"],
            "minDist": UMAP_PARAMS["min_dist"],
            "metric": UMAP_PARAMS["metric"],
            "randomState": UMAP_PARAMS["random_state"],
            "compatibilityLayout": UMAP_PARAMS["compatibility_layout"],
        },
        "source": {"url": REPO_URL, "commit": COMMIT},
    }


def write_outputs(pos: np.ndarray, labels: np.ndarray, sprite_src: Path, umap_version: str) -> None:
    """配信用データ一式を作り、すべての検証を終えてから OUT へまとめて置く。

    作業用ディレクトリ（OUT と同じファイルシステム）に一式を作って検証し、
    最後にファイルごとに名前を変えて OUT へ移す。途中で失敗しても OUT は実行前のまま残る。
    """
    manifest = build_manifest(sprite_src, umap_version)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{OUT.name}-staging-", dir=OUT.parent))
    try:
        pos.tofile(stage / "positions.f32")
        labels.tofile(stage / "labels.u8")
        shutil.copyfile(sprite_src, stage / "sprite.png")
        (stage / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        # クラスタ・密度・全体範囲を計算し、manifest へ追記する（検証に失敗すると異常終了する）
        add_structure.add_structure(stage)

        OUT.mkdir(parents=True, exist_ok=True)
        names = sorted(p.name for p in stage.iterdir())
        # manifest.json は最後に置く（他のファイルが揃ってから、それを指す manifest に切り替わる）
        for name in [n for n in names if n != "manifest.json"] + ["manifest.json"]:
            os.replace(stage / name, OUT / name)
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def report(pos: np.ndarray, labels: np.ndarray) -> None:
    p = pos.astype(np.float64)
    print("--- 検証 ---")
    print("positions.f32 bytes:", (OUT / "positions.f32").stat().st_size)
    print("all finite:", bool(np.isfinite(p).all()))
    print("max |value|:", float(np.abs(pos).max()))
    print("bbox center:", ((p.min(axis=0) + p.max(axis=0)) / 2).tolist())
    print("labels.u8 bytes:", (OUT / "labels.u8").stat().st_size)
    print("label counts:", {int(k): int(v) for k, v in zip(*np.unique(labels, return_counts=True))})

    tree = cKDTree(p)
    dist, idx = tree.query(p, k=11)
    same = (labels[idx[:, 1:]] == labels[:, None]).mean()
    print(f"10-NN same-label ratio (3D, mean over all points): {same:.4f}")
    nn = dist[:, 1]
    q = np.percentile(nn, [10, 50, 90])
    print(f"nearest-neighbor distance (normalized): p10={q[0]:.6f} median={q[1]:.6f} p90={q[2]:.6f}")
    print(f"  (min={nn.min():.6g} max={nn.max():.6g}; zero-distance points: {int((nn == 0).sum())})")


def main() -> None:
    paths = fetch_inputs()
    x, labels = load_inputs(paths)

    import umap  # 取得・読み込みの確認後に import する（numba のコンパイルが重いため）

    umap_version = version("umap-learn")
    print(f"umap-learn {umap_version}, numpy {np.__version__}, params={UMAP_PARAMS}")
    t0 = time.perf_counter()
    y = umap.UMAP(**UMAP_PARAMS).fit_transform(x)
    elapsed = time.perf_counter() - t0
    print(f"UMAP computation time: {elapsed:.1f} s")

    pos = normalize(np.asarray(y)).reshape(-1)
    write_outputs(pos, labels, paths["sprite"], umap_version)
    report(pos.reshape(COUNT, 3), labels)
    print("written to", OUT)


if __name__ == "__main__":
    sys.exit(main())
