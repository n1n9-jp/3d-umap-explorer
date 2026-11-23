import { describe, expect, it } from 'vitest';
import { PALETTE_SIZE, vertexShader } from './shaders';
import { LABEL_COLORS } from './palette';
import { MAX_LABELS } from '../data/manifest';

describe('ラベル色の参照', () => {
  it('パレットの大きさはラベル色の数と同じ', () => {
    expect(PALETTE_SIZE).toBe(LABEL_COLORS.length);
    expect(vertexShader).toContain(`uniform vec3 uPalette[${PALETTE_SIZE}];`);
  });
  it('読み込みが許すどのラベル（0..MAX_LABELS-1）とクラスタの番号（0..65534）でも、パレットの範囲内を読む', () => {
    // シェーダの式: clamp(int(label + 0.5), 0, 65535) % PALETTE_SIZE。負の番号（クラスタなし）はパレットを読まない
    expect(vertexShader).toContain(`uPalette[label % ${PALETTE_SIZE}]`);
    expect(vertexShader).toContain('clamp(int(instanceLabel + 0.5), 0, 65535)');
    expect(vertexShader).toContain('if (instanceLabel < -0.5)');
    expect(MAX_LABELS).toBe(256); // ラベルは uint8、クラスタの番号は uint16 なので、clamp の上限 65535 で全てを覆う
  });
});
