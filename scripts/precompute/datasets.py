"""事前計算するデータセットの設定。

データセットごとの違い（入力ファイルと SHA-256、点数と次元、距離の種類、ラベル・スプライト・単語の有無、
出力先、クラスタのパラメータの上書き、kNN グラフを作るかどうかと k）をここに集める。取得・UMAP・正規化・検証・書き出しなどの共通処理は
build_dataset.py にあり、設定だけを読む。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

REPO_URL = "https://github.com/tensorflow/embedding-projector-standalone"
COMMIT = "6ff71f7233ac5947450409e7938b58ec14d1e24c"

ROOT = Path(__file__).resolve().parents[2]
OUT_ROOT = ROOT / "public" / "data"


# ---------- 入力ファイルの解析 ----------

def parse_digit_labels(path: Path, count: int) -> np.ndarray:
    """1行に1つの整数（0〜9）が並ぶファイル。ラベルの番号として uint8 の配列を返す。"""
    raw = np.array([int(s) for s in path.read_text().split()], dtype=np.int64)
    if raw.shape != (count,) or raw.min() < 0 or raw.max() > 9:
        raise SystemExit(f"{path.name} の内容が想定と異なります")
    return raw.astype(np.uint8)


def parse_words_tsv(path: Path, count: int) -> list[str]:
    """ヘッダー行（`word<TAB>count`）のあとに、1行1語（`単語<TAB>出現数`）が並ぶ TSV。単語を行の順に返す。"""
    text = path.read_text(encoding="utf-8")
    if not text.endswith("\n") or "\r" in text:
        raise SystemExit(f"{path.name} の改行の形式が想定と異なります")
    rows = [line.split("\t") for line in text[:-1].split("\n")]
    if rows[0] != ["word", "count"]:
        raise SystemExit(f"{path.name} のヘッダー行が想定と異なります: {rows[0]}")
    body = rows[1:]
    if len(body) != count or any(len(r) != 2 or r[0] == "" for r in body):
        raise SystemExit(f"{path.name} の行数または列の構成が想定と異なります")
    words = [r[0] for r in body]
    if len(set(words)) != count:
        raise SystemExit(f"{path.name} に重複した単語があります")
    return words


# ---------- 設定 ----------

@dataclass(frozen=True)
class SourceFile:
    name: str  # oss_data/ にあるファイル名
    sha256: str


@dataclass(frozen=True)
class DatasetConfig:
    key: str  # コマンドで指定する名前
    out_dir: str  # public/data/ の下のディレクトリ名
    name: str  # manifest.name
    kind: str  # manifest.kind（点が何を表すか）
    count: int
    dim: int
    metric: str  # UMAP の距離
    tensors: SourceFile  # float32 リトルエンディアン、count x dim
    labels: SourceFile | None = None
    label_names: tuple[str, ...] = ()
    parse_labels: Callable[[Path, int], np.ndarray] | None = None
    sprite: SourceFile | None = None
    sprite_cell: int = 0
    text: SourceFile | None = None
    parse_text: Callable[[Path, int], list[str]] | None = None
    # add_structure.py へ渡す HDBSCAN のパラメータの上書き（階層名 → {minClusterSize, minSamples, maxClusterSize}）
    cluster_overrides: dict[str, dict] = field(default_factory=dict)
    # 検証の表示で、3次元での近傍 10 点を出す単語（kind が text のデータセットのみ）
    probe_words: tuple[str, ...] = ()
    # 元の高次元空間での厳密な kNN グラフ（knn-indices / knn-distances）の近傍数。None で kNN グラフを作らない
    knn_k: int | None = 50


# UMAP の共通パラメータ（metric はデータセットごと）
UMAP_PARAMS = dict(
    n_components=3,
    n_neighbors=15,
    min_dist=0.1,
    random_state=42,
    n_jobs=1,  # 単一スレッドで実行する（並列実行では結果が変わりうる）
    # umap-learn 0.6 の既定値は将来変わる。0.5系と同じ処理（旧パイプライン）に固定して再現性を保つ
    compatibility_layout=True,
)

DATASETS: dict[str, DatasetConfig] = {
    "mnist": DatasetConfig(
        key="mnist",
        out_dir="mnist",
        name="MNIST 10k",
        kind="image",
        count=10_000,
        dim=784,
        metric="euclidean",
        tensors=SourceFile("mnist_10k_784d_tensors.bytes", "f35429bfdd77d51c5dea063ef595c6fa242921aa69ee648056c8f26e2c2d370a"),
        labels=SourceFile("mnist_10k_784d_labels.tsv", "b00c1c90c51a6005aa65dbdac2843589c7580a99541ad50ec435a545b6c25947"),
        label_names=tuple(str(i) for i in range(10)),
        parse_labels=parse_digit_labels,
        sprite=SourceFile("mnist_10k_sprite.png", "9221b2e9866f9590d5c90a092aea5a1904e83e0e02d8125098bbe51d1cbe055d"),
        sprite_cell=28,
    ),
    "word2vec-10k": DatasetConfig(
        key="word2vec-10k",
        out_dir="word2vec-10k",
        name="Word2Vec 10k",
        kind="text",
        count=10_000,
        dim=200,
        metric="cosine",
        tensors=SourceFile("word2vec_10000_200d_tensors.bytes", "deaedca3920530dcf2e6eb4084fd6a6af747bdfada8919886d1ed8b9438c297a"),
        text=SourceFile("word2vec_10000_200d_labels.tsv", "8d6b7a5c141379420581ffed8df38c3ec8ee61241fa28cd287ccb4ad44bb2a49"),
        parse_text=parse_words_tsv,
        # 単語ベクトルの UMAP は、MNIST のような大きさの揃った塊にならず、密度が連続的に変わる。
        # 既定の coarse（minClusterSize 200, minSamples 5）では 10 クラスタ・ノイズ 52% になるため、
        # 塊を小さく取り（minClusterSize 150）、核になる点の数を減らして（minSamples 2）、18 クラスタ・ノイズ 31.5% にする
        cluster_overrides={"coarse": {"minClusterSize": 150, "minSamples": 2}},
        probe_words=("one", "france", "red", "monday", "music", "dog", "computer", "water"),
    ),
}
