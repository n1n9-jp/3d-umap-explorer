#!/usr/bin/env python3
"""配信用データに「空間の構造」の情報（全体の範囲、密度、主成分軸、クラスタ）を追加する。

データセットのディレクトリ（manifest.json・positions.f32・labels.u8 を含む）を受け取り、
次を行う。座標とラベルは読むだけで変更しない。

- manifest.json へ bounds / density / overview / clusters を書き加える
  （2回目以降は、これらの項目を計算し直して置き換える）
- 点ごとのクラスタ番号を clusters-<階層名>.u16 として書き出す

    python scripts/precompute/add_structure.py public/data/mnist

同じ入力からは同じ出力になる（HDBSCAN・PCA・medoid のどれも乱数を使わない）。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.distance import cdist
from sklearn.cluster import HDBSCAN

NOISE = 65535  # どのクラスタにも属さない点の値（Uint16）
KNN_K = 8
DIGITS = 6  # manifest の浮動小数の桁数

# 階層ごとの HDBSCAN のパラメータ。点数に依存する値は「全点数に対する割合」で持ち、
# 実際に使った整数値を manifest の params に残す（別のデータセットでも同じ設定が使える）。
LEVELS = [
    {
        "name": "coarse",
        "minClusterSizeRatio": 0.02,
        "minSamples": 5,
        "maxClusterSizeRatio": 0.15,
        "selectionMethod": "eom",
    },
    {
        "name": "fine",
        "minClusterSizeRatio": 0.004,
        "minSamples": 2,
        "maxClusterSizeRatio": 0.05,
        "selectionMethod": "eom",
    },
]

STRUCTURE_KEYS = ("bounds", "density", "overview", "clusters")


# ---------- 読み込み ----------

def load_dataset(ds: Path):
    manifest = json.loads((ds / "manifest.json").read_text())
    count = int(manifest["count"])

    pos_info = manifest["positions"]
    if pos_info["dtype"] != "float32" or pos_info["components"] != 3:
        raise SystemExit("positions は float32 の3成分のみ対応しています")
    pos = np.fromfile(ds / pos_info["file"], dtype="<f4")
    if pos.size != 3 * count:
        raise SystemExit(f"{pos_info['file']} の長さが 3 * count と一致しません")
    pos = pos.reshape(count, 3).astype(np.float64)
    if not np.isfinite(pos).all():
        raise SystemExit("positions に有限でない値があります")

    lab_info = manifest["labels"]
    if lab_info["dtype"] != "uint8":
        raise SystemExit("labels は uint8 のみ対応しています")
    labels = np.fromfile(ds / lab_info["file"], dtype=np.uint8)
    if labels.size != count:
        raise SystemExit(f"{lab_info['file']} の長さが count と一致しません")
    names = list(lab_info["names"])
    if labels.max() >= len(names):
        raise SystemExit("labels の値が names の範囲を超えています")
    return manifest, pos, labels, names


# ---------- 丸め ----------

def r(x: float) -> float:
    return round(float(x), DIGITS)


def ceil6(x: float) -> float:
    return math.ceil(float(x) * 10**DIGITS) / 10**DIGITS


def floor6(x: float) -> float:
    return math.floor(float(x) * 10**DIGITS) / 10**DIGITS


# ---------- 全体の範囲・密度・主成分 ----------

def compute_bounds(pos: np.ndarray) -> dict:
    """バウンディングボックスの中心を中心とし、最も遠い点までを半径とする球（丸めても全点を含む）。"""
    center = (pos.min(axis=0) + pos.max(axis=0)) / 2
    radius = np.linalg.norm(pos - center, axis=1).max()
    return {"center": [r(c) for c in center], "radius": ceil6(radius)}


def compute_density(pos: np.ndarray) -> dict:
    """各点の8近傍（自分自身を除く）までの距離の平均について、5・50・95パーセンタイル。"""
    dist, _ = cKDTree(pos).query(pos, k=KNN_K + 1)
    mean_knn = dist[:, 1:].mean(axis=1)
    p05, p50, p95 = np.percentile(mean_knn, [5, 50, 95])
    return {"k": KNN_K, "knnDistP05": r(p05), "knnDistP50": r(p50), "knnDistP95": r(p95)}


def compute_overview(pos: np.ndarray) -> dict:
    """座標の主成分分析の第1〜第3軸（単位ベクトル）。

    符号は一意でないので、第1・第2軸は絶対値が最大の成分が正になるようにそろえ、
    第3軸は第1軸×第2軸（右手系になる向き）とする。
    """
    centered = pos - pos.mean(axis=0)
    cov = centered.T @ centered / (len(pos) - 1)
    eigval, eigvec = np.linalg.eigh(cov)
    order = np.argsort(eigval)[::-1]
    axes = []
    for k in order[:2]:
        v = eigvec[:, k]
        if v[np.argmax(np.abs(v))] < 0:
            v = -v
        axes.append(v / np.linalg.norm(v))
    axes.append(np.cross(axes[0], axes[1]))
    return {"axes": [[r(c) for c in a] for a in axes]}


# ---------- クラスタ ----------

def medoid_index(points: np.ndarray, chunk: int = 512) -> int:
    """他の全点への距離の合計が最小の点（同値なら番号の小さいもの）。クラスタ内の位置を返す。"""
    totals = np.empty(len(points))
    for s in range(0, len(points), chunk):
        totals[s : s + chunk] = cdist(points[s : s + chunk], points).sum(axis=1)
    return int(np.argmin(totals))


def run_hdbscan(pos: np.ndarray, level: dict) -> tuple[np.ndarray, dict]:
    count = len(pos)
    params = {
        "minClusterSize": max(2, round(level["minClusterSizeRatio"] * count)),
        "minSamples": level["minSamples"],
        "maxClusterSize": round(level["maxClusterSizeRatio"] * count),
        "selectionMethod": level["selectionMethod"],
    }
    raw = HDBSCAN(
        min_cluster_size=params["minClusterSize"],
        min_samples=params["minSamples"],
        max_cluster_size=params["maxClusterSize"],
        cluster_selection_method=params["selectionMethod"],
        copy=True,
    ).fit_predict(pos)
    return raw, params


def renumber(raw: np.ndarray) -> np.ndarray:
    """クラスタ番号を、点数の多い順（同数なら先頭の点の番号が小さい順）に 0 から振り直す。ノイズは NOISE。"""
    ids = [int(i) for i in np.unique(raw) if i >= 0]
    firsts = {i: int(np.flatnonzero(raw == i)[0]) for i in ids}
    sizes = {i: int((raw == i).sum()) for i in ids}
    ordered = sorted(ids, key=lambda i: (-sizes[i], firsts[i]))
    if len(ordered) >= NOISE:
        raise SystemExit("クラスタ数が多すぎて Uint16 に収まりません")
    out = np.full(raw.shape, NOISE, dtype="<u2")
    for new, old in enumerate(ordered):
        out[raw == old] = new
    return out


def describe_clusters(pos: np.ndarray, labels: np.ndarray, names: list[str], assign: np.ndarray) -> list[dict]:
    clusters = []
    for cid in range(int(assign[assign != NOISE].max()) + 1 if (assign != NOISE).any() else 0):
        members = np.flatnonzero(assign == cid)
        pts = pos[members]
        m = members[medoid_index(pts)]
        center = pos[m]
        dist = np.linalg.norm(pts - center, axis=1)
        counts = np.bincount(labels[members], minlength=len(names))
        majority = int(np.argmax(counts))  # 同数なら番号の小さいラベル
        clusters.append(
            {
                "id": cid,
                "name": names[majority],
                "size": int(len(members)),
                "medoid": int(m),
                "center": [r(c) for c in center],
                "radius": ceil6(np.percentile(dist, 90)),
                "bbox": [[floor6(v) for v in pts.min(axis=0)], [ceil6(v) for v in pts.max(axis=0)]],
                "majorityLabel": majority,
                "purity": r(counts[majority] / len(members)),
                "parent": None,
            }
        )
    # 同じ階層で多数派ラベルが同じクラスタが複数あるとき、点数が最大のものをそのままの名前にし、
    # 以降を点数の多い順（id の順）に「3 (2)」「3 (3)」とする
    seen: Counter = Counter()
    for c in clusters:
        seen[c["majorityLabel"]] += 1
        if seen[c["majorityLabel"]] > 1:
            c["name"] = f"{c['name']} ({seen[c['majorityLabel']]})"
    return clusters


def assign_parents(pos: np.ndarray, fine_assign: np.ndarray, fine: list[dict], coarse_assign: np.ndarray) -> None:
    """細かいクラスタの点が最も多く属する粗いクラスタ（ノイズを除く、同数なら id の小さい方）。

    点がすべて粗い階層のノイズだったときは、細かいクラスタの medoid に最も近い、
    粗いクラスタに属する点のクラスタを親とする。
    """
    assigned = np.flatnonzero(coarse_assign != NOISE)
    tree = cKDTree(pos[assigned]) if len(assigned) else None
    for c in fine:
        coarse_ids = coarse_assign[fine_assign == c["id"]]
        coarse_ids = coarse_ids[coarse_ids != NOISE]
        if len(coarse_ids):
            c["parent"] = int(np.argmax(np.bincount(coarse_ids)))
        elif tree is not None:
            _, nearest = tree.query(pos[c["medoid"]])
            c["parent"] = int(coarse_assign[assigned[nearest]])


def verify_level(count: int, assign: np.ndarray, clusters: list[dict]) -> None:
    n = len(clusters)
    if not ((assign < n) | (assign == NOISE)).all():
        raise SystemExit("点のクラスタ番号が範囲外です")
    for c in clusters:
        if assign[c["medoid"]] != c["id"]:
            raise SystemExit(f"クラスタ {c['id']} の medoid が自分のクラスタに属していません")
        if int((assign == c["id"]).sum()) != c["size"]:
            raise SystemExit(f"クラスタ {c['id']} の size が一致しません")


# ---------- manifest の書き出し ----------

def _flat(obj) -> bool:
    """入れ子の辞書（辞書のリストを含む）を持たない辞書。"""
    return isinstance(obj, dict) and not any(
        isinstance(v, dict) or (isinstance(v, list) and v and isinstance(v[0], dict)) for v in obj.values()
    )


def dump_json(obj, level: int = 0) -> str:
    """読みやすい JSON。入れ子のない辞書と、数値・文字列のリストは1行にする。"""
    pad = "  " * (level + 1)
    end = "  " * level
    if _flat(obj) or not isinstance(obj, (dict, list)):
        return json.dumps(obj, ensure_ascii=False)
    if isinstance(obj, dict):
        body = ",\n".join(f"{pad}{json.dumps(k, ensure_ascii=False)}: {dump_json(v, level + 1)}" for k, v in obj.items())
        return "{\n" + body + "\n" + end + "}"
    if obj and isinstance(obj[0], dict):
        return "[\n" + ",\n".join(pad + dump_json(v, level + 1) for v in obj) + "\n" + end + "]"
    return json.dumps(obj, ensure_ascii=False)


# ---------- 実行 ----------

def add_structure(ds: Path) -> None:
    """ds の manifest.json へ空間の構造を書き加え、クラスタ番号のファイルを ds へ書き出す。"""
    manifest, pos, labels, names = load_dataset(ds)
    count = len(pos)

    structure = {
        "bounds": compute_bounds(pos),
        "density": compute_density(pos),
        "overview": compute_overview(pos),
    }

    level_assigns, level_clusters = [], []
    for level in LEVELS:
        raw, params = run_hdbscan(pos, level)
        assign = renumber(raw)
        clusters = describe_clusters(pos, labels, names, assign)
        verify_level(count, assign, clusters)
        level_assigns.append(assign)
        level_clusters.append((params, clusters))
    # 階層の親子: 2階層目以降は、1つ前の階層のクラスタを親とする
    for i in range(1, len(LEVELS)):
        assign_parents(pos, level_assigns[i], level_clusters[i][1], level_assigns[i - 1])
        if any(c["parent"] is not None and c["parent"] >= len(level_clusters[i - 1][1]) for c in level_clusters[i][1]):
            raise SystemExit("parent が上位階層のクラスタ id の範囲外です")

    levels_out = []
    for level, assign, (params, clusters) in zip(LEVELS, level_assigns, level_clusters):
        point_file = f"clusters-{level['name']}.u16"
        assign.astype("<u2").tofile(ds / point_file)
        levels_out.append({"name": level["name"], "params": params, "pointFile": point_file, "clusters": clusters})
    structure["clusters"] = {"method": "hdbscan", "noise": NOISE, "levels": levels_out}

    out = {k: v for k, v in manifest.items() if k not in STRUCTURE_KEYS}
    out.update(structure)
    (ds / "manifest.json").write_text(dump_json(out) + "\n")

    print(f"{ds}: count={count}")
    print("bounds:", structure["bounds"])
    print("density:", structure["density"])
    print("overview axes:", structure["overview"]["axes"])
    for lv, assign in zip(levels_out, level_assigns):
        noise_ratio = float((assign == NOISE).mean())
        print(f"\n[{lv['name']}] params={lv['params']}  clusters={len(lv['clusters'])}  noise={noise_ratio:.2%}")
        print(f"{'id':>3} {'name':<8} {'size':>6} {'purity':>7} {'radius':>8} {'parent':>6}")
        for c in lv["clusters"]:
            parent = "-" if c["parent"] is None else c["parent"]
            print(f"{c['id']:>3} {c['name']:<8} {c['size']:>6} {c['purity']:>7.3f} {c['radius']:>8.4f} {parent!s:>6}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", type=Path, help="manifest.json を含むデータセットのディレクトリ（例: public/data/mnist）")
    add_structure(ap.parse_args().dataset)


if __name__ == "__main__":
    sys.exit(main())
