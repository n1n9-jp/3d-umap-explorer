/**
 * グリフの情報と、単語の組み立て（文字の列と単語全体の大きさ）。DOM に依存しない。
 *
 * 長さの単位は em（フォントの大きさを 1 とする）。y は上向き。グリフの位置は、ペンの位置（送り幅を積んだ位置）と
 * ベースラインからのずれで表す。
 */

/** 1 文字のグリフ。 */
export interface GlyphInfo {
  /** 送り幅 */
  advance: number;
  /** 描く四角形（SDF の余白を含む）。ペンの位置・ベースラインから、左下の角までのずれと大きさ。幅 0 なら描かない（空白） */
  quad: { x: number; y: number; width: number; height: number };
  /** アトラス上の位置（UV。v は下向きで、v0 が上端） */
  uv: { u0: number; v0: number; u1: number; v1: number };
  /** インクの範囲（ペンの位置・ベースラインから。left は負なら左へはみ出す） */
  ink: { left: number; right: number; top: number; bottom: number };
}

/** フォント全体の寸法。 */
export interface FontMetrics {
  /** 大文字の高さ（'H' のインクの高さ）。単語の縦の位置合わせに使う */
  capHeight: number;
}

/** 組み立てた単語の 1 文字。 */
export interface PlacedGlyph {
  char: string;
  glyph: GlyphInfo;
  /** 単語の基準点（点の位置）から、この文字のペンの位置までの横のずれ */
  x: number;
}

/** 組み立てた単語。 */
export interface WordLayout {
  /** 描く文字（空白など描かない文字は含めない） */
  glyphs: PlacedGlyph[];
  /** 単語全体の送り幅 */
  advance: number;
  /** ベースラインの高さ（基準点から。大文字の高さの中央が基準点に来るよう、-capHeight / 2） */
  baseline: number;
  /** インクの範囲（基準点から）。文字がなければすべて 0 */
  ink: { left: number; right: number; top: number; bottom: number };
}

/** 1 つの単語で組み立てる文字の上限。超える分は省略する（長い文字列が画面を覆わないように）。 */
export const MAX_WORD_CHARS = 32;

/** 文字列を文字（コードポイント）の列に分ける。サロゲートペアを 1 文字として扱う。 */
export function splitChars(text: string): string[] {
  return Array.from(text);
}

/** 単語の集合に出てくる文字の集合（出てきた順、重複なし）。 */
export function collectChars(words: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const w of words) {
    let n = 0;
    for (const c of w) {
      if (++n > MAX_WORD_CHARS) break;
      seen.add(c);
    }
  }
  return [...seen];
}

/**
 * 単語を組み立てる。送り幅を積んだ位置に文字を並べ、単語の送り幅の中央が基準点に来るように横へずらす。
 * 縦は、大文字の高さの中央が基準点に来るように、ベースラインを下げる。アトラスにない文字は `fallback`
 * （省略時は飛ばす）で置き換える。
 */
export function layoutWord(text: string, glyphs: ReadonlyMap<string, GlyphInfo>, metrics: FontMetrics,
  fallback?: GlyphInfo): WordLayout {
  const chars = splitChars(text).slice(0, MAX_WORD_CHARS);
  const placed: PlacedGlyph[] = [];
  let pen = 0;
  for (const c of chars) {
    const g = glyphs.get(c) ?? fallback;
    if (!g) continue;
    placed.push({ char: c, glyph: g, x: pen });
    pen += g.advance;
  }
  const shift = -pen / 2;
  const baseline = -metrics.capHeight / 2;
  let left = Infinity, right = -Infinity, top = -Infinity, bottom = Infinity;
  const visible: PlacedGlyph[] = [];
  for (const p of placed) {
    p.x += shift;
    if (p.glyph.quad.width <= 0) continue; // 空白
    visible.push(p);
    left = Math.min(left, p.x + p.glyph.ink.left);
    right = Math.max(right, p.x + p.glyph.ink.right);
    top = Math.max(top, baseline + p.glyph.ink.top);
    bottom = Math.min(bottom, baseline + p.glyph.ink.bottom);
  }
  const ink = visible.length ? { left, right, top, bottom } : { left: 0, right: 0, top: 0, bottom: 0 };
  return { glyphs: visible, advance: pen, baseline, ink };
}

/** 矩形を棚に詰める（高い順に左から並べ、幅を超えたら次の棚）。DOM に依存しない。 */
export interface PackResult {
  width: number;
  height: number;
  /** 入力の順の、左上の位置 */
  positions: { x: number; y: number }[];
}

/**
 * 大きさ sizes の矩形を、幅と高さが 2 の累乗の 1 枚に詰める（間隔 `gap` 画素）。`maxSize` を超えるなら例外。
 * 幅は、面積の合計から正方形に近くなるように選ぶ。
 */
export function packShelves(sizes: readonly { w: number; h: number }[], maxSize = 4096, gap = 1): PackResult {
  let area = 0, widest = 1;
  for (const s of sizes) { area += (s.w + gap) * (s.h + gap); widest = Math.max(widest, s.w + gap); }
  let width = 64;
  while (width < maxSize && (width * width < area * 1.15 || width < widest)) width *= 2;
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b]!.h - sizes[a]!.h || a - b);
  const positions: { x: number; y: number }[] = new Array(sizes.length);
  let x = 0, y = 0, shelf = 0;
  for (const i of order) {
    const s = sizes[i]!;
    if (s.w + gap > width) throw new Error(`グリフ（幅 ${s.w}）がアトラスの幅 ${width} に入りません`);
    if (x + s.w + gap > width) { y += shelf; x = 0; shelf = 0; }
    positions[i] = { x, y };
    x += s.w + gap;
    shelf = Math.max(shelf, s.h + gap);
  }
  const used = y + shelf;
  let height = 64;
  while (height < used) height *= 2;
  if (height > maxSize) throw new Error(`文字の種類が多く、グリフアトラス（最大 ${maxSize}×${maxSize}）に入りません`);
  return { width, height, positions };
}
