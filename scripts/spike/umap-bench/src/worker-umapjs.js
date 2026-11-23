import { runUmapJs } from './umapjs-run.js';

const evalMs = performance.now();
postMessage({ type: 'ready', evalMs });

let cancelFlag = false;

onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'cancel') { cancelFlag = true; return; }
  if (m.type !== 'run') return;
  cancelFlag = false;
  try {
    const t0 = performance.now();
    const r = await runUmapJs({
      ...m.params,
      idx: m.idx,
      dist: m.dist,
      onProgress: (done, total) => postMessage({ type: 'progress', done, total }),
      shouldCancel: () => cancelFlag,
    });
    const totalMs = performance.now() - t0;
    const mem = typeof performance.memory === 'object' && performance.memory ? { jsHeapUsed: performance.memory.usedJSHeapSize } : null;
    postMessage({ type: 'result', ...r, totalMs, mem }, [r.embedding.buffer]);
  } catch (e) {
    postMessage({ type: 'error', message: String(e && e.stack ? e.stack : e) });
  }
};
