# scripts/precompute

MNIST 1万点（784次元）から3次元UMAP座標を事前計算し、`public/data/mnist/` へ配信用データ一式（座標、ラベル、スプライト、空間の構造）を書き出します。
データ形式はリポジトリ直下の README.md の「データ形式」を参照してください。

## 再生成の手順

Python 3.13 で確認しています。`git` が使えて、GitHub へ HTTPS で接続できる必要があります。

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/precompute/requirements.txt
.venv/bin/python scripts/precompute/mnist_umap.py
```

- 入力（`oss_data/` の3ファイル、約35MB）は、固定コミットから `scripts/precompute/.cache/` へ取得します。3ファイルの SHA-256 はスクリプトに持ち、取得直後と `.cache/` の再利用時に照合します。一致しないファイルは取得し直します（取得し直すために `.cache/` を消す必要はありません）。`.cache/` へは一時ファイルへ書いてから名前を変えるので、途中で切れたファイルが残りません。
- UMAPは `random_state=42`、`n_jobs=1`（単一スレッド）で計算します（約40秒〜1分）。同じ環境では同じ座標になります。
- `umap-learn` 0.6 の既定値が将来変わっても結果が変わらないよう、`compatibility_layout=True`（0.5系と同じ処理）に固定しています。この値は manifest の `umap.compatibilityLayout` に記録します。
- 座標とラベルのあと、続けて「空間の構造の追加」（下記）まで実行するので、このコマンド1回で配信用データ一式が再生成されます。`add_structure.py` を別に実行する必要はありません。
- 配信用データは、作業用ディレクトリ（`public/data/` の下の `.mnist-staging-*`）に一式を作り、スプライトの検証と空間の構造の検証がすべて済んでから `public/data/mnist/` へ移します。途中で失敗しても `public/data/mnist/` は実行前のまま残り、作業用ディレクトリは消えます。
- 最後に、座標の範囲、ラベル件数、3次元での10近傍の同ラベル率、最近傍点間距離の分布を表示します。

## 空間の構造の追加（`add_structure.py`）

配信用データに、全体の範囲（`bounds`）、密度（`density`）、俯瞰の向き（`overview`）、クラスタ（`clusters`）を追加します。項目の意味はリポジトリ直下の README.md の「データ形式」を参照してください。`mnist_umap.py` が最後にこの処理を呼ぶので、通常は単独で実行する必要はありません。既存のデータセットの構造だけを計算し直したいときに、次のように単独で実行できます。

```sh
.venv/bin/python scripts/precompute/add_structure.py public/data/mnist
```

- 引数は、`manifest.json`・`positions.f32` があるデータセットのディレクトリです。`manifest.json` に `labels` があるときは `labels.u8` も読みます。`positions.f32` と `labels.u8` は読むだけで、書き換えません。
- ラベルのないデータセット（`manifest.json` に `labels` がない）でも動きます。クラスタの `majorityLabel` と `purity` は `null`、`name` は階層ごとの連番（`C1`、`C2`、…。`id` の順）になります。
- `manifest.json` へ `bounds` / `density` / `overview` / `clusters` を書き加え、点ごとのクラスタ番号を `clusters-coarse.u16`・`clusters-fine.u16` として同じディレクトリへ書き出します。再実行すると、これらの項目を計算し直して置き換えます（他の項目はそのまま）。
- 書き出しは、すべてのファイルを一時ファイル（同じディレクトリの `.<名前>.<pid>.tmp`）へ書き終えてから名前を変えて置き換え、`manifest.json` を最後に置き換えます。一時ファイルへの書き込み中に失敗しても、ディレクトリのファイルは実行前のまま残ります（一時ファイルは消えます）。階層の構成が変わって使われなくなった `clusters-*.u16` は、`manifest.json` の置き換えのあとに削除します。
- 結果は決定的です。同じ入力で 2 回実行すると、書き出したファイルがすべて一致します。
- クラスタリングは scikit-learn の HDBSCAN（`requirements.txt` の scikit-learn で動きます）を 3 次元座標に適用します。階層ごとのパラメータは `add_structure.py` の `LEVELS` にあり、点数に依存する値は全点数に対する割合で持つので、同じ形式の別のデータセットにも使えます。MNIST 1 万点では次の値を使います。

  | 階層 | minClusterSize | minSamples | maxClusterSize | 選択方法 | 結果 |
  |---|---|---|---|---|---|
  | coarse | 200（点数の 2%） | 5 | 1500（15%） | eom | 10 クラスタ、ノイズ 8.3% |
  | fine | 40（0.4%） | 2 | 500（5%） | eom | 67 クラスタ、ノイズ 25.2% |

  `maxClusterSize` を置くのは、3 次元UMAPの座標では隣り合う数字が 1 つの塊につながり、既定のままでは粗い階層が 7 クラスタになり、最も混ざったクラスタの純度が 0.35 まで下がるためです。上限を数字 1 つ分程度にすると、数字ごとの塊に分かれます。
- **パラメータの上書き**: 階層ごとのパラメータは、次の引数でデータセットごとに上書きできます。値は整数（点数に対する割合ではなく、実際の点数）で、指定しなかったものは上の既定値（点数に対する割合から計算）のままです。実際に使った値は `manifest.json` の `clusters.levels[].params` に残ります。

  | 引数 | 内容 |
  |---|---|
  | `--coarse-min-cluster-size N` / `--fine-min-cluster-size N` | `minClusterSize`（2 以上） |
  | `--coarse-min-samples N` / `--fine-min-samples N` | `minSamples`（1 以上） |
  | `--coarse-max-cluster-size N` / `--fine-max-cluster-size N` | `maxClusterSize`。`0` で上限なし（`params` では `null`） |

  ```sh
  .venv/bin/python scripts/precompute/add_structure.py public/data/<dataset> --coarse-max-cluster-size 4000 --fine-min-cluster-size 100
  ```
- **上限による塊の消失の警告**: HDBSCAN（eom 方式）は、`maxClusterSize` を超えるクラスタを採用せず、そのクラスタに採用できる子がなければ、点をすべてノイズにします。点数の割合で決めた上限は、塊の大きさが違うデータセットでは大きな塊を丸ごと消すことがあるため、各階層で同じ階層を上限なしでも計算し、上限なしでは上限を超える 1 つのクラスタだった点のうち、上限ありでノイズになった点が半分を超える塊を、標準エラー出力へ警告します（実行の最後に表示。終了コードは 0 のままで、書き出す内容は変わりません）。警告には、その塊の点数・重心・ノイズになった点数と、上限を上書きする引数が含まれます。警告が出たら、`--<階層名>-max-cluster-size` を警告の点数以上にするか `0` にして実行し直してください。上限を超えるクラスタの点が半分以下しかノイズにならず、残りが子クラスタに分かれた場合は、上限が意図どおり塊を分けているものとして警告しません。
- 最後に、全体の範囲・密度・主成分軸と、階層ごとのクラスタ一覧（`id`、`name`、`size`、`purity`、`radius`、`parent`）、ノイズの割合を表示します。medoid が自分のクラスタに属すること、`parent` と `pointFile` の値が範囲内であることは、スクリプトの中で確かめ、満たさなければ異常終了します。
- 距離の合計で求める medoid は、クラスタ内の点数の 2 乗に比例する計算量です（1 クラスタ数万点まで想定）。
