/** リトルエンディアンの数値バイナリを型付き配列へ変換する。 */

const hostIsLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export class BinaryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinaryFormatError';
  }
}

/** float32 LE のバッファを長さ検証つきで Float32Array にする。 */
export function decodeFloat32LE(buffer: ArrayBuffer, expectedLength: number, label = 'float32'): Float32Array {
  if (buffer.byteLength !== expectedLength * 4) {
    throw new BinaryFormatError(
      `${label}: バイト長 ${buffer.byteLength} が期待値 ${expectedLength * 4}（${expectedLength} 要素）と一致しません`,
    );
  }
  if (hostIsLittleEndian) return new Float32Array(buffer.slice(0));
  const view = new DataView(buffer);
  const out = new Float32Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** uint8 のバッファを長さ検証つきで Uint8Array にする。 */
export function decodeUint8(buffer: ArrayBuffer, expectedLength: number, label = 'uint8'): Uint8Array {
  if (buffer.byteLength !== expectedLength) {
    throw new BinaryFormatError(`${label}: バイト長 ${buffer.byteLength} が期待値 ${expectedLength} と一致しません`);
  }
  return new Uint8Array(buffer.slice(0));
}
