#!/usr/bin/env python3
"""データセットを指定して、3次元UMAP座標を事前計算し、public/data/<dataset>/ へ配信用データを書き出す。

入力の取得（SHA-256 で照合）、UMAP計算、正規化、空間の構造（クラスタ・密度・全体範囲）の追加、
書き出し、簡単な検証までを1コマンドで行う。データセットごとの違いは datasets.py の設定にある。
    python scripts/precompute/build_dataset.py mnist
    python scripts/precompute/build_dataset.py word2vec-10k
"""

from __future__ import annotations

import argparse
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
from datasets import COMMIT, DATASETS, OUT_ROOT, REPO_URL, UMAP_PARAMS, DatasetConfig, SourceFile

CACHE = Path(__file__).resolve().parent / ".cache"


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


def source_files(cfg: DatasetConfig) -> dict[str, SourceFile]:
    """設定にある入力ファイル（キー → SourceFile）。"""
    files = {"tensors": cfg.tensors}
    for key in ("labels", "sprite", "text"):
        src = getattr(cfg, key)
        if src is not None:
            files[key] = src
    return files


def fetch_inputs(cfg: DatasetConfig) -> dict[str, Path]:
    """oss_data/ にある入力ファイルだけを、固定コミットから .cache/ へ取得する。

    取得済みのファイルも SHA-256 で照合し、一致しないものは取得し直す。
    """
    sources = source_files(cfg)
    paths = {key: CACHE / src.name for key, src in sources.items()}
    stale = []
    for key, src in sources.items():
        if is_valid(paths[key], src.sha256):
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
    run(["git", "sparse-checkout", "set", *[f"/oss_data/{sources[k].name}" for k in stale]], work)
    run(["git", "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", COMMIT], work)
    run(["git", "checkout", "-q", "FETCH_HEAD"], work)
    for key in stale:
        src = work / "oss_data" / sources[key].name
        if not is_valid(src, sources[key].sha256):
            raise SystemExit(f"取得した {sources[key].name} の SHA-256 が想定と一致しません")
        # 一時ファイルへ書いてから名前を変える（途中で切れたファイルを .cache/ に残さない）
        tmp = paths[key].with_name(paths[key].name + ".tmp")
        shutil.copyfile(src, tmp)
        os.replace(tmp, paths[key])
    shutil.rmtree(work)
    return paths


def load_inputs(cfg: DatasetConfig, paths: dict[str, Path]):
    """ベクトル、ラベル（なければ None）、単語（なければ None）を読む。"""
    if paths["tensors"].stat().st_size != cfg.count * cfg.dim * 4:
        raise SystemExit(f"{paths['tensors'].name} のサイズが count * dim * 4 バイトと一致しません")
    x = np.fromfile(paths["tensors"], dtype="<f4").reshape(cfg.count, cfg.dim)
    if not np.isfinite(x).all():
        raise SystemExit(f"{paths['tensors'].name} に有限でない値があります")
    labels = cfg.parse_labels(paths["labels"], cfg.count) if cfg.labels else None
    words = cfg.parse_text(paths["text"], cfg.count) if cfg.text else None
    return x, labels, words


def normalize(y: np.ndarray) -> np.ndarray:
    """バウンディングボックスの中心を原点に移し、等方スケールで絶対値の最大を1にする。"""
    y = y.astype(np.float64)
    center = (y.min(axis=0) + y.max(axis=0)) / 2
    y = y - center
    y = y / np.abs(y).max()
    return y.astype("<f4")


def build_manifest(cfg: DatasetConfig, sprite_src: Path | None, umap_version: str) -> dict:
    """スプライト（あれば）を検証し、初期状態の manifest を返す。"""
    manifest: dict = {
        "name": cfg.name,
        "kind": cfg.kind,
        "count": cfg.count,
        "positions": {"file": "positions.f32", "dtype": "float32", "components": 3},
    }
    if cfg.labels:
        manifest["labels"] = {"file": "labels.u8", "dtype": "uint8", "names": list(cfg.label_names)}
    if cfg.sprite:
        cell = cfg.sprite_cell
        with Image.open(sprite_src) as im:
            width, height = im.size
        if width % cell or height % cell:
            raise SystemExit(f"sprite.png のサイズ {width}x{height} がセル {cell}px の倍数ではありません")
        columns, rows = width // cell, height // cell
        if columns * rows < cfg.count:
            raise SystemExit("sprite.png のセル数が点の数に足りません")
        manifest["sprite"] = {"file": "sprite.png", "cellSize": [cell, cell], "columns": columns, "rows": rows}
    if cfg.text:
        manifest["text"] = {"file": "text.json"}
    manifest["umap"] = {
        "library": f"umap-learn {umap_version}",
        "nComponents": UMAP_PARAMS["n_components"],
        "nNeighbors": UMAP_PARAMS["n_neighbors"],
        "minDist": UMAP_PARAMS["min_dist"],
        "metric": cfg.metric,
        "randomState": UMAP_PARAMS["random_state"],
        "compatibilityLayout": UMAP_PARAMS["compatibility_layout"],
    }
    manifest["source"] = {"url": REPO_URL, "commit": COMMIT}
    return manifest


def write_outputs(
    cfg: DatasetConfig,
    out: Path,
    pos: np.ndarray,
    labels: np.ndarray | None,
    words: list[str] | None,
    paths: dict[str, Path],
    umap_version: str,
) -> list[str]:
    """配信用データ一式を作り、すべての検証を終えてから out へまとめて置く。警告（あれば）の一覧を返す。

    作業用ディレクトリ（out と同じファイルシステム）に一式を作って検証し、
    最後にファイルごとに名前を変えて out へ移す。途中で失敗しても out は実行前のまま残る。
    """
    manifest = build_manifest(cfg, paths.get("sprite"), umap_version)

    out.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{out.name}-staging-", dir=out.parent))
    try:
        pos.tofile(stage / "positions.f32")
        if labels is not None:
            labels.tofile(stage / "labels.u8")
        if cfg.sprite:
            shutil.copyfile(paths["sprite"], stage / "sprite.png")
        if words is not None:
            (stage / "text.json").write_text(json.dumps(words, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        (stage / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        # クラスタ・密度・全体範囲を計算し、manifest へ追記する（検証に失敗すると異常終了する）
        warnings = add_structure.add_structure(stage, cfg.cluster_overrides)

        out.mkdir(parents=True, exist_ok=True)
        names = sorted(p.name for p in stage.iterdir())
        # manifest.json は最後に置く（他のファイルが揃ってから、それを指す manifest に切り替わる）
        for name in [n for n in names if n != "manifest.json"] + ["manifest.json"]:
            os.replace(stage / name, out / name)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    return warnings


def neighbor_indices(x: np.ndarray, metric: str, k: int) -> np.ndarray:
    """各点の近傍 k 点（自分自身を除く）の番号。距離の小さい順。ブルートフォース。"""
    from sklearn.neighbors import NearestNeighbors

    _, idx = NearestNeighbors(n_neighbors=k + 1, algorithm="brute", metric=metric).fit(x).kneighbors(x)
    out = np.empty((len(x), k), dtype=idx.dtype)
    for i in range(len(x)):  # 自分自身を除く（距離 0 の重複点があっても自分自身だけを除く）
        row = idx[i][idx[i] != i][:k]
        out[i] = row
    return out


def report(cfg: DatasetConfig, out: Path, x: np.ndarray, pos: np.ndarray, labels: np.ndarray | None, words: list[str] | None) -> None:
    p = pos.astype(np.float64)
    print("--- 検証 ---")
    print("positions.f32 bytes:", (out / "positions.f32").stat().st_size)
    print("all finite:", bool(np.isfinite(p).all()))
    print("max |value|:", float(np.abs(pos).max()))
    print("bbox center:", ((p.min(axis=0) + p.max(axis=0)) / 2).tolist())
    if labels is not None:
        print("labels.u8 bytes:", (out / "labels.u8").stat().st_size)
        print("label counts:", {int(k): int(v) for k, v in zip(*np.unique(labels, return_counts=True))})
    if words is not None:
        saved = json.loads((out / "text.json").read_text(encoding="utf-8"))
        print(f"text.json: {len(saved)} 語, 入力の単語と順序が一致: {saved == words}")

    tree = cKDTree(p)
    dist, idx = tree.query(p, k=11)
    if labels is not None:
        same = (labels[idx[:, 1:]] == labels[:, None]).mean()
        print(f"10-NN same-label ratio (3D, mean over all points): {same:.4f}")
    nn = dist[:, 1]
    q = np.percentile(nn, [10, 50, 90])
    print(f"nearest-neighbor distance (normalized): p10={q[0]:.6f} median={q[1]:.6f} p90={q[2]:.6f}")
    print(f"  (min={nn.min():.6g} max={nn.max():.6g}; zero-distance points: {int((nn == 0).sum())})")

    # 元の空間（metric は UMAP と同じ）での10近傍と、3次元での10近傍の重なり
    orig = neighbor_indices(x, cfg.metric, 10)
    low = idx[:, 1:]
    overlap = np.mean([len(set(a) & set(b)) / 10 for a, b in zip(orig, low)])
    print(f"10-NN overlap ({cfg.dim}D {cfg.metric} vs 3D, mean over all points): {overlap:.4f}")

    if words is not None:
        index = {w: i for i, w in enumerate(words)}
        print("--- 3次元での近傍10語 ---")
        for w in cfg.probe_words:
            if w in index:
                print(f"{w}: {', '.join(words[j] for j in idx[index[w], 1:])}")


def build(key: str) -> None:
    cfg = DATASETS[key]
    out = OUT_ROOT / cfg.out_dir
    paths = fetch_inputs(cfg)
    x, labels, words = load_inputs(cfg, paths)

    import umap  # 取得・読み込みの確認後に import する（numba のコンパイルが重いため）

    umap_version = version("umap-learn")
    params = {**UMAP_PARAMS, "metric": cfg.metric}
    print(f"{cfg.key}: umap-learn {umap_version}, numpy {np.__version__}, params={params}")
    t0 = time.perf_counter()
    y = umap.UMAP(**params).fit_transform(x)
    print(f"UMAP computation time: {time.perf_counter() - t0:.1f} s")

    pos = normalize(np.asarray(y)).reshape(-1)
    warnings = write_outputs(cfg, out, pos, labels, words, paths, umap_version)
    report(cfg, out, x, pos.reshape(cfg.count, 3), labels, words)
    print(f"clustering warnings: {len(warnings)}")
    print("written to", out)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", choices=sorted(DATASETS), help="作るデータセット")
    args = ap.parse_args(argv)
    build(args.dataset)


if __name__ == "__main__":
    sys.exit(main())
