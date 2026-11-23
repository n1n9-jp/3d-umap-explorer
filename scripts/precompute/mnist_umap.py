#!/usr/bin/env python3
"""互換のための入口。`build_dataset.py mnist` と同じ（MNIST 1万点の配信用データを作り直す）。

    python scripts/precompute/mnist_umap.py
"""

import sys

import build_dataset

if __name__ == "__main__":
    sys.exit(build_dataset.main(["mnist"]))
