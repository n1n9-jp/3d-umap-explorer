# scripts/precompute

MNIST 1万点（784次元）から3次元UMAP座標を事前計算し、`public/data/mnist/` へ配信用データを書き出します。
データ形式はリポジトリ直下の README.md の「データ形式」を参照してください。

## 再生成の手順

Python 3.13 で確認しています。`git` が使えて、GitHub へ HTTPS で接続できる必要があります。

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/precompute/requirements.txt
.venv/bin/python scripts/precompute/mnist_umap.py
```

- 入力（`oss_data/` の3ファイル、約35MB）は、固定コミットから `scripts/precompute/.cache/` へ取得します。取得済みなら再利用します。取得し直すには `.cache/` を消してください。
- UMAPは `random_state=42` で計算します（単一スレッド、約40秒〜1分）。同じ環境では同じ座標になります。
- 最後に、座標の範囲、ラベル件数、3次元での10近傍の同ラベル率、最近傍点間距離の分布を表示します。
- `umap-learn` 0.6 の既定値が将来変わっても結果が変わらないよう、`compatibility_layout=True`（0.5系と同じ処理）に固定しています。

## 空間の構造の追加（`add_structure.py`）

配信用データに、全体の範囲（`bounds`）、密度（`density`）、俯瞰の向き（`overview`）、クラスタ（`clusters`）を追加します。項目の意味はリポジトリ直下の README.md の「データ形式」を参照してください。座標の計算（`mnist_umap.py`）が済んだ後に実行します。

```sh
.venv/bin/python scripts/precompute/add_structure.py public/data/mnist
```

- 引数は、`manifest.json`・`positions.f32`・`labels.u8` があるデータセットのディレクトリです。`positions.f32` と `labels.u8` は読むだけで、書き換えません。
- `manifest.json` へ `bounds` / `density` / `overview` / `clusters` を書き加え、点ごとのクラスタ番号を `clusters-coarse.u16`・`clusters-fine.u16` として同じディレクトリへ書き出します。再実行すると、これらの項目を計算し直して置き換えます（他の項目はそのまま）。
- 結果は決定的です。同じ入力で 2 回実行すると、書き出したファイルがすべて一致します。
- クラスタリングは scikit-learn の HDBSCAN（`requirements.txt` の scikit-learn で動きます）を 3 次元座標に適用します。階層ごとのパラメータは `add_structure.py` の `LEVELS` にあり、点数に依存する値は全点数に対する割合で持つので、同じ形式の別のデータセットにも使えます。MNIST 1 万点では次の値を使います。

  | 階層 | minClusterSize | minSamples | maxClusterSize | 選択方法 | 結果 |
  |---|---|---|---|---|---|
  | coarse | 200（点数の 2%） | 5 | 1500（15%） | eom | 10 クラスタ、ノイズ 8.3% |
  | fine | 40（0.4%） | 2 | 500（5%） | eom | 67 クラスタ、ノイズ 25.2% |

  `maxClusterSize` を置くのは、3 次元UMAPの座標では隣り合う数字が 1 つの塊につながり、既定のままでは粗い階層が 7 クラスタになり、最も混ざったクラスタの純度が 0.35 まで下がるためです。上限を数字 1 つ分程度にすると、数字ごとの塊に分かれます。
- 最後に、全体の範囲・密度・主成分軸と、階層ごとのクラスタ一覧（`id`、`name`、`size`、`purity`、`radius`、`parent`）、ノイズの割合を表示します。medoid が自分のクラスタに属すること、`parent` と `pointFile` の値が範囲内であることは、スクリプトの中で確かめ、満たさなければ異常終了します。
- 距離の合計で求める medoid は、クラスタ内の点数の 2 乗に比例する計算量です（1 クラスタ数万点まで想定）。
