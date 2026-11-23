#!/usr/bin/env python3
"""MNIST 1万点の3次元UMAP座標を事前計算し、public/data/mnist/ へ配信用データを書き出す。

入力の取得、UMAP計算、正規化、書き出し、簡単な検証までを1コマンドで行う。
    python scripts/precompute/mnist_umap.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from importlib.metadata import version
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

REPO_URL = "https://github.com/tensorflow/embedding-projector-standalone"
COMMIT = "6ff71f7233ac5947450409e7938b58ec14d1e24c"
SRC_FILES = {
    "tensors": ("mnist_10k_784d_tensors.bytes", 31_360_000),
    "labels": ("mnist_10k_784d_labels.tsv", 20_000),
    "sprite": ("mnist_10k_sprite.png", None),
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
    # umap-learn 0.6 の既定値は将来変わる。0.5系と同じ処理（旧パイプライン）に固定して再現性を保つ
    compatibility_layout=True,
)

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(__file__).resolve().parent / ".cache"
OUT = ROOT / "public" / "data" / "mnist"


def run(cmd: list[str], cwd: Path) -> None:
    subprocess.run(cmd, cwd=cwd, check=True)


def fetch_inputs() -> dict[str, Path]:
    """oss_data/ の3ファイルだけを、固定コミットから .cache/ へ取得する。"""
    paths = {key: CACHE / name for key, (name, _) in SRC_FILES.items()}
    if all(p.exists() for p in paths.values()):
        return paths

    CACHE.mkdir(parents=True, exist_ok=True)
    work = CACHE / "_clone"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir()
    run(["git", "init", "-q"], work)
    run(["git", "remote", "add", "origin", REPO_URL + ".git"], work)
    run(["git", "sparse-checkout", "init", "--no-cone"], work)
    run(["git", "sparse-checkout", "set", *[f"/oss_data/{n}" for n, _ in SRC_FILES.values()]], work)
    run(["git", "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", COMMIT], work)
    run(["git", "checkout", "-q", "FETCH_HEAD"], work)
    for key, (name, _) in SRC_FILES.items():
        shutil.copyfile(work / "oss_data" / name, paths[key])
    shutil.rmtree(work)
    return paths


def load_inputs(paths: dict[str, Path]):
    tensors_size = SRC_FILES["tensors"][1]
    if paths["tensors"].stat().st_size != tensors_size:
        raise SystemExit(f"{paths['tensors']} のサイズが {tensors_size} バイトではありません")
    x = np.fromfile(paths["tensors"], dtype="<f4").reshape(COUNT, DIM)

    lines = paths["labels"].read_text().split()
    labels = np.array([int(s) for s in lines], dtype=np.uint8)
    if labels.shape != (COUNT,) or labels.min() < 0 or labels.max() > 9:
        raise SystemExit("labels.tsv の内容が想定と異なります")
    return x, labels


def normalize(y: np.ndarray) -> np.ndarray:
    """バウンディングボックスの中心を原点に移し、等方スケールで絶対値の最大を1にする。"""
    y = y.astype(np.float64)
    center = (y.min(axis=0) + y.max(axis=0)) / 2
    y = y - center
    y = y / np.abs(y).max()
    return y.astype("<f4")


def write_outputs(pos: np.ndarray, labels: np.ndarray, sprite_src: Path, umap_version: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    pos.tofile(OUT / "positions.f32")
    labels.tofile(OUT / "labels.u8")
    shutil.copyfile(sprite_src, OUT / "sprite.png")

    with Image.open(sprite_src) as im:
        width, height = im.size
    if width % CELL or height % CELL:
        raise SystemExit(f"sprite.png のサイズ {width}x{height} がセル {CELL}px の倍数ではありません")
    columns, rows = width // CELL, height // CELL
    if columns * rows < COUNT:
        raise SystemExit("sprite.png のセル数が点の数に足りません")

    manifest = {
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
        },
        "source": {"url": REPO_URL, "commit": COMMIT},
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


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
