import * as THREE from 'three';
import { PALETTE_SIZE, fragmentShader, highlightFragmentShader, highlightVertexShader, vertexShader } from './shaders';
import { BACKGROUND_COLOR, hexToRgb, labelColors } from './palette';
import { NOISE_COLOR } from './colorScheme';
import { INTERIOR_FOG } from './fog';

/** 描画パラメータ。距離はワールド単位（座標は [-1, 1] の立方体）。 */
export interface PointCloudParams {
  /** ビルボード1辺の大きさ */
  pointSize: number;
  /** 画面上の最小サイズ（CSS ピクセル。描画バッファへは pixelRatio を掛けて渡す） */
  minPixelSize: number;
  /** 画面上の大きさ（CSS ピクセル）がこの範囲で丸い点から数字へ切り替わる [点, 数字] */
  digitPixelRange: [number, number];
  /** 近接フェード [完全に消える距離, フェードが始まる距離]。pointSize に対する倍率 */
  nearFadeFactors: [number, number];
  /** 霧 [始まる距離, 1-1/e になるまでの距離, 上限] */
  fog: [number, number, number];
  /** 数字の縁取りの幅（インクの濃さの単位、0 で縁取りなし） */
  outline: number;
  /** 丸い点の半径 [セル幅に対する比, CSS ピクセルでの上限] */
  dotRadius: [number, number];
}

export const DEFAULT_PARAMS: PointCloudParams = {
  pointSize: 0.004,
  minPixelSize: 3,
  digitPixelRange: [8, 14],
  nearFadeFactors: [1.5, 5],
  fog: [...INTERIOR_FOG],
  outline: 0.22,
  dotRadius: [0.4, 2.2],
};

/**
 * 画像のないデータセット（すべて丸い点）での丸い点の半径の上限（CSS ピクセル）。直径 10 は、単語の文字の高さの下限（12、src/text/）より小さい。
 * 近くの点が大きな円盤の塊になって、その間の単語の文字より目立つことがないようにする。
 */
export const DOTS_ONLY_MAX_RADIUS_PX = 5;

/**
 * 画像のないデータセット（すべて丸い点）での既定値の差分。丸い点がビルボードの全体（半径 = 1 辺の半分）を占め、
 * 近くの点は画面上で半径 5 CSS ピクセル（直径 10）までの円になる（遠くの点は最小サイズ 3 ピクセルの点。その間は近いほど大きい）。
 */
export const DOTS_ONLY_PARAMS: Partial<PointCloudParams> = {
  dotRadius: [0.5, DOTS_ONLY_MAX_RADIUS_PX],
};

/**
 * 丸い点の倍率の属性を GPU へ送るとき、範囲 1 つ（`bufferSubData` 1 回）の手間を、送る要素の何個分とみなすか（1 KB 相当）。
 * 変えた点が散らばっていて範囲を分けるほうが高くつくときは、まとめて（全体を）送る。
 */
export const DOT_SCALE_CALL_COST = 256;
/** 範囲にまとめるときの、隙間のしきい値の候補（要素数） */
const DOT_SCALE_GAPS = [0, 8, 32, 128, 512, 2048, 8192];

/** 強調表示の種類。 */
export type HighlightKind = 'hover' | 'selected';

/** 強調表示の輪の見た目。ピクセルは CSS ピクセル（`setPixelRatio` の値を掛けて描画バッファの単位にする）。 */
const HIGHLIGHT_STYLE: Record<HighlightKind, { color: number; minRadius: number; line: number; outline: number; order: number }> = {
  hover: { color: 0xf2f5fa, minRadius: 7, line: 1.5, outline: 1.5, order: 1 },
  selected: { color: 0xffc233, minRadius: 9, line: 2.5, outline: 1.5, order: 2 },
};

/** 画像アトラス（点ごとの画像）。 */
export interface PointCloudAtlas {
  image: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
  /** 各点のセル左上 UV（長さ 2 * count） */
  cellOrigins: Float32Array;
  cellSize: [number, number];
  /** アトラスが白地に黒インクなら true */
  inkIsDark: boolean;
}

export interface PointCloudData {
  positions: Float32Array;
  /** 長さ count。点ごとの色の番号（src/render/colorScheme.ts。負ならクラスタなしの灰色） */
  colorIndices: Float32Array;
  /** 画像アトラス。なければすべての点を丸い点で描く（シェーダの DOTS_ONLY） */
  atlas?: PointCloudAtlas | null;
}

export class PointCloud {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  /**
   * GPU ピッキング用のマテリアル。描画用と同じシェーダを PICKING で分岐させ、点の番号を出力する。
   * ユニフォームは描画用と同じオブジェクトを共有する（uViewportHeight だけはピッキング側が描く領域に合わせて持つ）。
   */
  readonly pickingMaterial: THREE.ShaderMaterial;
  readonly params: PointCloudParams;
  /**
   * 強調表示（ホバー・選択）の輪。シーンへ点群のメッシュとは別に追加する。深度テストなしで点群の後に描くので、
   * ほかの点に隠れていても位置が分かる。ピッキングは点群のメッシュだけを描くので、選ばれる形は変わらない。
   */
  readonly highlight = new THREE.Group();
  /** 画像を持たず、すべての点を丸い点で描くか */
  readonly dotsOnly: boolean;
  private readonly texture: THREE.Texture | null;
  private readonly positions: Float32Array;
  private readonly highlightMeshes: Record<HighlightKind, THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>>;
  private readonly highlighted: Record<HighlightKind, number | null> = { hover: null, selected: null };
  private pixelRatio = 1;
  private dotScaleAttr: THREE.InstancedBufferAttribute | null = null;
  /** `setDotScale` で書き換えて、まだ GPU へ送っていない点（重複なし） */
  private dotDirty: Int32Array = new Int32Array(0);
  private dotDirtyCount = 0;
  private dotDirtyFlags: Uint8Array | null = null;
  private readonly dotUpload = { commits: 0, elements: 0, ranges: 0, lastElements: 0, lastRanges: 0 };

  constructor(data: PointCloudData, params: Partial<PointCloudParams> = {}) {
    const atlas = data.atlas ?? null;
    this.dotsOnly = atlas === null;
    this.params = { ...DEFAULT_PARAMS, ...(this.dotsOnly ? DOTS_ONLY_PARAMS : {}), ...params };
    const count = data.colorIndices.length;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('instancePosition', new THREE.InstancedBufferAttribute(data.positions, 3));
    geometry.setAttribute('instanceLabel', new THREE.InstancedBufferAttribute(data.colorIndices, 1));
    if (atlas) geometry.setAttribute('instanceCell', new THREE.InstancedBufferAttribute(atlas.cellOrigins, 2));
    else {
      // 丸い点の半径の倍率（単語の文字を出している点は 0 にして、文字と重ねない。src/text/）
      const scales = new Float32Array(count).fill(1);
      const attr = new THREE.InstancedBufferAttribute(scales, 1);
      attr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('instanceDotScale', attr);
      this.dotScaleAttr = attr;
      this.dotDirtyFlags = new Uint8Array(count);
    }
    geometry.instanceCount = count;
    // ビルボードはシェーダで広げるので、カリング用の境界は点群全体＋余白で十分
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);

    let texture: THREE.Texture | null = null;
    if (atlas) {
      texture = new THREE.Texture(atlas.image);
      texture.flipY = false;
      texture.colorSpace = THREE.NoColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
    }
    this.texture = texture;
    const defines: Record<string, string> = this.dotsOnly ? { DOTS_ONLY: '' } : {};

    // パレットはラベル数によらず PALETTE_SIZE 色。シェーダがラベル番号の余りで引く（10色の繰り返し）
    const palette = labelColors(PALETTE_SIZE).map((c) => new THREE.Vector3(...c));

    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      defines: { ...defines },
      uniforms: {
        uAtlas: { value: texture },
        uInkIsDark: { value: atlas?.inkIsDark ? 1 : 0 },
        uCellSize: { value: new THREE.Vector2(...(atlas?.cellSize ?? [0, 0])) },
        uPalette: { value: palette },
        uNoiseColor: { value: new THREE.Vector3(...hexToRgb(NOISE_COLOR)) },
        uBackground: { value: new THREE.Vector3(...hexToRgb(BACKGROUND_COLOR)) },
        uPointSize: { value: 0 },
        uMinPixelSize: { value: 0 },
        uViewportHeight: { value: 1 },
        uDigitPx: { value: new THREE.Vector2() },
        uNearFade: { value: new THREE.Vector2() },
        uFog: { value: new THREE.Vector3() },
        uOutline: { value: 0 },
        uDotRadius: { value: new THREE.Vector2() },
      },
      transparent: false,
      depthTest: true,
      depthWrite: true,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
    });

    this.pickingMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      defines: { ...defines, PICKING: '' },
      uniforms: { ...material.uniforms, uViewportHeight: { value: 1 } },
      transparent: false,
      blending: THREE.NoBlending,
      depthTest: true,
      depthWrite: true,
      alphaToCoverage: false,
      dithering: false,
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;

    this.positions = data.positions;
    const ringQuad = new THREE.PlaneGeometry(1, 1);
    const makeRing = (kind: HighlightKind) => {
      const style = HIGHLIGHT_STYLE[kind];
      const m = new THREE.Mesh(ringQuad, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: highlightVertexShader,
        fragmentShader: highlightFragmentShader,
        defines: { ...defines },
        uniforms: {
          // 画面上の大きさは点群と同じ式で求めるので、ユニフォームを共有する
          uPointSize: material.uniforms.uPointSize!,
          uMinPixelSize: material.uniforms.uMinPixelSize!,
          uViewportHeight: material.uniforms.uViewportHeight!,
          uBackground: material.uniforms.uBackground!,
          uDotRadius: material.uniforms.uDotRadius!,
          uCenter: { value: new THREE.Vector3() },
          uColor: { value: new THREE.Vector3(...hexToRgb(`#${style.color.toString(16).padStart(6, '0')}`)) },
          uRing: { value: new THREE.Vector3() },
          uBox: { value: new THREE.Vector4() },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = 10 + style.order; // 選択の輪をホバーの輪より手前に
      this.highlight.add(m);
      return m;
    };
    this.highlightMeshes = { hover: makeRing('hover'), selected: makeRing('selected') };
    this.applyHighlightStyle();
    this.applyParams();
  }

  /** 強調表示する点を設定する（null で消す）。ホバーと選択が同じ点のときは、選択の輪だけを描く。 */
  setHighlight(kind: HighlightKind, index: number | null): void {
    const valid = index !== null && Number.isInteger(index) && index >= 0 && 3 * index + 2 < this.positions.length;
    this.highlighted[kind] = valid ? index : null;
    for (const k of ['hover', 'selected'] as const) {
      const i = this.highlighted[k];
      const mesh = this.highlightMeshes[k];
      mesh.visible = i !== null && !(k === 'hover' && i === this.highlighted.selected);
      if (i !== null) {
        (mesh.material.uniforms.uCenter!.value as THREE.Vector3).set(
          this.positions[3 * i]!, this.positions[3 * i + 1]!, this.positions[3 * i + 2]!);
      }
    }
  }

  /**
   * 強調表示を、輪の代わりに単語の文字を囲む矩形にする（null で輪に戻す）。
   * box は [半分の幅, 半分の高さ, 中心の横のずれ, 縦のずれ]（ビュー空間のワールド単位。点の位置からのずれ）。
   */
  setHighlightBox(kind: HighlightKind, box: readonly [number, number, number, number] | null): void {
    const v = this.highlightMeshes[kind].material.uniforms.uBox!.value as THREE.Vector4;
    if (box) v.set(box[0], box[1], box[2], box[3]);
    else v.set(0, 0, 0, 0);
  }

  /**
   * 丸い点の半径の倍率（画像のないデータセットだけ。長さ count、既定 1）。読み取り用: 書き換えは `setDotScale` で行う。
   * 単語の文字を出している点を 0 にして、文字と丸い点を重ねない（ピッキングも同じ形になる）。
   */
  get dotScales(): Float32Array | null {
    return (this.dotScaleAttr?.array as Float32Array | undefined) ?? null;
  }

  /** 点 `index` の丸い点の倍率を書き換える（値が変わったときだけ、GPU へ送る対象に加える）。`commitDotScales()` で送る。 */
  setDotScale(index: number, value: number): void {
    const attr = this.dotScaleAttr, flags = this.dotDirtyFlags;
    if (!attr || !flags) return;
    const scales = attr.array as Float32Array;
    const v = Math.fround(value); // 属性は Float32。倍精度の値のまま比べると、同じ値でも毎回「変わった」ことになる
    if (scales[index] === v) return;
    scales[index] = v;
    if (flags[index]) return;
    flags[index] = 1;
    if (this.dotDirtyCount === this.dotDirty.length) {
      const bigger = new Int32Array(Math.max(256, this.dotDirty.length * 2));
      bigger.set(this.dotDirty);
      this.dotDirty = bigger;
    }
    this.dotDirty[this.dotDirtyCount++] = index;
  }

  /**
   * `setDotScale` で変えた点だけを GPU へ送る（変えていなければ何も送らない）。
   * 変えた点の添字を並べ、隣り合う点の間の隙間（要素数）がしきい値以内なら 1 つの範囲にまとめる。まとめるしきい値は、
   * 「範囲 1 つあたりの呼び出しの手間（`DOT_SCALE_CALL_COST` 要素分）× 範囲の数 + 送る要素数」が最小になるものを、候補から選ぶ
   * （変えた点が少なければ範囲ごとに細かく、多ければまとめて、全体の半分を超えるなら全体を 1 回で送る）。
   */
  commitDotScales(): void {
    const attr = this.dotScaleAttr, flags = this.dotDirtyFlags;
    const n = this.dotDirtyCount;
    if (!attr || !flags || n === 0) return;
    const list = this.dotDirty.subarray(0, n);
    list.sort();
    const total = (attr.array as Float32Array).length;
    // しきい値の候補ごとに、範囲の数と送る要素数を数えて、費用が最小のものを選ぶ
    let bestGap = -1, bestCost = DOT_SCALE_CALL_COST + total, bestElements = total, bestRanges = 1;
    for (const gap of DOT_SCALE_GAPS) {
      let ranges = 1, elements = 1, end = list[0]! + 1;
      for (let k = 1; k < n; k++) {
        const i = list[k]!;
        if (i - end <= gap) { elements += i + 1 - end; end = i + 1; } else { ranges++; elements++; end = i + 1; }
      }
      const cost = ranges * DOT_SCALE_CALL_COST + elements;
      if (cost < bestCost) { bestCost = cost; bestGap = gap; bestElements = elements; bestRanges = ranges; }
    }
    attr.clearUpdateRanges();
    if (bestGap >= 0) {
      let start = list[0]!, end = start + 1;
      for (let k = 1; k < n; k++) {
        const i = list[k]!;
        if (i - end <= bestGap) end = i + 1;
        else { attr.addUpdateRange(start, end - start); start = i; end = i + 1; }
      }
      attr.addUpdateRange(start, end - start);
    }
    attr.needsUpdate = true;
    for (let k = 0; k < n; k++) flags[list[k]!] = 0;
    this.dotDirtyCount = 0;
    const u = this.dotUpload;
    u.commits++; u.elements += bestElements; u.ranges += bestRanges; u.lastElements = bestElements; u.lastRanges = bestRanges;
  }

  /** 倍率の属性の GPU への送信の累計（検証・計測用）。要素は Float32（4 バイト）。 */
  getDotScaleUploadStats(): { commits: number; elements: number; ranges: number; lastElements: number; lastRanges: number; total: number } {
    return { ...this.dotUpload, total: this.dotScaleAttr ? (this.dotScaleAttr.array as Float32Array).length : 0 };
  }

  /** 強調表示されている点の番号。 */
  getHighlight(kind: HighlightKind): number | null {
    return this.highlighted[kind];
  }

  /**
   * 描画バッファの画素 / CSS ピクセル。画面上の大きさのパラメータ（最小サイズ、数字への切り替え範囲、丸い点の半径の上限、
   * 輪の太さ）に掛けて、pixelRatio によらず同じ見かけの大きさにする。ピッキングと輪はユニフォームを共有するので、同じ値になる。
   */
  setPixelRatio(ratio: number): void {
    if (!(ratio > 0) || !Number.isFinite(ratio)) return;
    this.pixelRatio = ratio;
    this.applyParams();
    this.applyHighlightStyle();
  }

  /** `setPixelRatio` で設定した倍率。 */
  getPixelRatio(): number {
    return this.pixelRatio;
  }

  /** 画面上の最小サイズ（描画バッファの画素）。シェーダに渡している値。 */
  minPixelSizeInBuffer(): number {
    return this.params.minPixelSize * this.pixelRatio;
  }

  private applyHighlightStyle(): void {
    const r = this.pixelRatio;
    for (const k of ['hover', 'selected'] as const) {
      const s = HIGHLIGHT_STYLE[k];
      (this.highlightMeshes[k].material.uniforms.uRing!.value as THREE.Vector3).set(s.minRadius * r, s.line * r, s.outline * r);
    }
  }

  /** パラメータを部分的に更新する。 */
  set(params: Partial<PointCloudParams>): void {
    Object.assign(this.params, params);
    this.applyParams();
  }

  setViewportHeight(pixels: number): void {
    this.mesh.material.uniforms.uViewportHeight!.value = pixels;
  }

  /** ピッキング用マテリアルの描画先の高さ（画素）。画面上の大きさの計算に使う。 */
  setPickingViewportHeight(pixels: number): void {
    this.pickingMaterial.uniforms.uViewportHeight!.value = pixels;
  }

  private applyParams(): void {
    const u = this.mesh.material.uniforms;
    const p = this.params;
    const r = this.pixelRatio; // CSS ピクセル → 描画バッファの画素
    u.uPointSize!.value = p.pointSize;
    u.uMinPixelSize!.value = p.minPixelSize * r;
    (u.uDigitPx!.value as THREE.Vector2).set(p.digitPixelRange[0] * r, p.digitPixelRange[1] * r);
    (u.uNearFade!.value as THREE.Vector2).set(p.nearFadeFactors[0] * p.pointSize, p.nearFadeFactors[1] * p.pointSize);
    (u.uFog!.value as THREE.Vector3).set(...p.fog);
    u.uOutline!.value = p.outline;
    (u.uDotRadius!.value as THREE.Vector2).set(p.dotRadius[0], p.dotRadius[1] * r);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.pickingMaterial.dispose();
    this.texture?.dispose();
    this.highlightMeshes.hover.geometry.dispose();
    this.highlightMeshes.hover.material.dispose();
    this.highlightMeshes.selected.material.dispose();
  }
}
