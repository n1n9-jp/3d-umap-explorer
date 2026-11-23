import { describe, expect, it } from 'vitest';
import { collectChars, layoutWord, MAX_WORD_CHARS, packShelves, splitChars, type GlyphInfo } from './layout';

/** 送り幅 advance、インクが [0, advance] × [0, 0.7] の文字 */
const glyph = (advance: number, ink: Partial<GlyphInfo['ink']> = {}): GlyphInfo => ({
  advance,
  quad: { x: -0.2, y: -0.4, width: advance + 0.4, height: 1.3 },
  uv: { u0: 0, v0: 0, u1: 1, v1: 1 },
  ink: { left: 0, right: advance, top: 0.7, bottom: 0, ...ink },
});
const space: GlyphInfo = { advance: 0.25, quad: { x: 0, y: 0, width: 0, height: 0 }, uv: { u0: 0, v0: 0, u1: 0, v1: 0 }, ink: { left: 0, right: 0, top: 0, bottom: 0 } };
const glyphs = new Map<string, GlyphInfo>([
  ['a', glyph(0.5)], ['b', glyph(0.6)], ['g', glyph(0.5, { bottom: -0.2 })], [' ', space], ['日', glyph(1)], ['?', glyph(0.4)],
]);
const metrics = { capHeight: 0.7 };

describe('splitChars・collectChars', () => {
  it('サロゲートペアを 1 文字として扱う', () => {
    expect(splitChars('a𠮷b')).toEqual(['a', '𠮷', 'b']);
  });
  it('出てくる文字の集合（重複なし、出てきた順）', () => {
    expect(collectChars(['abba', 'cab', '日本'])).toEqual(['a', 'b', 'c', '日', '本']);
  });
});

describe('layoutWord（単語の組み立て）', () => {
  it('送り幅を積んだ位置に並べ、送り幅の中央を基準点にする', () => {
    const l = layoutWord('ab', glyphs, metrics);
    expect(l.advance).toBeCloseTo(1.1);
    expect(l.glyphs.map((g) => g.char)).toEqual(['a', 'b']);
    expect(l.glyphs[0]!.x).toBeCloseTo(-0.55);
    expect(l.glyphs[1]!.x).toBeCloseTo(-0.05);
    expect(l.ink.left).toBeCloseTo(-0.55);
    expect(l.ink.right).toBeCloseTo(0.55);
  });
  it('大文字の高さの中央が基準点に来るように、ベースラインを下げる', () => {
    const l = layoutWord('ab', glyphs, metrics);
    expect(l.baseline).toBeCloseTo(-0.35);
    expect(l.ink.top).toBeCloseTo(0.35);
    expect(l.ink.bottom).toBeCloseTo(-0.35);
    expect(layoutWord('ag', glyphs, metrics).ink.bottom).toBeCloseTo(-0.55); // ディセンダ
  });
  it('空白は送り幅だけを進め、描く文字に含めない', () => {
    const l = layoutWord('a b', glyphs, metrics);
    expect(l.glyphs.map((g) => g.char)).toEqual(['a', 'b']);
    expect(l.advance).toBeCloseTo(1.35);
    expect(l.glyphs[1]!.x - l.glyphs[0]!.x).toBeCloseTo(0.75);
  });
  it('アトラスにない文字は代わりの文字で置き換える（なければ飛ばす）', () => {
    expect(layoutWord('aZ', glyphs, metrics, glyphs.get('?')).glyphs.map((g) => g.char)).toEqual(['a', 'Z']);
    expect(layoutWord('aZ', glyphs, metrics).glyphs.map((g) => g.char)).toEqual(['a']);
  });
  it('長すぎる単語は MAX_WORD_CHARS 文字で打ち切る。空の単語は文字なし', () => {
    expect(layoutWord('a'.repeat(100), glyphs, metrics).glyphs).toHaveLength(MAX_WORD_CHARS);
    const empty = layoutWord('', glyphs, metrics);
    expect(empty.glyphs).toHaveLength(0);
    expect(empty.ink).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
});

describe('packShelves（アトラスへの棚詰め）', () => {
  it('重ならず、幅と高さが 2 の累乗の 1 枚に収まる', () => {
    const sizes = Array.from({ length: 300 }, (_, i) => ({ w: 20 + (i % 17), h: 30 + (i % 11) }));
    const p = packShelves(sizes);
    expect(Math.log2(p.width) % 1).toBe(0);
    expect(Math.log2(p.height) % 1).toBe(0);
    for (let i = 0; i < sizes.length; i++) {
      const a = p.positions[i]!, sa = sizes[i]!;
      expect(a.x + sa.w).toBeLessThanOrEqual(p.width);
      expect(a.y + sa.h).toBeLessThanOrEqual(p.height);
      for (let j = i + 1; j < sizes.length; j++) {
        const b = p.positions[j]!, sb = sizes[j]!;
        const overlap = a.x < b.x + sb.w && b.x < a.x + sa.w && a.y < b.y + sb.h && b.y < a.y + sa.h;
        expect(overlap).toBe(false);
      }
    }
  });
  it('文字の多いデータセット（58px のセルで 3000 字）も 1 枚に入る。入らなければ例外', () => {
    const cjk = Array.from({ length: 3000 }, () => ({ w: 58, h: 58 }));
    const p = packShelves(cjk, 4096);
    expect(p.width).toBeLessThanOrEqual(4096);
    expect(p.height).toBeLessThanOrEqual(4096);
    expect(() => packShelves(cjk, 1024)).toThrow();
  });
});
