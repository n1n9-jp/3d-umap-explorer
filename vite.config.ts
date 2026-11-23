import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 相対パスで配信し、サブディレクトリに置いても動くようにする
  base: './',
  // UMAP の Worker（src/compute/umapWorker.ts）は ES モジュールとして別のチャンクにする（使うときにだけ読み込む）
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // three.js 本体だけで 500kB を超えるため、警告の閾値を上げる
    chunkSizeWarningLimit: 1000,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
