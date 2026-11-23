import { describe, expect, it } from 'vitest';
import { WASM_SIMD_HINT, describeComputeError, describeWorkerError, looksLikeWasmFailure } from './workerError';

describe('Worker の失敗の文', () => {
  it('Worker のエラーは、ブラウザの文が空でも、原因（読み込めない・SIMD）が分かる文になる', () => {
    expect(describeWorkerError('')).toContain('Worker を読み込めない');
    expect(describeWorkerError(undefined)).toContain(WASM_SIMD_HINT);
    expect(describeWorkerError('Uncaught CompileError: v128')).toContain('（Uncaught CompileError: v128）');
  });
  it('Wasm の失敗らしい文にだけ、SIMD の説明を添える', () => {
    expect(looksLikeWasmFailure('WebAssembly.instantiate(): invalid value type v128')).toBe(true);
    expect(looksLikeWasmFailure('kNN グラフがまだ届いていません')).toBe(false);
    expect(describeComputeError('kNN グラフがまだ届いていません')).toBe('kNN グラフがまだ届いていません');
    expect(describeComputeError('CompileError: wasm validation error')).toContain(WASM_SIMD_HINT);
  });
});
