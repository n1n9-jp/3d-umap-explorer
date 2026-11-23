#!/usr/bin/env python3
"""配信する厳密な kNN グラフと、umap-learn が UMAP の計算の中で使う近傍（近似）の関係を調べる。

    python scripts/precompute/compare_umap_knn.py mnist
    python scripts/precompute/compare_umap_knn.py word2vec-10k

1. 事前計算と同じ設定で UMAP を計算し、umap-learn が内部で使った近傍（`_knn_indices`・`_knn_dists`）を取り出して、
   厳密な kNN グラフの先頭の列と比べる（一致の割合）。あわせて、座標が配信中の positions.f32 とバイト単位で一致するかを確かめる。
2. 厳密な kNN グラフを `precomputed_knn` で渡して UMAP を計算し、座標が配信中の positions.f32 と一致するかを確かめる。
   一致しなければ、3次元での近傍の重なり、ラベルの一致率（ラベルがあるとき）などで違いの程度を測る。
   比較の目安として、近傍探索は同じで乱数のシードだけを変えた UMAP（random_state=43）との差も出す。

public/data/ は書き換えない。結果は標準出力へ出す。
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import numpy as np
from scipy.spatial import procrustes

import knn as knn_mod
from build_dataset import compute_quality, fetch_inputs, load_inputs, low_dim_neighbors, normalize
from datasets import DATASETS, OUT_ROOT, UMAP_PARAMS


def fit(x: np.ndarray, params: dict, **extra):
    import umap

    t0 = time.perf_counter()
    reducer = umap.UMAP(**params, **extra).fit(x)
    return reducer, normalize(np.asarray(reducer.embedding_)).reshape(-1, 3), time.perf_counter() - t0


def same_label_ratio(pos: np.ndarray, labels: np.ndarray, k: int = 10) -> float:
    return float((labels[low_dim_neighbors(pos, k)] == labels[:, None]).mean())


def describe(name: str, pos: np.ndarray, ref: np.ndarray, labels: np.ndarray | None, exact: np.ndarray) -> None:
    """座標 pos を、基準の座標 ref と比べる。"""
    same_bytes = pos.astype("<f4").tobytes() == ref.astype("<f4").tobytes()
    print(f"[{name}] 座標が配信中の positions.f32 とバイト単位で一致: {same_bytes}")
    if same_bytes:
        return
    print(f"  座標の最大絶対差: {float(np.abs(pos.astype(np.float64) - ref).max()):.4f}")
    print(f"  Procrustes の不一致度（0 で完全一致。回転・拡大・反転を許す）: {procrustes(ref.astype(np.float64), pos.astype(np.float64))[2]:.4f}")
    for k in (10, 50):
        ov = knn_mod.neighbor_overlap(low_dim_neighbors(ref, k), low_dim_neighbors(pos, k), k)
        print(f"  3次元の {k} 近傍の、配信中の座標との重なり（全点平均）: {ov:.4f}")
    if labels is not None:
        print(f"  3次元の 10 近傍のラベル一致率: {same_label_ratio(pos, labels):.4f}（配信中の座標: {same_label_ratio(ref, labels):.4f}）")
    q = {d["k"]: d["mean"] for d in compute_quality(exact, pos)["neighborOverlap"]}
    q0 = {d["k"]: d["mean"] for d in compute_quality(exact, ref)["neighborOverlap"]}
    print(f"  元の空間の近傍との重なり quality: k=10 {q[10]:.4f}, k=50 {q[50]:.4f}（配信中の座標: k=10 {q0[10]:.4f}, k=50 {q0[50]:.4f}）")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", choices=sorted(DATASETS))
    args = ap.parse_args(argv)

    cfg = DATASETS[args.dataset]
    ds = OUT_ROOT / cfg.out_dir
    manifest = json.loads((ds / "manifest.json").read_text())
    idx, dst = knn_mod.read_knn(ds, manifest)
    published = np.fromfile(ds / "positions.f32", dtype="<f4").reshape(-1, 3)
    x, labels, _ = load_inputs(cfg, fetch_inputs(cfg))
    n, nn = cfg.count, UMAP_PARAMS["n_neighbors"]
    params = {**UMAP_PARAMS, "metric": cfg.metric}
    print(f"{cfg.key}: n_neighbors={nn}, metric={cfg.metric}")

    # 1. umap-learn が内部で使った近傍
    reducer, pos_a, t_a = fit(x, params)
    print(f"UMAP（内部の近傍探索）: {t_a:.1f} s")
    describe("事前計算と同じ設定の再計算", pos_a, published, labels, idx)
    ui, ud = np.asarray(reducer._knn_indices), np.asarray(reducer._knn_dists)
    has_self = ui[:, 0] == np.arange(n)
    print(f"umap の近傍の形状: {ui.shape}、先頭の列が自分自身の行: {int(has_self.sum())}/{n}")
    others = np.array([[j for j in row if j != i][: nn - 1] for i, row in enumerate(ui)])  # 自分自身を除く 14 列
    ov14 = np.array([len(set(a) & set(b)) / (nn - 1) for a, b in zip(others, idx[:, : nn - 1])])
    print(f"厳密な kNN の先頭 {nn - 1} 列（自分自身を除く）と、umap が使った近傍（自分自身を除く {nn - 1} 点）の一致の割合: 平均 {ov14.mean():.6f}、全点一致の行 {int((ov14 == 1).sum())}/{n}、最小 {ov14.min():.4f}")
    exact_with_self = np.concatenate([np.arange(n)[:, None], idx[:, : nn - 1]], axis=1)
    ov15 = np.array([len(set(a) & set(b)) / nn for a, b in zip(ui, exact_with_self)])
    print(f"自分自身を含む先頭 {nn} 列どうし（厳密な kNN は自分自身を先頭に足した {nn} 点）: 平均 {ov15.mean():.6f}、全点一致の行 {int((ov15 == 1).sum())}/{n}")
    ov_nn_first = np.array([len(set(a) & set(b)) / nn for a, b in zip(ui, idx[:, :nn])])
    print(f"（参考）自分自身を足さず、厳密な kNN の先頭 {nn} 列そのものと umap の {nn} 列: 平均 {ov_nn_first.mean():.6f}")
    # 距離: 同じ番号どうしの距離の差
    diffs = []
    for i in range(n):
        ref = dict(zip(idx[i].tolist(), dst[i].tolist()))
        diffs += [abs(float(d) - ref[j]) for j, d in zip(ui[i], ud[i]) if j in ref]
    print(f"同じ点の距離の差（umap の float32 と厳密な値）: 最大 {max(diffs):.3g}、平均 {np.mean(diffs):.3g}")

    # 2. 厳密な kNN グラフを umap へ渡す。umap の近傍は自分自身（距離 0）を先頭の列に持つので、自分自身を先頭に足した
    #    n_neighbors 列（自分自身 + 厳密な近傍 n_neighbors - 1 点）を、C 連続の配列で渡す
    pk_idx = np.ascontiguousarray(np.concatenate([np.arange(n)[:, None], idx[:, : nn - 1]], axis=1), dtype=np.int32)
    pk_dst = np.ascontiguousarray(np.concatenate([np.zeros((n, 1), dtype=np.float32), dst[:, : nn - 1]], axis=1))
    _, pos_b, t_b = fit(x, params, precomputed_knn=(pk_idx, pk_dst))
    print(f"UMAP（precomputed_knn、最適化だけ）: {t_b:.1f} s")
    describe("厳密な kNN を precomputed_knn で渡した UMAP", pos_b, published, labels, idx)

    # 目安: 近傍探索は同じで、乱数のシードだけを変える
    _, pos_c, t_c = fit(x, {**params, "random_state": 43}, precomputed_knn=(pk_idx, pk_dst))
    print(f"UMAP（precomputed_knn、random_state=43）: {t_c:.1f} s")
    describe("目安: 厳密な kNN・random_state=43", pos_c, published, labels, idx)
    return 0


if __name__ == "__main__":
    sys.exit(main())
