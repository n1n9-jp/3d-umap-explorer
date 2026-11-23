# scripts/precompute

高次元ベクトルから3次元UMAP座標を事前計算し、`public/data/<dataset>/` へ配信用データ一式（座標、ラベル・スプライト・単語、空間の構造）を書き出します。
データ形式はリポジトリ直下の README.md の「データ形式」を参照してください。

| データセット | 内容 | 出力先 |
|---|---|---|
| `mnist` | MNIST 1万点（784次元、距離は euclidean）。ラベルとスプライト画像あり | `public/data/mnist/` |
| `word2vec-10k` | word2vec 1万語（200次元、距離は cosine）。点ごとに単語（`text.json`）あり、ラベルとスプライトなし | `public/data/word2vec-10k/` |

## 再生成の手順

Python 3.13 で確認しています。`git` が使えて、GitHub へ HTTPS で接続できる必要があります。

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/precompute/requirements.txt
.venv/bin/python scripts/precompute/build_dataset.py mnist          # MNIST 1万点
.venv/bin/python scripts/precompute/build_dataset.py word2vec-10k   # word2vec 1万語
```

`scripts/precompute/mnist_umap.py` は、互換のために残した入口で、`build_dataset.py mnist` と同じ処理をします。

- **構成**: データセットごとの違い（入力ファイルと SHA-256、点数と次元、距離の種類、ラベル・スプライト・単語の有無、出力先、クラスタのパラメータの上書き、検証で近傍を表示する単語）は `datasets.py` の設定にあり、取得・照合・UMAP・正規化・検証・作業用ディレクトリ経由の書き出し・`add_structure.py` の呼び出しは `build_dataset.py` に1つだけあります。データセットを加えるときは `datasets.py` に設定を足します。
- 入力（`oss_data/` のファイル。MNIST は3ファイル約35MB、word2vec は2ファイル約8MB）は、固定コミットから `scripts/precompute/.cache/` へ取得します。SHA-256 は `datasets.py` に持ち、取得直後と `.cache/` の再利用時に照合します。一致しないファイルは取得し直します（取得し直すために `.cache/` を消す必要はありません）。`.cache/` へは一時ファイルへ書いてから名前を変えるので、途中で切れたファイルが残りません。
- UMAPは `n_components=3`、`n_neighbors=15`、`min_dist=0.1`、`random_state=42`、`n_jobs=1`（単一スレッド）で計算します（MNIST は約40秒〜1分、word2vec は約40秒）。距離（`metric`）だけデータセットごとに変わります（MNIST は euclidean、word2vec は cosine）。同じ環境では同じ座標になります。
- `umap-learn` 0.6 の既定値が将来変わっても結果が変わらないよう、`compatibility_layout=True`（0.5系と同じ処理）に固定しています。この値は manifest の `umap.compatibilityLayout` に記録します。
- 座標・ラベル・スプライト・単語のあと、続けて「空間の構造の追加」（下記）まで実行するので、このコマンド1回で配信用データ一式が再生成されます。`add_structure.py` を別に実行する必要はありません。
- 配信用データは、作業用ディレクトリ（`public/data/` の下の `.<出力先>-staging-*`）に一式を作り、スプライトの検証と空間の構造の検証がすべて済んでから `public/data/<出力先>/` へ移します。途中で失敗しても出力先は実行前のまま残り、作業用ディレクトリは消えます。
- 最後に、座標の範囲、ファイルの大きさ、最近傍点間距離の分布、元の空間での10近傍と3次元での10近傍の重なり（全点平均）、クラスタリングの警告の数を表示します。ラベルがあるデータセットは3次元での10近傍の同ラベル率、単語のデータセットは `text.json` が入力の単語と順序まで一致するかと、いくつかの単語の3次元での近傍10語も表示します。
- word2vec は、2回生成して出力が完全に一致することを確かめています。

### 入力の形式（word2vec）

- ベクトル: `word2vec_10000_200d_tensors.bytes`。float32 リトルエンディアン、10000 x 200（8,000,000バイト）。
- 単語の一覧: `word2vec_10000_200d_labels.tsv`。ヘッダー行 `word<TAB>count` のあとに 10000 行（`単語<TAB>出現数`）。行の順がベクトルの順。全語が ASCII で重複がなく、先頭の語は特殊トークンの `UNK`。`text.json` には単語の列（出現数は含めない）を、この順で書きます。

### word2vec のクラスタのパラメータ

単語ベクトルのUMAPは、MNIST のように大きさの揃った10個の塊にならず、密度が連続的に変わります。既定のパラメータ（coarse: `minClusterSize` 200、`minSamples` 5）では、粗い階層が 10 クラスタ、ノイズ 52.1% になり、地域としては粗すぎ、半分の点がどこにも属しません。そこで `datasets.py` の `cluster_overrides` で coarse だけを上書きしています（fine は既定のまま）。

| 階層 | minClusterSize | minSamples | maxClusterSize | 結果 |
|---|---|---|---|---|
| coarse | 150（既定 200） | 2（既定 5） | 1500（既定のまま） | 18 クラスタ、ノイズ 31.5%、警告なし |
| fine | 40（既定） | 2（既定） | 500（既定のまま） | 66 クラスタ、ノイズ 30.3%、警告なし |

- coarse の候補を `minClusterSize` 40〜400、`minSamples` 1〜20、`maxClusterSize` 1500〜上限なしで走査しました。`minClusterSize` を下げるとクラスタが増えて小さくなり（`minSamples` 2 で、60 で 42、100 で 27、150 で 18、200 で 11、300 で 9 クラスタ）、`minSamples` を下げるとノイズが減ります（150 では `minSamples` 5 で 44.2%、2 で 31.5%）。`minSamples` を 1 にしても 2 と同じ結果でした。走査した範囲で、クラスタが 10〜30 個になる設定のノイズは 31% を下回りませんでした（`minClusterSize` 400 で上限なしにすると 23% まで下がりますが、5,600 点の 1 クラスタに併合され 4 クラスタになります）。
- 粗い階層を「空間の大まかな地域」として使える 10〜30 個に収めつつ、塊の大きさ（最大 1003、最小 153 点）を極端に偏らせない値として、`minClusterSize` 150 を選びました（100 は 27 クラスタで小さな地域が増え、200 は 11 クラスタで大きな塊が広がります）。
- `maxClusterSize`（既定 1500）は、この設定では結果を変えません（最大のクラスタが 1003 点）。`minClusterSize` を 400 にすると、上限を超える塊が丸ごとノイズになり警告が出ます（走査で確認）。
- `cluster_selection_epsilon`（近い塊を併合する指定）は、0.01 と 0.02 では結果が変わらず（`minClusterSize` 60・`minSamples` 2・`maxClusterSize` 1500）、0.04 では scikit-learn 1.9.1 が `max_cluster_size` との併用で例外を出したため、使っていません。

## 空間の構造の追加（`add_structure.py`）

配信用データに、全体の範囲（`bounds`）、密度（`density`）、俯瞰の向き（`overview`）、クラスタ（`clusters`）を追加します。項目の意味はリポジトリ直下の README.md の「データ形式」を参照してください。`build_dataset.py` が最後にこの処理を呼ぶので、通常は単独で実行する必要はありません。既存のデータセットの構造だけを計算し直したいときに、次のように単独で実行できます。

```sh
.venv/bin/python scripts/precompute/add_structure.py public/data/mnist
```

- 引数は、`manifest.json`・`positions.f32` があるデータセットのディレクトリです。`manifest.json` に `labels` があるときは `labels.u8` を、`text` があるときは `text.json` も読みます。`positions.f32`・`labels.u8`・`text.json` は読むだけで、書き換えません。
- ラベルのないデータセット（`manifest.json` に `labels` がない）でも動きます。クラスタの `majorityLabel` と `purity` は `null` になります。`name` は、`text`（点ごとの単語）があれば代表の単語を `、` で並べた文字列（`terms` に単語の配列も付く）、なければ階層ごとの連番（`C1`、`C2`、…。`id` の順）です。
- **代表の単語**（`text` があるとき）: クラスタ内の点を medoid に近い順（同じ距離なら番号の小さい順）に見て、表示に向く単語を 3 語選びます。向かない単語は、1〜2 文字の語、文字以外（数字・記号）を含む語（語中の `'` と `-` は可）、特殊トークン `UNK` です。クラスタ内に向く単語がなければ `C1`、`C2`、… にします。
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
