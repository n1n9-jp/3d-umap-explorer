/**
 * 文字単位の SDF のグリフアトラスを、ブラウザの Canvas で実行時に作る。
 *
 * データセットの単語に出てくる文字だけを、1 枚の canvas に棚詰めで描き（fillText）、アルファを読んで
 * 文字ごとに SDF（src/text/sdf.ts）へ変える。結果は 1 チャンネル（R8）の画像と、文字ごとの UV・送り幅・
 * ベースラインからの位置（src/text/layout.ts の GlyphInfo）。日本語などの文字の多いデータセットでも、
 * 1 枚（最大 4096×4096）に収まる範囲で使える（40px のグリフで約 6000 字）。
 */
import { alphaToSdf } from './sdf';
import { packShelves, type FontMetrics, type GlyphInfo } from './layout';

export interface GlyphAtlasOptions {
  /** グリフを描く大きさ（canvas のピクセル） */
  fontSize: number;
  /** SDF の余白（ピクセル）。縁取りとアンチエイリアスの分より広くする */
  buffer: number;
  /** SDF の距離の幅（ピクセル） */
  radius: number;
  /** 輪郭の位置（0..1） */
  cutoff: number;
  fontFamily: string;
  fontWeight: string;
  /** アトラスの最大の大きさ（1 辺） */
  maxSize: number;
}

export const DEFAULT_ATLAS_OPTIONS: GlyphAtlasOptions = {
  fontSize: 40,
  buffer: 9,
  radius: 12,
  cutoff: 0.25,
  // 欧文は読みやすいサンセリフ、和文は各 OS のゴシック体
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Hiragino Sans', 'Noto Sans CJK JP', 'Noto Sans JP', 'Yu Gothic', Meiryo, sans-serif",
  fontWeight: '600',
  maxSize: 4096,
};

export interface GlyphAtlas {
  width: number;
  height: number;
  /** SDF（行優先、上の行から。0..255） */
  data: Uint8Array;
  glyphs: Map<string, GlyphInfo>;
  /** アトラスにない文字の代わり（'?'） */
  fallback: GlyphInfo | undefined;
  metrics: FontMetrics;
  options: GlyphAtlasOptions;
  /** 生成にかかった時間（ミリ秒） */
  buildMs: number;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createContext(doc: Document | null, w: number, h: number): Ctx2D {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    if (c) return c;
  }
  if (!doc) throw new Error('Canvas を作れません');
  const canvas = doc.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  if (!c) throw new Error('Canvas 2D を使えません');
  return c;
}

/** `chars` の文字のグリフアトラスを作る。 */
export function buildGlyphAtlas(chars: readonly string[], doc: Document | null,
  options: Partial<GlyphAtlasOptions> = {}): GlyphAtlas {
  const t0 = performance.now();
  const o = { ...DEFAULT_ATLAS_OPTIONS, ...options };
  const S = o.fontSize, buf = o.buffer;
  const font = `${o.fontWeight} ${S}px ${o.fontFamily}`;
  const all = [...new Set([...chars, '?', 'H'])];

  // 寸法を測る（測るだけの小さな canvas）
  const probe = createContext(doc, 8, 8);
  probe.font = font;
  probe.textBaseline = 'alphabetic';
  const measured = all.map((c) => {
    const m = probe.measureText(c);
    const left = Math.ceil(Math.max(0, m.actualBoundingBoxLeft));
    const right = Math.ceil(Math.max(0, m.actualBoundingBoxRight));
    const ascent = Math.ceil(Math.max(0, m.actualBoundingBoxAscent));
    const descent = Math.ceil(Math.max(0, m.actualBoundingBoxDescent));
    const gw = left + right, gh = ascent + descent;
    const blank = gw <= 0 || gh <= 0 || /^\s$/u.test(c);
    return {
      c, advance: m.width, left, ascent, gw, gh, blank,
      ink: { left: -m.actualBoundingBoxLeft / S, right: m.actualBoundingBoxRight / S, top: m.actualBoundingBoxAscent / S, bottom: -m.actualBoundingBoxDescent / S },
    };
  });
  const drawn = measured.filter((g) => !g.blank);
  const pack = packShelves(drawn.map((g) => ({ w: g.gw + 2 * buf, h: g.gh + 2 * buf })), o.maxSize);
  const W = pack.width, H = pack.height;

  // まとめて描いて、1 回で読む
  const ctx = createContext(doc, W, H);
  ctx.clearRect(0, 0, W, H);
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  drawn.forEach((g, k) => {
    const p = pack.positions[k]!;
    ctx.fillText(g.c, p.x + buf + g.left, p.y + buf + g.ascent);
  });
  const rgba = ctx.getImageData(0, 0, W, H).data;

  const data = new Uint8Array(W * H);
  const glyphs = new Map<string, GlyphInfo>();
  drawn.forEach((g, k) => {
    const p = pack.positions[k]!;
    const cw = g.gw + 2 * buf, ch = g.gh + 2 * buf;
    const alpha = new Uint8ClampedArray(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) alpha[y * cw + x] = rgba[4 * ((p.y + y) * W + p.x + x) + 3]!;
    const sdf = alphaToSdf(alpha, cw, ch, o.radius, o.cutoff);
    for (let y = 0; y < ch; y++) data.set(sdf.subarray(y * cw, (y + 1) * cw), (p.y + y) * W + p.x);
    glyphs.set(g.c, {
      advance: g.advance / S,
      quad: { x: -(g.left + buf) / S, y: (g.ascent + buf - ch) / S, width: cw / S, height: ch / S },
      uv: { u0: p.x / W, v0: p.y / H, u1: (p.x + cw) / W, v1: (p.y + ch) / H },
      ink: g.ink,
    });
  });
  for (const g of measured) {
    if (!g.blank) continue;
    glyphs.set(g.c, { advance: g.advance / S, quad: { x: 0, y: 0, width: 0, height: 0 }, uv: { u0: 0, v0: 0, u1: 0, v1: 0 }, ink: { left: 0, right: 0, top: 0, bottom: 0 } });
  }
  const capHeight = glyphs.get('H')?.ink.top ?? 0.7;
  return { width: W, height: H, data, glyphs, fallback: glyphs.get('?'), metrics: { capHeight }, options: o, buildMs: performance.now() - t0 };
}
