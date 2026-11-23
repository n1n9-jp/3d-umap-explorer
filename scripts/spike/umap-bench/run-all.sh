#!/usr/bin/env bash
# 計測の全工程（所要 約 1 時間。ほかの重い処理を同時に走らせないこと）。
#   scripts/spike/umap-bench/ で  ./run-all.sh
set -euo pipefail
cd "$(dirname "$0")"

# 1. 依存と Python 環境
npm ci
[ -x .cache/venv/bin/python ] || python3 -m venv .cache/venv
.cache/venv/bin/pip install -q -r ../../precompute/requirements.txt

# 2. kNN グラフ（厳密 kNN k=50、umap-learn の内部 kNN との一致率、7万点の合成データ）
.cache/venv/bin/python make_knn.py --big

# 3. ページのビルドとバンドルサイズ
npx vite build
node size.cjs

# 4. 計測（ブラウザ、Node）。結果は results/*.json に追記される（--force で取り直し）
node bench.cjs
node bench-node.cjs

# 5. 機能の確認、WebGPU の有無、結果の質、表の生成
node features.mjs
node webgpu-check.cjs
.cache/venv/bin/python quality.py
node report.cjs > results/report.md
