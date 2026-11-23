#!/usr/bin/env python3
"""配信済みの kNN グラフ（knn-indices / knn-distances）を、計算とは独立な方法で検証する。

    python scripts/precompute/verify_knn.py mnist
    python scripts/precompute/verify_knn.py word2vec-10k --samples 500 --seed 0

1. 形式: 自分自身の番号がない、番号が範囲内、（距離, 番号）が行の中で狭義増加、ファイルの長さ。
2. 独立な計算との比較: 無作為の点について、scikit-learn の NearestNeighbors（brute）と scipy の cdist（float64）で
   近傍を求め、番号と距離が一致するかを見る。距離が一致していて番号の並びだけが違う行（同じ距離の点の順序の違い）は、件数を報告する。
3. ファイルの大きさと、gzip で圧縮した大きさ。

不一致があれば終了コード 1 で終わる。
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys

import numpy as np
from scipy.spatial.distance import cdist
from sklearn.neighbors import NearestNeighbors

import knn as knn_mod
from build_dataset import fetch_inputs, load_inputs
from datasets import DATASETS, OUT_ROOT

DIST_RTOL = 1e-5  # float32 の距離と float64 の距離の許容誤差（相対）


def compare(idx: np.ndarray, dst: np.ndarray, ref_idx: np.ndarray, ref_dst: np.ndarray, name: str) -> dict:
    """行ごとに、番号が完全一致 / 距離が一致して並びだけ違う（同じ距離の順序） / 不一致、を数える。"""
    n, k = idx.shape
    exact = tie_order = bad = 0
    for i in range(n):
        if np.array_equal(idx[i], ref_idx[i]):
            exact += 1
            dist_ok = np.allclose(dst[i], ref_dst[i], rtol=DIST_RTOL, atol=1e-6)
            bad += 0 if dist_ok else 1
        elif np.allclose(dst[i], ref_dst[i], rtol=DIST_RTOL, atol=1e-6):
            # 距離は一致している。番号が違うのは、同じ距離の点（または境界で同じ距離の点）の取り方の違い
            tie_order += 1
        else:
            bad += 1
    max_diff = float(np.abs(dst.astype(np.float64) - ref_dst).max())
    print(f"  vs {name}: {n} 点（k={k}）、番号が完全一致 {exact}、距離は一致し番号だけ違う（同じ距離の順序） {tie_order}、不一致 {bad}、距離の最大差 {max_diff:.3g}")
    return {"exact": exact, "tie_order": tie_order, "bad": bad}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", choices=sorted(DATASETS))
    ap.add_argument("--samples", type=int, default=500, help="独立な計算と比べる点の数")
    ap.add_argument("--seed", type=int, default=0, help="点を選ぶ乱数のシード")
    args = ap.parse_args(argv)

    cfg = DATASETS[args.dataset]
    ds = OUT_ROOT / cfg.out_dir
    manifest = json.loads((ds / "manifest.json").read_text())
    if "knn" not in manifest:
        print("manifest に knn がありません")
        return 1
    info = manifest["knn"]
    idx, dst = knn_mod.read_knn(ds, manifest)
    knn_mod.verify_knn(idx, dst, manifest["count"])
    print(f"形式: OK（count={manifest['count']}, k={info['k']}, metric={info['metric']}, 自分自身なし, 番号が範囲内, （距離, 番号）が行の中で狭義増加）")
    print(f"  距離が行の中で非減少: {bool((np.diff(dst, axis=1) >= 0).all())}、距離の範囲 {float(dst.min()):.6g} 〜 {float(dst.max()):.6g}")

    x, _, _ = load_inputs(cfg, fetch_inputs(cfg))
    rng = np.random.default_rng(args.seed)
    rows = np.sort(rng.choice(manifest["count"], size=args.samples, replace=False))
    k = info["k"]
    print(f"独立な計算との比較（無作為の {args.samples} 点、シード {args.seed}）:")

    # (a) scikit-learn の brute（float64 で入力）。自分自身を含めて k+1 点を求め、自分自身の番号を除く
    nn = NearestNeighbors(n_neighbors=k + 1, algorithm="brute", metric=info["metric"]).fit(x.astype(np.float64))
    d_sk, i_sk = nn.kneighbors(x[rows].astype(np.float64))
    sk_idx, sk_dst = np.empty((len(rows), k), dtype=np.int64), np.empty((len(rows), k))
    for r, row in enumerate(rows):
        keep = i_sk[r] != row
        sk_idx[r], sk_dst[r] = i_sk[r][keep][:k], d_sk[r][keep][:k]
    res_sk = compare(idx[rows], dst[rows], sk_idx, sk_dst, "sklearn NearestNeighbors(brute, float64)")

    # (b) scipy の cdist（float64）。（距離, 番号）の辞書順に整列し、自分自身を除く
    full = cdist(x[rows].astype(np.float64), x.astype(np.float64), metric=info["metric"])
    sc_idx, sc_dst = np.empty((len(rows), k), dtype=np.int64), np.empty((len(rows), k))
    for r, row in enumerate(rows):
        order = np.lexsort((np.arange(full.shape[1]), full[r].astype(np.float32)))
        order = order[order != row][:k]
        sc_idx[r], sc_dst[r] = order, full[r][order]
    res_sc = compare(idx[rows], dst[rows], sc_idx, sc_dst, "scipy cdist(float64, 距離を float32 にして（距離, 番号）で整列)")

    print("ファイルの大きさ:")
    for key in ("indices", "distances"):
        path = ds / info[key]["file"]
        raw = path.read_bytes()
        print(f"  {path.name}: {len(raw)} バイト（{len(raw) / 1e6:.3f} MB）、gzip -9: {len(gzip.compress(raw, 9))} バイト（{len(gzip.compress(raw, 9)) / 1e6:.3f} MB）")

    return 1 if res_sk["bad"] or res_sc["bad"] else 0


if __name__ == "__main__":
    sys.exit(main())
