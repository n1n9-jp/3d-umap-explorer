# 3D UMAP Explorer

3次元UMAPの点群の「内部」にカメラが入り込み、一人称視点で飛び回って探索するWebアプリです。
[Embedding Projector](https://github.com/tensorflow/embedding-projector-standalone) の俯瞰型の表示に対して、空間の中を移動する体験を目指します。

現在は試作段階です。最初のデータセットは MNIST 1万点（各点が 28x28 の手書き数字画像）です。

## 構成

| パス | 役割 |
|---|---|
| `scripts/precompute/` | UMAPの事前計算（Python）。高次元ベクトルから3次元座標を作り、`public/data/` へ書き出す |
| `public/data/<dataset>/` | アプリが読み込む配信用データ（下記の形式） |
| `src/data/` | データセットの読み込み |
| `src/render/` | 点群の描画（インスタンス描画のビルボード） |
| `src/controls/` | 飛行カメラの操作 |
| `src/main.ts` | 起動処理と描画ループ |
| `scripts/verify/` | ヘッドレスブラウザによるスクリーンショット検証 |

アプリは Vite + TypeScript + three.js、テストは Vitest です。UMAPはブラウザでは計算せず、事前計算した座標を配信します。

## データ形式

`public/data/<dataset>/` に次のファイルを置きます。数値バイナリはすべてリトルエンディアンです。

| ファイル | 内容 |
|---|---|
| `manifest.json` | メタデータ（下記） |
| `positions.f32` | `Float32Array`、長さ `3 * count`。点 `i` の座標は `[3i, 3i+1, 3i+2]` に x, y, z の順で入る |
| `labels.u8` | `Uint8Array`、長さ `count`。値は `manifest.labels.names` の添字（`manifest.labels` があるときのみ） |
| `sprite.png` | 画像アトラス。点 `i` の画像は、列 `i % columns`、行 `floor(i / columns)` のセル（左上が原点） |
| `clusters-coarse.u16`, `clusters-fine.u16` | `Uint16Array`、長さ `count`。点ごとのクラスタ `id`（粗い階層・細かい階層）。どのクラスタにも属さない点は `65535`（`manifest.clusters.noise`） |

座標は、バウンディングボックスの中心が原点、絶対値の最大が 1 になるように、等方スケールで正規化します（全点が `[-1, 1]` の立方体に収まる）。

`manifest.json` の例（空間の構造の計算では、`labels` は任意です。ラベルのないデータセットでは `labels` を書かず、`labels.u8` も置きません）：

```json
{
  "name": "MNIST 10k",
  "count": 10000,
  "positions": { "file": "positions.f32", "dtype": "float32", "components": 3 },
  "labels": { "file": "labels.u8", "dtype": "uint8", "names": ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] },
  "sprite": { "file": "sprite.png", "cellSize": [28, 28], "columns": 100, "rows": 100 },
  "umap": { "library": "umap-learn 0.6.0", "nComponents": 3, "nNeighbors": 15, "minDist": 0.1, "metric": "euclidean", "randomState": 42, "compatibilityLayout": true },
  "source": { "url": "https://github.com/tensorflow/embedding-projector-standalone", "commit": "6ff71f7233ac5947450409e7938b58ec14d1e24c" }
}
```

### 空間の構造（`bounds` / `density` / `overview` / `clusters`）

`scripts/precompute/add_structure.py` が、座標とラベル（あれば）から次の項目を計算して `manifest.json` へ追記します。HDBSCAN のパラメータは、引数でデータセットごとに上書きできます（`scripts/precompute/README.md`）。座標は 3 次元UMAPの正規化後の値（上記）で、距離はすべてその座標系でのユークリッド距離です。

```json
{
  "bounds": { "center": [0, 0, 0], "radius": 1.139497 },
  "density": { "k": 8, "knnDistP05": 0.008562, "knnDistP50": 0.015665, "knnDistP95": 0.028776 },
  "overview": { "axes": [[0.935867, 0.243862, 0.254331], [-0.237131, 0.969787, -0.057293], [-0.260618, -0.006691, 0.965419]] },
  "clusters": {
    "method": "hdbscan",
    "noise": 65535,
    "levels": [
      { "name": "coarse", "params": { "minClusterSize": 200, "minSamples": 5, "maxClusterSize": 1500, "selectionMethod": "eom" },
        "pointFile": "clusters-coarse.u16",
        "clusters": [
          { "id": 0, "name": "1", "size": 1227, "medoid": 1136, "center": [0.87786, -0.365438, 0.117857], "radius": 0.362873,
            "bbox": [[0.729318, -0.539207, -0.264238], [0.992441, -0.218288, 0.528759]], "majorityLabel": 1, "purity": 0.920945, "parent": null }
        ] },
      { "name": "fine", "params": { "…": "…" }, "pointFile": "clusters-fine.u16", "clusters": [ "…" ] }
    ]
  }
}
```

| 項目 | 内容 |
|---|---|
| `bounds` | 全点を含む球。`center` はバウンディングボックスの中心（小数第6位に丸めた値）、`radius` は、その丸めた `center` から最も遠い点までの距離（小数第6位を切り上げ）。書かれた `center` と `radius` で全点が球に含まれる |
| `density` | 各点の 8 近傍（自分自身を除く）までの距離の平均について、全点での 5・50・95 パーセンタイル。周囲の疎密の目安 |
| `overview` | 座標の主成分分析の第 1〜第 3 軸（単位ベクトル、第 1 軸から順に分散が大きい）。符号は、第 1・第 2 軸は絶対値が最大の成分が正、第 3 軸は第 1 軸×第 2 軸（右手系） |
| `clusters.method` | クラスタリング手法。scikit-learn の HDBSCAN を 3 次元座標に適用する |
| `clusters.noise` | どのクラスタにも属さない点の値（`65535`） |
| `clusters.levels[]` | 階層（`coarse` → `fine` の順）。`params` は実際に使った HDBSCAN のパラメータ（`maxClusterSize` は `null` のとき上限なし）、`pointFile` は点ごとのクラスタ `id` のファイル、`clusters` はクラスタの一覧 |

クラスタ（`clusters.levels[].clusters[]`）の各項目：

| 項目 | 内容 |
|---|---|
| `id` | 階層ごとに、点数の多い順（同数なら先頭の点の番号が小さい順）に 0 から振る。`pointFile` の値と一致する |
| `name` | 多数派ラベルの名前（`labels.names`）。同じ階層で多数派ラベルが同じクラスタが複数あるときは、点数が最大のものをそのままの名前にし、以降を点数の多い順に `3 (2)`、`3 (3)` とする。`manifest.labels` がないときは、階層ごとの連番 `C1`、`C2`、…（`id` の順） |
| `size` | クラスタの点数 |
| `medoid` | クラスタ内の他の全点への距離の合計が最小になる、実在の点の番号（同値なら番号の小さい方）。`center` はその点の座標 |
| `radius` | medoid からクラスタ内の各点までの距離の 90 パーセンタイル |
| `bbox` | クラスタ内の点のバウンディングボックス `[[最小x,y,z],[最大x,y,z]]` |
| `majorityLabel`, `purity` | クラスタ内で最も多いラベルの番号（同数なら小さい方）と、その割合。`manifest.labels` がないときは両方 `null` |
| `parent` | 細かい階層では、そのクラスタの点が最も多く属する粗い階層のクラスタの `id`（粗い階層のノイズは数えない。点がすべて粗い階層のノイズのときは、medoid に最も近い、粗いクラスタに属する点のクラスタ）。粗い階層では `null` |

MNIST 1 万点では、粗い階層が 10 クラスタ（数字ごとに 1 つ、ノイズ 8.3%）、細かい階層が 67 クラスタ（ノイズ 25.2%）です。細かい階層は、小さな塊を拾う設定のため、塊の周縁の点がノイズになりやすくなっています。

## データの出典

MNIST 1万点のベクトル・ラベル・スプライト画像は、[tensorflow/embedding-projector-standalone](https://github.com/tensorflow/embedding-projector-standalone) の `oss_data/` にあるファイルを使います。元データは [MNIST database](http://yann.lecun.com/exdb/mnist/)（Yann LeCun, Corinna Cortes, Christopher J.C. Burges）です。
