#!/usr/bin/env python3
"""配信用データに「空間の構造」の情報（全体の範囲、密度、主成分軸、クラスタ）を追加する。

データセットのディレクトリ（manifest.json・positions.f32・labels.u8 を含む）を受け取り、
次を行う。座標とラベルは読むだけで変更しない。

- manifest.json へ bounds / density / overview / clusters を書き加える
  （2回目以降は、これらの項目を計算し直して置き換える）
- 点ごとのクラスタ番号を clusters-<階層名>.u16 として書き出す

    python scripts/precompute/add_structure.py public/data/mnist

manifest.json に labels がなくても動く（クラスタの majorityLabel と purity は null、name は C1, C2, ...）。
階層ごとの HDBSCAN のパラメータは、--coarse-max-cluster-size などの引数でデータセットごとに上書きできる。
同じ入力からは同じ出力になる（HDBSCAN・PCA・medoid のどれも乱数を使わない）。
"""

from __future__ import annotations

import argparse
import json
import math
import os
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

# 上限（maxClusterSize）を超えた塊が消えたとみなす基準:
# 上限なしでは1つのクラスタだった点のうち、上限ありでノイズになった点の割合がこれを超えたとき警告する。
LOST_NOISE_RATIO = 0.5

# コマンドライン引数で上書きできるパラメータ（manifest の params のキー → (引数名の末尾, 下限)）
OVERRIDABLE = {
    "minClusterSize": ("min-cluster-size", 2),
    "minSamples": ("min-samples", 1),
    "maxClusterSize": ("max-cluster-size", 0),  # 0 は「上限なし」（manifest では null）
}


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

    lab_info = manifest.get("labels")
    if lab_info is None:  # ラベルのないデータセット
        return manifest, pos, None, None
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
    """バウンディングボックスの中心を中心とし、最も遠い点までを半径とする球。

    半径は、manifest へ書く丸めた中心から最も遠い点までの距離を切り上げた値なので、
    書き出した中心と半径で全点が球に含まれる。
    """
    center = np.array([r(c) for c in (pos.min(axis=0) + pos.max(axis=0)) / 2])
    farthest = np.linalg.norm(pos - center, axis=1).max()
    radius = ceil6(farthest)
    if radius < farthest:  # 浮動小数の誤差で切り上げが足りなかったとき
        radius = r(radius + 10**-DIGITS)
    return {"center": [float(c) for c in center], "radius": radius}


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


def level_params(level: dict, count: int, overrides: dict | None) -> dict:
    """階層の既定値（点数に対する割合）から実際に使う整数のパラメータを作り、overrides で上書きする。

    maxClusterSize が None のときは上限なし。
    """
    params = {
        "minClusterSize": max(2, round(level["minClusterSizeRatio"] * count)),
        "minSamples": level["minSamples"],
        "maxClusterSize": round(level["maxClusterSizeRatio"] * count),
        "selectionMethod": level["selectionMethod"],
    }
    for key, value in (overrides or {}).items():
        if value is not None:
            params[key] = value
    if params["maxClusterSize"] == 0:
        params["maxClusterSize"] = None
    if params["maxClusterSize"] is not None and params["maxClusterSize"] < params["minClusterSize"]:
        raise SystemExit(
            f"[{level['name']}] maxClusterSize ({params['maxClusterSize']}) が "
            f"minClusterSize ({params['minClusterSize']}) より小さくなっています"
        )
    return params


def run_hdbscan(pos: np.ndarray, params: dict) -> np.ndarray:
    return HDBSCAN(
        min_cluster_size=params["minClusterSize"],
        min_samples=params["minSamples"],
        max_cluster_size=params["maxClusterSize"],
        cluster_selection_method=params["selectionMethod"],
        copy=True,
    ).fit_predict(pos)


def find_lost_blobs(pos: np.ndarray, level_name: str, params: dict, raw: np.ndarray) -> list[str]:
    """maxClusterSize を超えたために採用されず、点がノイズになった塊を検出し、警告文のリストを返す。

    HDBSCAN（eom 方式）は上限を超えるクラスタを採用せず、採用できる子もなければ、その点をすべてノイズにする。
    そこで同じ階層を上限なしでも計算し、上限なしで上限を超える1つのクラスタだった点のうち、
    上限ありでノイズになった点が LOST_NOISE_RATIO を超える塊を報告する。
    上限を超えない（上限の有無で変わらない）クラスタは対象にならない。
    """
    cap = params["maxClusterSize"]
    if cap is None:
        return []
    unlimited = run_hdbscan(pos, {**params, "maxClusterSize": None})
    flag = f"--{level_name}-max-cluster-size"
    lost = []
    for uid in np.unique(unlimited[unlimited >= 0]):
        members = np.flatnonzero(unlimited == uid)
        if len(members) <= cap:
            continue
        noise = int((raw[members] < 0).sum())
        if noise / len(members) > LOST_NOISE_RATIO:
            lost.append((len(members), noise, pos[members].mean(axis=0)))
    lost.sort(key=lambda t: -t[0])
    return [
        f"[{level_name}] 点数 {size} の塊（重心 {[r(c) for c in center]}）が maxClusterSize={cap} を超えるため"
        f"採用されず、{noise} 点（{noise / size:.0%}）がノイズになっています。"
        f"{flag} を {size} 以上にする（0 で上限なし）と、1つのクラスタとして採用されます。"
        for size, noise, center in lost
    ]


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


def describe_clusters(
    pos: np.ndarray, labels: np.ndarray | None, names: list[str] | None, assign: np.ndarray
) -> list[dict]:
    """クラスタの一覧。labels がないときは、majorityLabel と purity が null、name は C1, C2, ...（id の順）。"""
    clusters = []
    for cid in range(int(assign[assign != NOISE].max()) + 1 if (assign != NOISE).any() else 0):
        members = np.flatnonzero(assign == cid)
        pts = pos[members]
        m = members[medoid_index(pts)]
        center = pos[m]
        dist = np.linalg.norm(pts - center, axis=1)
        if labels is None:
            name, majority, purity = f"C{cid + 1}", None, None
        else:
            counts = np.bincount(labels[members], minlength=len(names))
            majority = int(np.argmax(counts))  # 同数なら番号の小さいラベル
            name, purity = names[majority], r(counts[majority] / len(members))
        clusters.append(
            {
                "id": cid,
                "name": name,
                "size": int(len(members)),
                "medoid": int(m),
                "center": [r(c) for c in center],
                "radius": ceil6(np.percentile(dist, 90)),
                "bbox": [[floor6(v) for v in pts.min(axis=0)], [ceil6(v) for v in pts.max(axis=0)]],
                "majorityLabel": majority,
                "purity": purity,
                "parent": None,
            }
        )
    # 同じ階層で多数派ラベルが同じクラスタが複数あるとき、点数が最大のものをそのままの名前にし、
    # 以降を点数の多い順（id の順）に「3 (2)」「3 (3)」とする
    seen: Counter = Counter()
    for c in clusters if labels is not None else []:
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


# ---------- ファイルの書き出し ----------

def write_atomically(ds: Path, files: dict[str, bytes], last: str, stale_glob: str) -> None:
    """files（ファイル名 → 内容）を ds へ書く。すべて一時ファイルへ書き終えてから名前を変えて置き換え、last を最後に置く。

    一時ファイルへの書き込みの途中で失敗しても、ds のファイルは実行前のまま残る
    （一時ファイルは消える）。last の置き換えのあと、files に含まれない stale_glob に一致する
    古いファイル（階層の構成が変わって使われなくなった pointFile）を削除する。
    """
    temps: dict[str, Path] = {}
    try:
        for name, data in files.items():
            tmp = ds / f".{name}.{os.getpid()}.tmp"
            temps[name] = tmp
            with open(tmp, "xb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
        for name in [n for n in files if n != last] + [last]:
            os.replace(temps[name], ds / name)
            del temps[name]
    finally:
        for tmp in temps.values():
            tmp.unlink(missing_ok=True)
    for old in sorted(ds.glob(stale_glob)):
        if old.name not in files:
            old.unlink()


# ---------- 実行 ----------

def add_structure(ds: Path, overrides: dict[str, dict] | None = None) -> None:
    """ds の manifest.json へ空間の構造を書き加え、クラスタ番号のファイルを ds へ書き出す。

    overrides は、階層名 → {"minClusterSize": ..., "minSamples": ..., "maxClusterSize": ...} の辞書
    （HDBSCAN のパラメータの上書き。maxClusterSize が 0 のときは上限なし）。
    """
    manifest, pos, labels, names = load_dataset(ds)
    count = len(pos)
    overrides = overrides or {}
    unknown = set(overrides) - {lv["name"] for lv in LEVELS}
    if unknown:
        raise SystemExit(f"未知の階層名です: {sorted(unknown)}")

    structure = {
        "bounds": compute_bounds(pos),
        "density": compute_density(pos),
        "overview": compute_overview(pos),
    }

    level_assigns, level_clusters, warnings = [], [], []
    for level in LEVELS:
        params = level_params(level, count, overrides.get(level["name"]))
        raw = run_hdbscan(pos, params)
        warnings += find_lost_blobs(pos, level["name"], params, raw)
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

    levels_out, files = [], {}
    for level, assign, (params, clusters) in zip(LEVELS, level_assigns, level_clusters):
        point_file = f"clusters-{level['name']}.u16"
        files[point_file] = assign.astype("<u2").tobytes()
        levels_out.append({"name": level["name"], "params": params, "pointFile": point_file, "clusters": clusters})
    structure["clusters"] = {"method": "hdbscan", "noise": NOISE, "levels": levels_out}

    out = {k: v for k, v in manifest.items() if k not in STRUCTURE_KEYS}
    out.update(structure)
    files["manifest.json"] = (dump_json(out) + "\n").encode("utf-8")
    write_atomically(ds, files, last="manifest.json", stale_glob="clusters-*.u16")

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
            purity = "-" if c["purity"] is None else f"{c['purity']:.3f}"
            print(f"{c['id']:>3} {c['name']:<8} {c['size']:>6} {purity:>7} {c['radius']:>8.4f} {parent!s:>6}")
    for w in warnings:
        print(f"警告: {w}", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", type=Path, help="manifest.json を含むデータセットのディレクトリ（例: public/data/mnist）")
    for level in LEVELS:
        for key, (flag, _) in OVERRIDABLE.items():
            ratio = f"点数の {level[key + 'Ratio']:.1%}".replace("%", "%%") if key + "Ratio" in level else f"{level[key]}"
            note = "。0 で上限なし" if key == "maxClusterSize" else ""
            ap.add_argument(
                f"--{level['name']}-{flag}",
                dest=f"{level['name']}.{key}",
                type=int,
                metavar="N",
                help=f"{level['name']} 階層の {key}（既定: {ratio}）{note}",
            )
    args = ap.parse_args()

    overrides: dict[str, dict] = {}
    for level in LEVELS:
        for key, (flag, lower) in OVERRIDABLE.items():
            value = getattr(args, f"{level['name']}.{key}")
            if value is None:
                continue
            if value < lower:
                ap.error(f"--{level['name']}-{flag} は {lower} 以上にしてください")
            overrides.setdefault(level["name"], {})[key] = value
    add_structure(args.dataset, overrides)


if __name__ == "__main__":
    sys.exit(main())
