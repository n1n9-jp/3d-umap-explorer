"""元の高次元空間での厳密な k 近傍（kNN）グラフの計算・書き出し・検証。

配信用の `knn-indices.u16|u32`（番号）と `knn-distances.f32`（距離）を作る。形式はリポジトリ直下の README.md の「データ形式」。

計算方法（ブルートフォースで厳密）:
  1. 点を `BLOCK` 行ずつのまとまりに分け、まとまりと全点との距離（BLOCK x count、float64）を行列積で求める。
     全点間の距離行列は持たない（メモリは BLOCK x count x 8 バイトが上限）。
  2. 行ごとに、距離が小さい `k + 1 + MARGIN` 点を候補として選ぶ（argpartition）。
  3. 候補との距離を、行列積ではなく差（コサインは単位ベクトルの内積）から直接求め直す。
     行列積の距離は桁落ちで 1e-13 ほどの誤差を持つので、並び順と最終の値にはこちらを使う。
  4. 距離を float32 にして、（距離, 番号）の辞書順に整列し、自分自身を除いて先頭 k 点を取る。
     同じ距離の点は番号の小さい順になる。
  5. 候補の外に、k 番目と同じ距離（float32）になりうる点が残っていないかを確かめる。残りうる行は、全点を直接計算して選び直す。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

BLOCK = 512  # 一度に距離を求める行数
MARGIN = 32  # 候補に加える余裕の点数（距離の誤差と同じ距離の点の取りこぼしを防ぐ）
TOL = 1e-9  # 行列積の距離の誤差の上限（相対）。実測は 1e-13 程度
EXACT_CHUNK = 64  # 候補との距離を直接求めるときの行数（メモリを抑える）

METRICS = ("euclidean", "cosine")


def index_dtype(count: int) -> tuple[str, str]:
    """点の番号のファイルの (dtype 名, 拡張子)。65536 点以下なら uint16。"""
    return ("uint16", "u16") if count <= 65536 else ("uint32", "u32")


def _prepare(x: np.ndarray, metric: str) -> np.ndarray:
    """距離の計算用に float64 へ変換する。コサインは単位ベクトルにする。"""
    if metric not in METRICS:
        raise SystemExit(f"kNN は metric {METRICS} のみ対応しています: {metric}")
    v = np.ascontiguousarray(x, dtype=np.float64)
    if metric == "cosine":
        norm = np.linalg.norm(v, axis=1)
        if (norm == 0).any():
            raise SystemExit("コサイン距離は、ゼロベクトルがあると定義できません")
        v = v / norm[:, None]
    return v


def _direct(v: np.ndarray, rows: np.ndarray, cand: np.ndarray, metric: str) -> np.ndarray:
    """点 rows[b] と点 cand[b, j] の距離（float64）を、差または内積から直接求める。形状は cand と同じ。"""
    out = np.empty(cand.shape, dtype=np.float64)
    for s in range(0, len(rows), EXACT_CHUNK):
        sl = slice(s, s + EXACT_CHUNK)
        a = v[rows[sl]][:, None, :]
        b = v[cand[sl]]
        if metric == "euclidean":
            out[sl] = np.sqrt(np.einsum("bjd,bjd->bj", a - b, a - b))
        else:
            out[sl] = np.maximum(1.0 - np.einsum("bid,bjd->bj", a, b), 0.0)
    return out


def _select(dist32: np.ndarray, cand: np.ndarray, row: int, k: int) -> tuple[np.ndarray, np.ndarray]:
    """候補を（距離, 番号）の辞書順に整列し、自分自身を除いた先頭 k 点（番号, 距離）を返す。"""
    order = np.lexsort((cand, dist32))
    cand, dist32 = cand[order], dist32[order]
    keep = cand != row
    return cand[keep][:k], dist32[keep][:k]


def compute_knn(x: np.ndarray, metric: str, k: int) -> tuple[np.ndarray, np.ndarray, dict]:
    """厳密な kNN（自分自身を除く）。(番号 int64 [count, k], 距離 float32 [count, k], 統計) を返す。"""
    count = len(x)
    if not 1 <= k < count:
        raise SystemExit(f"k は 1 以上 count 未満にしてください: k={k}, count={count}")
    v = _prepare(x, metric)
    sq = (v * v).sum(axis=1) if metric == "euclidean" else None
    n_cand = min(count, k + 1 + MARGIN)

    idx = np.empty((count, k), dtype=np.int64)
    dst = np.empty((count, k), dtype=np.float32)
    fallback_rows = 0
    for start in range(0, count, BLOCK):
        rows = np.arange(start, min(start + BLOCK, count))
        gram = v[rows] @ v.T
        if metric == "euclidean":
            approx = sq[rows][:, None] + sq[None, :] - 2.0 * gram
            np.maximum(approx, 0.0, out=approx)
            np.sqrt(approx, out=approx)
        else:
            approx = 1.0 - gram
        if n_cand < count:
            cand = np.argpartition(approx, n_cand - 1, axis=1)[:, :n_cand]
            cutoff = np.take_along_axis(approx, cand, axis=1).max(axis=1)  # 候補の外の点の距離は、これ以上
        else:
            cand = np.broadcast_to(np.arange(count), (len(rows), count)).copy()
            cutoff = np.full(len(rows), np.inf)
        d32 = _direct(v, rows, cand, metric).astype(np.float32)
        for b, row in enumerate(rows):
            ci, di = _select(d32[b], cand[b], row, k)
            # k 番目の距離が、候補の外の点の距離の下限より（float32 で）確実に小さければ、候補の外に取りこぼしはない
            safe = np.float32(cutoff[b] * (1 - TOL) - TOL)
            if len(ci) < k or not di[-1] < safe:
                fallback_rows += 1
                full = np.arange(count)
                df = _direct(v, np.array([row]), full[None, :], metric)[0].astype(np.float32)
                ci, di = _select(df, full, row, k)
            idx[row], dst[row] = ci, di
    return idx, dst, {"fallbackRows": fallback_rows, "block": BLOCK, "margin": MARGIN}


# ---------- 書き出しと検証 ----------

def knn_file_names(count: int) -> tuple[str, str]:
    _, ext = index_dtype(count)
    return f"knn-indices.{ext}", "knn-distances.f32"


def knn_manifest(count: int, k: int, metric: str) -> dict:
    """manifest の `knn` 項目。"""
    dtype, _ = index_dtype(count)
    f_idx, f_dst = knn_file_names(count)
    return {
        "k": k,
        "metric": metric,
        "includesSelf": False,
        "exact": True,
        "indices": {"file": f_idx, "dtype": dtype},
        "distances": {"file": f_dst, "dtype": "float32"},
    }


def write_knn(stage: Path, idx: np.ndarray, dst: np.ndarray) -> None:
    """作業用ディレクトリへ番号と距離を書く（リトルエンディアン、行優先）。"""
    count = len(idx)
    dtype, _ = index_dtype(count)
    f_idx, f_dst = knn_file_names(count)
    idx.astype("<u2" if dtype == "uint16" else "<u4").tofile(stage / f_idx)
    dst.astype("<f4").tofile(stage / f_dst)


def read_knn(ds: Path, manifest: dict) -> tuple[np.ndarray, np.ndarray]:
    """manifest の `knn` を読み、(番号 int64 [count, k], 距離 float32 [count, k]) を返す。"""
    info, count, k = manifest["knn"], manifest["count"], manifest["knn"]["k"]
    idx_type = {"uint16": "<u2", "uint32": "<u4"}[info["indices"]["dtype"]]
    idx = np.fromfile(ds / info["indices"]["file"], dtype=idx_type)
    dst = np.fromfile(ds / info["distances"]["file"], dtype="<f4")
    if idx.size != count * k or dst.size != count * k:
        raise SystemExit("kNN のファイルの長さが count * k と一致しません")
    return idx.reshape(count, k).astype(np.int64), dst.reshape(count, k)


def verify_knn(idx: np.ndarray, dst: np.ndarray, count: int) -> None:
    """自分自身を含まない・番号が範囲内・（距離, 番号）が行の中で狭義増加・距離が有限で非負、を確かめる。"""
    if idx.shape != dst.shape or idx.shape[0] != count:
        raise SystemExit("kNN の形状が想定と異なります")
    if idx.min() < 0 or idx.max() >= count:
        raise SystemExit("kNN の番号が範囲外です")
    if (idx == np.arange(count)[:, None]).any():
        raise SystemExit("kNN に自分自身の番号があります")
    if not np.isfinite(dst).all() or dst.min() < 0:
        raise SystemExit("kNN の距離に負または有限でない値があります")
    d0, d1, i0, i1 = dst[:, :-1], dst[:, 1:], idx[:, :-1], idx[:, 1:]
    if not ((d1 > d0) | ((d1 == d0) & (i1 > i0))).all():
        raise SystemExit("kNN が（距離, 番号）の順に並んでいません")


def neighbor_overlap(a: np.ndarray, b: np.ndarray, k: int) -> float:
    """行ごとの近傍集合（先頭 k 列）の重なりの割合 |A∩B|/k の全行平均。"""
    a, b = a[:, :k], b[:, :k]
    n = len(a)
    # 行ごとに 2 つの集合の共通要素数を数える（番号を (行, 番号) の組にして重複を調べる）
    key_a = (np.arange(n)[:, None] * (max(a.max(), b.max()) + 1) + a).ravel()
    key_b = (np.arange(n)[:, None] * (max(a.max(), b.max()) + 1) + b).ravel()
    return float(np.isin(key_a, key_b).sum() / (n * k))
