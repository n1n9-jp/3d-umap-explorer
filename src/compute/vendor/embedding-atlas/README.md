# embedding-atlas の UMAP（WebAssembly）の同梱

ブラウザ内の UMAP の計算（`src/compute/umapWorker.ts`）に使う、[embedding-atlas](https://github.com/apple/embedding-atlas)（Apple、MIT）の UMAP の部分です。npm パッケージ `embedding-atlas@0.26.0` の `dist/` から、次の 3 ファイルを**変更せずに**コピーしました。

| ファイル | 内容 | SHA-256 |
|---|---|---|
| `umap.js` | 入口（`createUMAP`・`createUMAPFromKNN`・`createNNDescent` を再エクスポートするだけ） | `71ee4a756e847d34d260ef1285a7542ef798a03f29a1bbff4fb1d0bdd5ad2d5c` |
| `chunk-Bn3LaujC.js` | 本体。Rust 製の UMAP を wasm-bindgen で WebAssembly にしたもの。Wasm は base64 の data URI で埋め込まれている（別ファイルの配信は不要） | `00f5c0cd603af4e7e91206bd70d1cf5e9520e270d784a435f0f53e2124fbe5b0` |
| `umap.d.ts` | 型定義 | `3579608fcf764c203840d66b612f675a1e1f612fa418bae0f8b6c9c00d1dd5c7` |
| `LICENSE` | 上流のリポジトリのタグ `v0.26.0` の `LICENSE`（MIT、Copyright (c) 2025 Apple Inc.）。npm パッケージには LICENSE ファイルが含まれないため、<https://raw.githubusercontent.com/apple/embedding-atlas/v0.26.0/LICENSE> から取得した | — |

## 依存として入れずにコピーした理由

- `dist/umap.js` は、パッケージの `package.json` の `exports`（`.`・`./react`・`./svelte`）に含まれないため、依存として入れても、深い import（Vite の alias）で実ファイルを指す必要があります。
- パッケージ全体を入れると、必須の `peerDependencies`（`@uwdata/*`、`@duckdb/duckdb-wasm` など）も入り、`node_modules` が約 100 MB 増えます。実際に使うのは上の 2 ファイル（約 1.3 MB）だけです。
- コピーなら、版が固定され、`npm ci` の時間と容量が増えず、ビルドの設定（alias）も要りません。

## 更新の手順

```sh
npm pack embedding-atlas@<版>        # 作業用のディレクトリで
tar xzf embedding-atlas-<版>.tgz
cp package/dist/{umap.js,umap.d.ts} src/compute/vendor/embedding-atlas/
cp package/dist/<umap.js が import するチャンク> src/compute/vendor/embedding-atlas/
```

チャンクの名前は版ごとに変わります（`umap.js` の `import` を見る）。古いチャンクを消し、この README の版と SHA-256 を更新し、上流の LICENSE を確認してから、`npm test`（`src/compute/atlasUmap.test.ts` が、実際に小さな UMAP を計算して座標が出ることを確かめる）と `node scripts/verify/umap.cjs` を実行してください。

## ライセンスについての注意

WebAssembly の本体には、上流の Rust のコードと、その依存のクレートがコンパイルされて入っています。上流のリポジトリ全体は MIT ですが、依存のクレートごとのライセンスは、上流の `Cargo.lock` を参照してください（このリポジトリでは個別に確認していません）。
