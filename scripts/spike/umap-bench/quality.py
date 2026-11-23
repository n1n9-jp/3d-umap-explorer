#!/usr/bin/env python3
"""埋め込みの質を評価する。

各 .cache/results/*.f32（count×3 の float32）と、既存の事前計算 public/data/mnist/positions.f32 について、
  - 3次元での k 近傍（k=10, 15）のうち同じラベルを持つ点の割合（全点平均）
  - 高次元の厳密な 15 近傍（自分を除く）のうち、3次元の 15 近傍にも含まれる割合
を出し、results/quality.json へ書く。
使い方: .cache/venv/bin/python quality.py
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
ROOT = HERE.parents[2]


def centroid_dists(pos, labels):
    """ラベルごとの重心どうしの距離（45 組）。全体の配置の比較に使う。"""
    c = np.stack([pos[labels == l].mean(0) for l in range(10)]).astype(np.float64)
    d = np.linalg.norm(c[:, None] - c[None], axis=-1)
    return d[np.triu_indices(10, 1)]


def metrics(pos, labels, hd_idx, ref_cd=None):
    n = pos.shape[0]
    tree = cKDTree(pos.astype(np.float64))
    _, nn = tree.query(pos.astype(np.float64), k=16)
    out = {}
    for k in (10, 15):
        out[f"sameLabel{k}"] = float((labels[nn[:, 1:k + 1]] == labels[:, None]).mean())
    # 高次元15近傍（自分を除く = 列1..15）の再現率
    hd = hd_idx[:, 1:16]
    hit = 0
    for i in range(n):
        hit += np.intersect1d(nn[i, 1:16], hd[i]).size
    out["knnRecall15"] = hit / (n * 15)
    if ref_cd is not None:
        cd = centroid_dists(pos, labels)
        # 縮尺は結果ごとに違うので、相関（Pearson）で比べる
        out["centroidDistCorrVsReference"] = float(np.corrcoef(cd, ref_cd)[0, 1])
    out["finite"] = bool(np.isfinite(pos).all())
    out["bboxExtent"] = (pos.max(0) - pos.min(0)).tolist()
    return out


def main():
    res = {}
    labels10 = np.fromfile(CACHE / "labels.u8", dtype=np.uint8)
    labels70 = np.fromfile(CACHE / "labels_70k.u8", dtype=np.uint8)
    hd10 = np.fromfile(CACHE / "knn_idx_k50.i32", dtype=np.int32).reshape(-1, 50)
    hd70 = np.fromfile(CACHE / "knn_idx_k50_70k.i32", dtype=np.int32).reshape(-1, 50)

    pub = np.fromfile(ROOT / "public/data/mnist/positions.f32", dtype="<f4").reshape(-1, 3)
    res["reference_umaplearn_public"] = metrics(pub, labels10, hd10)
    ref_cd = centroid_dists(pub, labels10)

    for f in sorted((CACHE / "results").glob("*.f32")):
        name = f.stem
        pos = np.fromfile(f, dtype="<f4").reshape(-1, 3)
        if pos.shape[0] == 10000:
            lab, hd = labels10, hd10
        elif pos.shape[0] == 70000:
            lab, hd = labels70, hd70
        else:
            continue
        res[name] = metrics(pos, lab, hd, ref_cd if pos.shape[0] == 10000 else None)
        print(name, {k: (round(v, 4) if isinstance(v, float) else v) for k, v in res[name].items() if k != "bboxExtent"}, flush=True)
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "quality.json").write_text(json.dumps(res, indent=2, ensure_ascii=False) + "\n")
    print("reference", res["reference_umaplearn_public"])


if __name__ == "__main__":
    sys.exit(main())
