import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// embedding-atlas の package.json は "." / "./react" / "./svelte" だけを exports に持ち、
// UMAP の入口 dist/umap.js は公開されていない。計測では実ファイルへ alias を張って取り込む。
const atlasUmap = fileURLToPath(new URL('./node_modules/embedding-atlas/dist/umap.js', import.meta.url));

export default defineConfig({
  root: '.',
  base: './',
  resolve: { alias: { '@atlas-umap': atlasUmap } },
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // 本体・Worker それぞれのサイズを見るため、ミニファイは既定（esbuild/oxc）のまま
    minify: true,
  },
});
