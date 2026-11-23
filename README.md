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
| `labels.u8` | `Uint8Array`、長さ `count`。値は `manifest.labels.names` の添字 |
| `sprite.png` | 画像アトラス。点 `i` の画像は、列 `i % columns`、行 `floor(i / columns)` のセル（左上が原点） |

座標は、バウンディングボックスの中心が原点、絶対値の最大が 1 になるように、等方スケールで正規化します（全点が `[-1, 1]` の立方体に収まる）。

`manifest.json` の例：

```json
{
  "name": "MNIST 10k",
  "count": 10000,
  "positions": { "file": "positions.f32", "dtype": "float32", "components": 3 },
  "labels": { "file": "labels.u8", "dtype": "uint8", "names": ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] },
  "sprite": { "file": "sprite.png", "cellSize": [28, 28], "columns": 100, "rows": 100 },
  "umap": { "library": "umap-learn 0.6.0", "nComponents": 3, "nNeighbors": 15, "minDist": 0.1, "metric": "euclidean", "randomState": 42 },
  "source": { "url": "https://github.com/tensorflow/embedding-projector-standalone", "commit": "6ff71f7233ac5947450409e7938b58ec14d1e24c" }
}
```

## データの出典

MNIST 1万点のベクトル・ラベル・スプライト画像は、[tensorflow/embedding-projector-standalone](https://github.com/tensorflow/embedding-projector-standalone) の `oss_data/` にあるファイルを使います。元データは [MNIST database](http://yann.lecun.com/exdb/mnist/)（Yann LeCun, Corinna Cortes, Christopher J.C. Burges）です。
