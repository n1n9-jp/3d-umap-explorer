// kNN グラフの先頭 n 列を切り出す（行優先、row i の近傍が昇順）
export function sliceKnn(idxAll, distAll, count, kAll, n) {
  const idx = new Int32Array(count * n);
  const dist = new Float32Array(count * n);
  for (let i = 0; i < count; i++) {
    const s = i * kAll, d = i * n;
    for (let j = 0; j < n; j++) {
      idx[d + j] = idxAll[s + j];
      dist[d + j] = distAll[s + j];
    }
  }
  return { idx, dist };
}

// 再現性のある乱数（mulberry32）。umap-js の random に渡す
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// マクロタスクへ制御を戻す（Worker が onmessage を処理できるようにする）。
// await だけ（マイクロタスク）では、Worker はメッセージを受け取れない。
export function yieldToEventLoop() {
  return new Promise((resolve) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => { c.port1.close(); resolve(); };
    c.port2.postMessage(0);
  });
}
