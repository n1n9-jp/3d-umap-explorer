import { describe, expect, it } from 'vitest';
import { BinaryFormatError, decodeFloat32LE, decodeUint8 } from './binary';

describe('decodeFloat32LE', () => {
  it('リトルエンディアンの float32 を読む', () => {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    [0.5, -1, 0.25].forEach((v, i) => view.setFloat32(i * 4, v, true));
    expect(Array.from(decodeFloat32LE(buf, 3))).toEqual([0.5, -1, 0.25]);
  });

  it('長さが合わなければエラー', () => {
    expect(() => decodeFloat32LE(new ArrayBuffer(8), 3)).toThrow(BinaryFormatError);
  });
});

describe('decodeUint8', () => {
  it('長さを検証して読む', () => {
    expect(Array.from(decodeUint8(new Uint8Array([1, 2, 3]).buffer, 3))).toEqual([1, 2, 3]);
    expect(() => decodeUint8(new ArrayBuffer(2), 3)).toThrow(BinaryFormatError);
  });
});
