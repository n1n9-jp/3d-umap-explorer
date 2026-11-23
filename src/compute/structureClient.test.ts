import { describe, expect, it } from 'vitest';
import type { StructureReply, StructureRequest } from './protocol';
import { StructureAborted, startStructureJob, type StructureWorkerLike } from './structureClient';
import { handleStructureRequest } from './structureRun';
import { computeStructure } from './structure';

function cloud(n: number): Float32Array {
  const p = new Float32Array(3 * n);
  let s = 99;
  for (let i = 0; i < p.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; p[i] = s / 4294967296 - 0.5; }
  return p;
}

/** Worker の代わり。受け取った依頼を `handleStructureRequest` で（別のタスクで）処理して返す。 */
class FakeWorker implements StructureWorkerLike {
  onmessage: StructureWorkerLike['onmessage'] = null;
  onerror: StructureWorkerLike['onerror'] = null;
  terminated = false;
  received: StructureRequest | null = null;
  constructor(private readonly mode: 'ok' | 'hang' | 'error-reply' | 'throw' = 'ok') {}
  postMessage(message: StructureRequest): void {
    this.received = message;
    if (this.mode === 'hang') return;
    setTimeout(() => {
      if (this.terminated) return;
      if (this.mode === 'throw') { this.onerror?.({ message: 'boom', preventDefault() {} }); return; }
      const reply: StructureReply = this.mode === 'error-reply'
        ? { type: 'error', message: 'だめ' }
        : handleStructureRequest(structuredClone(message)).reply;
      this.onmessage?.({ data: reply });
    }, 0);
  }
  terminate(): void { this.terminated = true; }
}

describe('handleStructureRequest（Worker の中の処理）', () => {
  it('computeStructure と同じ値を返し、空間索引の配列を transfer の対象にする', () => {
    const p = cloud(500);
    const labels = Uint8Array.from({ length: 500 }, (_, i) => i % 3);
    const { reply, transfer } = handleStructureRequest({ type: 'structure', positions: p, labels, names: ['a', 'b', 'c'] });
    const want = computeStructure(p, labels, ['a', 'b', 'c']);
    expect(reply.type).toBe('done');
    if (reply.type !== 'done') return;
    expect(reply.bounds).toEqual(want.bounds);
    expect(reply.density).toEqual(want.density);
    expect(reply.overview).toEqual(want.overview);
    expect(reply.groups).toEqual(want.groups);
    expect(transfer.length).toBe(5);
    expect(Array.from(reply.index.ids)).toEqual(Array.from(want.index.toData().ids));
  });

  it('座標に NaN があれば、例外にせずエラーの返信にする', () => {
    const p = cloud(10);
    p[4] = NaN;
    const { reply } = handleStructureRequest({ type: 'structure', positions: p, labels: null, names: null });
    expect(reply.type).toBe('error');
  });
});

describe('startStructureJob（メインスレッドの窓口）', () => {
  it('Worker の結果を返し、空間索引は座標に結びつけて、構築し直さない。Worker は止め、座標は書き換えない', async () => {
    const p = cloud(800);
    const keep = new Float32Array(p);
    const w = new FakeWorker();
    const job = startStructureJob(p, null, null, () => w);
    const r = await job.promise;
    const want = computeStructure(p, null, null);
    expect(r.bounds).toEqual(want.bounds);
    expect(r.density).toEqual(want.density);
    expect(r.groups).toBeNull();
    const q = [0.1, -0.2, 0.3] as const;
    expect(Array.from(r.index.kNearest(q[0], q[1], q[2], 7).indices)).toEqual(Array.from(want.index.kNearest(q[0], q[1], q[2], 7).indices));
    expect(w.terminated).toBe(true);
    expect(Array.from(p)).toEqual(Array.from(keep));
    expect(w.received!.positions).not.toBe(p); // コピーを渡す
  });

  it('abort で、StructureAborted で拒否し、Worker を止める', async () => {
    const w = new FakeWorker('hang');
    const job = startStructureJob(cloud(100), null, null, () => w);
    job.abort();
    await expect(job.promise).rejects.toBeInstanceOf(StructureAborted);
    expect(w.terminated).toBe(true);
    job.abort(); // 二度呼んでも害はない
  });

  it('終わったあとの abort は何もしない', async () => {
    const job = startStructureJob(cloud(100), null, null, () => new FakeWorker());
    await job.promise;
    job.abort();
    await expect(job.promise).resolves.toBeDefined();
  });

  it('Worker の onerror、エラーの返信、Worker を作れないときは、エラーで拒否する（打ち切りではない）', async () => {
    for (const mode of ['throw', 'error-reply'] as const) {
      const w = new FakeWorker(mode);
      const err = await startStructureJob(cloud(50), null, null, () => w).promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StructureAborted);
      expect(w.terminated).toBe(true);
    }
    const err = await startStructureJob(cloud(50), null, null, () => { throw new Error('作れない'); }).promise.catch((e: unknown) => e);
    expect((err as Error).message).toBe('作れない');
  });
});
