#!/usr/bin/env python3
"""MNIST 1万点の厳密な kNN グラフ（k=50、自分自身を含む）を作り、.cache/ へ書き出す。

出力（すべて .cache/）:
  knn_idx_k50.i32     Int32 (count*50)   行 i の近傍の番号（昇順の距離、列0は自分自身）
  knn_dist_k50.f32    Float32 (count*50) ユークリッド距離（2乗ではない）
  knn_umaplearn_k15.json  umap-learn が内部で使った kNN（n_neighbors=15）と、厳密な kNN の先頭15列の一致率
  x_scaled_70k.* 等   7万点相当の合成データ（--big を付けたとき）

実行:  .cache/venv/bin/python make_knn.py [--big]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
PRECOMPUTE = HERE.parents[1] / "precompute"
sys.path.insert(0, str(PRECOMPUTE))
import mnist_umap  # noqa: E402  取得の仕組み（fetch_inputs / load_inputs）と UMAP_PARAMS を再利用する

K = 50


def exact_knn(x: np.ndarray, k: int, chunk: int = 2000):
    """ユークリッド距離の厳密な kNN。列0は必ず自分自身（距離0）にする。"""
    n = x.shape[0]
    x64 = x.astype(np.float64)
    sq = (x64 * x64).sum(1)
    idx = np.empty((n, k), dtype=np.int32)
    dist = np.empty((n, k), dtype=np.float32)
    for s in range(0, n, chunk):
        e = min(s + chunk, n)
        d2 = sq[s:e, None] + sq[None, :] - 2.0 * (x64[s:e] @ x64.T)
        np.maximum(d2, 0, out=d2)
        d2[np.arange(e - s), np.arange(s, e)] = -1.0  # 自分自身を必ず先頭にする
        part = np.argpartition(d2, k - 1, axis=1)[:, :k]
        pd = np.take_along_axis(d2, part, 1)
        order = np.argsort(pd, axis=1, kind="stable")
        part = np.take_along_axis(part, order, 1)
        pd = np.take_along_axis(pd, order, 1)
        pd[:, 0] = 0.0
        idx[s:e] = part
        dist[s:e] = np.sqrt(pd).astype(np.float32)
    return idx, dist


def exact_knn_f32(x: np.ndarray, k: int, chunk: int = 1000):
    """7万点用。float32 の行列積で近似なく（丸め誤差は距離 1e-3 程度）求める。"""
    n = x.shape[0]
    sq = (x * x).sum(1)
    idx = np.empty((n, k), dtype=np.int32)
    dist = np.empty((n, k), dtype=np.float32)
    for s in range(0, n, chunk):
        e = min(s + chunk, n)
        d2 = sq[s:e, None] + sq[None, :] - 2.0 * (x[s:e] @ x.T)
        np.maximum(d2, 0, out=d2)
        d2[np.arange(e - s), np.arange(s, e)] = -1.0
        part = np.argpartition(d2, k - 1, axis=1)[:, :k]
        pd = np.take_along_axis(d2, part, 1)
        order = np.argsort(pd, axis=1, kind="stable")
        part = np.take_along_axis(part, order, 1)
        pd = np.take_along_axis(pd, order, 1)
        pd[:, 0] = 0.0
        idx[s:e] = part
        dist[s:e] = np.sqrt(pd)
    return idx, dist


def overlap(a: np.ndarray, b: np.ndarray) -> float:
    """行ごとの集合としての一致率（|A∩B| / |A|）の全点平均。"""
    n, k = a.shape
    hit = 0
    for i in range(n):
        hit += np.intersect1d(a[i], b[i]).size
    return hit / (n * k)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--big", action="store_true", help="7万点相当の合成データも作る")
    ap.add_argument("--big-only", action="store_true", help="7万点相当の合成データだけ作る（10k の kNN は作り済みであること）")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    paths = mnist_umap.fetch_inputs()
    x, labels = mnist_umap.load_inputs(paths)
    print("x", x.shape, x.dtype, "range", float(x.min()), float(x.max()))
    if args.big_only:
        make_big(x, labels)
        return

    t0 = time.perf_counter()
    idx, dist = exact_knn(x, K)
    print(f"exact kNN k={K}: {time.perf_counter() - t0:.1f}s")
    assert (idx[:, 0] == np.arange(len(x))).all()
    idx.tofile(CACHE / "knn_idx_k50.i32")
    dist.tofile(CACHE / "knn_dist_k50.f32")
    labels.tofile(CACHE / "labels.u8")
    print("dist col1 median", float(np.median(dist[:, 1])), "col14 median", float(np.median(dist[:, 14])),
          "zero-distance non-self:", int((dist[:, 1] == 0).sum()))

    # umap-learn が内部で使った kNN（既存の事前計算と同じパラメータ）
    import umap  # noqa: E402

    t0 = time.perf_counter()
    reducer = umap.UMAP(**mnist_umap.UMAP_PARAMS)
    y = reducer.fit_transform(x)
    print(f"umap-learn fit: {time.perf_counter() - t0:.1f}s")
    ki = np.asarray(reducer._knn_indices)
    kd = np.asarray(reducer._knn_dists)
    print("umap-learn knn", ki.shape, "col0==self:", float((ki[:, 0] == np.arange(len(x))).mean()))
    # 同じ座標が public/ の事前計算と一致するかの確認（再現環境かどうか）
    pos = mnist_umap.normalize(np.asarray(y)).reshape(-1, 3)
    pub = np.fromfile(HERE.parents[1] / ".." / "public/data/mnist/positions.f32", dtype="<f4").reshape(-1, 3)
    print("umap-learn fit vs public/positions.f32 max abs diff:", float(np.abs(pos - pub).max()))
    n15 = ki.shape[1]
    ov_set = overlap(ki, idx[:, :n15])
    # 自分自身を除いた14近傍での一致率
    ov_noself = overlap(ki[:, 1:], idx[:, 1:n15])
    # 距離の一致（umap-learn 側の距離は sqrt 済み）
    dmax = float(np.abs(kd[:, 1:] - dist[:, 1:n15]).max())
    # 厳密な15番目の距離に対する、umap-learn の15番目の距離の比
    ratio = float(np.mean(kd[:, -1] / np.maximum(dist[:, n15 - 1], 1e-12)))
    res = {
        "umapLearnVersion": mnist_umap.version("umap-learn"),
        "params": {k: v for k, v in mnist_umap.UMAP_PARAMS.items()},
        "knnShape": list(ki.shape),
        "overlapFirst15IncludingSelf": ov_set,
        "overlapFirst14ExcludingSelf": ov_noself,
        "meanRatioKthDistApproxOverExact": ratio,
        "maxAbsDistDiff": dmax,
        "rowsWithAllMatched": float((np.array([np.intersect1d(ki[i], idx[i, :n15]).size for i in range(len(x))]) == n15).mean()),
    }
    (CACHE / "knn_umaplearn_k15.json").write_text(json.dumps(res, indent=2, ensure_ascii=False) + "\n")
    np.asarray(ki, dtype=np.int32).tofile(CACHE / "knn_umaplearn_idx_k15.i32")
    np.asarray(kd, dtype=np.float32).tofile(CACHE / "knn_umaplearn_dist_k15.f32")
    print(json.dumps(res, indent=2, ensure_ascii=False))

    if args.big:
        make_big(x, labels)


def make_big(x: np.ndarray, labels: np.ndarray, copies: int = 7) -> None:
    """7万点相当の合成データ。1万点を7回複製し、各複製へ等方ガウス雑音を加える。

    雑音の大きさは、複製の点どうしが元の厳密 kNN の15番目の距離の半分程度になるようにする。
    計算量（点数×次元×近傍数）を実データの7万点と揃えるためのもので、点群の構造は MNIST 全体とは異なる。
    """
    rng = np.random.default_rng(7)
    d = np.fromfile(CACHE / "knn_dist_k50.f32", dtype=np.float32).reshape(-1, K)
    target = 0.5 * float(np.median(d[:, 14]))
    sigma = target / np.sqrt(x.shape[1])
    xs = np.concatenate([x + rng.normal(0, sigma, x.shape).astype(np.float32) for _ in range(copies)], 0)
    ls = np.tile(labels, copies)
    n = xs.shape[0]
    print(f"synthetic {n} points, sigma/dim={sigma:.4f}")
    t0 = time.perf_counter()
    idx, dist = exact_knn_f32(xs, K)
    print(f"exact kNN (70k): {time.perf_counter() - t0:.1f}s")
    idx.tofile(CACHE / "knn_idx_k50_70k.i32")
    dist.tofile(CACHE / "knn_dist_k50_70k.f32")
    ls.tofile(CACHE / "labels_70k.u8")
    print("70k dist col14 median", float(np.median(dist[:, 14])))


if __name__ == "__main__":
    main()
