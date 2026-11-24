import { describe, expect, it } from 'vitest';
import { wordVertexShader } from './shaders';

/** シェーダは WebGL なしでは動かせないので、累乗の底を正に保つ構造（奥行きの判定と下限）をソースで確かめる。実機の描画は scripts/verify/words.cjs。 */
describe('文字の頂点シェーダ（カメラの後ろの単語）', () => {
  const src = wordVertexShader;
  it('奥行き（-mv.z）が正でない単語は、累乗より前に、頂点をクリップ空間の外へ出して返る', () => {
    const guard = src.indexOf('!(depth > DEPTH_EPSILON)');
    const power = src.indexOf('pow(');
    expect(guard).toBeGreaterThan(0);
    expect(power).toBeGreaterThan(guard);
    const between = src.slice(guard, power);
    expect(between).toContain('gl_Position = vec4(2.0, 2.0, 2.0, 1.0)');
    expect(between).toContain('return;');
  });
  it('累乗の底（自然な高さ ÷ 基準）は、自然な高さに正の下限を置いて、常に正にする', () => {
    expect(src).toMatch(/float natural = max\(.*NATURAL_EPSILON\)/);
    expect(src).toMatch(/const float NATURAL_EPSILON = 1e-6/);
    expect(src).toMatch(/pow\(natural \/ uTextSize\.x, uTextSize\.y\)/);
  });
  it('点群のシェーダと同じく、奥行きの下限と近接フェードの判定を使う', () => {
    expect(src).toContain('nearFadeAt(dist)');
    expect(src).toContain('pxPerUnitAt(depth)');
  });
});
