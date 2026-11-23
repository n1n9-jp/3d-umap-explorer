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
