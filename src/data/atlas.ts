/**
 * 画像アトラスのセル配置と UV 計算。
 *
 * UV は「テクスチャを flipY=false で読み込んだ」前提で、v=0 が画像の上端になる。
 * 点 i のセルは、列 i % columns、行 floor(i / columns)（左上が原点）。
 * アトラス画像が columns*cellSize より大きい（余白がある）場合にも対応するため、
 * セル幅は画像の実寸から求める。
 */

export interface AtlasLayout {
  columns: number;
  rows: number;
  /** 1セルの幅・高さ（UV 単位） */
  cellU: number;
  cellV: number;
}

export function atlasLayout(
  sprite: { cellSize: [number, number]; columns: number; rows: number },
  imageWidth: number,
  imageHeight: number,
): AtlasLayout {
  const [cw, ch] = sprite.cellSize;
  if (sprite.columns * cw > imageWidth || sprite.rows * ch > imageHeight) {
    throw new Error(
      `アトラス画像 ${imageWidth}x${imageHeight} が ${sprite.columns}x${sprite.rows} セル（${cw}x${ch}px）を収められません`,
    );
  }
  return { columns: sprite.columns, rows: sprite.rows, cellU: cw / imageWidth, cellV: ch / imageHeight };
}

/** 点 index のセル左上の UV を返す。 */
export function cellOrigin(index: number, layout: AtlasLayout): [number, number] {
  const col = index % layout.columns;
  const row = Math.floor(index / layout.columns);
  return [col * layout.cellU, row * layout.cellV];
}

/** 全点のセル左上 UV を [u0, v0, u1, v1, ...] の Float32Array で返す（インスタンス属性用）。 */
export function cellOrigins(count: number, layout: AtlasLayout): Float32Array {
  if (count > layout.columns * layout.rows) throw new Error('点の数がアトラスのセル数を超えています');
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    out[i * 2] = (i % layout.columns) * layout.cellU;
    out[i * 2 + 1] = Math.floor(i / layout.columns) * layout.cellV;
  }
  return out;
}

/**
 * アトラスの地の色から「インク」の向きを判定する。
 * 外周の平均輝度（0..1）が 0.5 より明るければ白地に黒インクとみなし、インク = 1 − 輝度。
 */
export function inkIsDark(borderMeanLuma: number): boolean {
  return borderMeanLuma > 0.5;
}
