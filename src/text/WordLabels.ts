/**
 * 単語のデータセットで、カメラに近い単語を空間内に文字として描く。
 *
 * - 全点は点群（src/render/）が丸い点として描き、カメラに近い最大 N 個の単語だけを、ここで文字として描く。
 * - 文字は、データセットの単語に出てくる文字だけで作った SDF のグリフアトラス（glyphAtlas.ts）から、
 *   文字 1 つを 1 インスタンスとして描く（shaders.ts）。単語の組み立ては layout.ts、選び方は selection.ts。
 * - 選び直しは、カメラ（と点の大きさ・画面の大きさ）が変わったときだけ、`minIntervalMs` に 1 回まで行う。
 *   新しく入る単語と抜ける単語は、`fadeSeconds` 秒で不透明度を変える。
 * - 文字を出している点の丸い点は縮めて消し（不透明度に合わせる）、ホバー・選択の強調は単語を囲む矩形にする。
 * - ピッキング（src/picking/GpuPicker.ts）の層として、文字の本体の画素をその点の番号で描く。
 */
import * as THREE from 'three';
import type { PointCloud } from '../render/pointCloud';
import type { GpuPicker } from '../picking/GpuPicker';
import { buildGlyphAtlas, type GlyphAtlas } from './glyphAtlas';
import { collectChars, layoutWord, MAX_WORD_CHARS, type WordLayout } from './layout';
import {
  DEFAULT_SELECT_PARAMS, selectWords, stepOpacities, type PlacedWord, type WordBox, type WordSelectParams,
} from './selection';
import { wordFragmentShader, wordVertexShader } from './shaders';

/** 文字の大きさ: 1 em = TEXT_SCALE × 点の大きさ（ワールド単位）。 */
export const TEXT_SCALE = 0.4;
/** 縁取りの幅（em） */
export const OUTLINE_EM = 0.12;
/** 選び直しの間隔の下限（ミリ秒） */
export const SELECT_INTERVAL_MS = 100;
/** 表示の切り替えにかける時間（秒） */
export const FADE_SECONDS = 0.2;
/** 空間索引から取る候補の数（表示する数の上限 N に対する倍率） */
export const CANDIDATE_FACTOR = 6;
/** 単語を囲む強調表示に切り替える不透明度 */
const BOX_HIGHLIGHT_OPACITY = 0.5;

export interface WordLabelsDeps {
  text: readonly string[];
  positions: Float32Array;
  colorIndices: Float32Array;
  cloud: PointCloud;
  picker: GpuPicker;
  /** カメラの近くの点（近い順） */
  nearest(x: number, y: number, z: number, k: number): ArrayLike<number>;
  camera: THREE.PerspectiveCamera;
  doc: Document;
}

export interface WordLabelsOptions {
  maxWords?: number;
  select?: Partial<WordSelectParams>;
  textScale?: number;
}

/** 検証用の状態。 */
export interface WordLabelsState {
  enabled: boolean;
  /** 表示中（選ばれている）の単語。矩形は最後に選んだときの画面上の位置（CSS ピクセル） */
  shown: { index: number; text: string; rect: PlacedWord['rect']; anchorX: number; anchorY: number; textPx: number; distance: number; opacity: number }[];
  /** 描いている単語（表示中と、消えていく途中のもの）の数と文字の数 */
  drawnWords: number;
  drawnGlyphs: number;
  /** 不透明度が 0 と 1 の間の単語の数 */
  fading: number;
  atlas: { width: number; height: number; glyphs: number; buildMs: number };
  select: { count: number; lastMs: number; meanMs: number; maxMs: number; candidates: number; eligible: number };
  params: { maxWords: number; textScale: number; outlineEm: number; intervalMs: number; fadeSeconds: number; select: WordSelectParams };
}

export class WordLabels {
  /** 文字のメッシュ（縁取りと本体）をまとめたグループ。DatasetView.root に加える */
  readonly group = new THREE.Group();
  private readonly deps: WordLabelsDeps;
  private readonly atlas: GlyphAtlas;
  private readonly texture: THREE.DataTexture;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly bodyMesh: THREE.Mesh;
  private readonly outlineMesh: THREE.Mesh;
  private readonly removeLayers: (() => void)[] = [];
  private readonly capacity: number;
  private readonly aPoint: THREE.InstancedBufferAttribute;
  private readonly aQuad: THREE.InstancedBufferAttribute;
  private readonly aUv: THREE.InstancedBufferAttribute;
  private readonly aStyle: THREE.InstancedBufferAttribute;
  private readonly layouts = new Map<number, WordLayout>();
  private readonly params: WordSelectParams;
  private readonly textScale: number;
  private readonly textScaleUniform: { value: number };

  private enabled = true;
  private shown: PlacedWord[] = [];
  private shownSet = new Set<number>();
  private readonly opacity = new Map<number, number>();
  private readonly dotScaled = new Set<number>();
  private sinceSelectMs = Infinity;
  private dirtyLayout = true;
  private drawnWords = 0;
  private drawnGlyphs = 0;
  private readonly lastView = new THREE.Matrix4();
  private readonly lastProjection = new THREE.Matrix4();
  private lastKey = '';
  private viewDirty = true;
  private readonly stats = { count: 0, lastMs: 0, totalMs: 0, maxMs: 0, candidates: 0, eligible: 0 };
  private disposed = false;

  constructor(deps: WordLabelsDeps, options: WordLabelsOptions = {}) {
    this.deps = deps;
    this.params = { ...DEFAULT_SELECT_PARAMS, ...options.select, ...(options.maxWords ? { maxWords: options.maxWords } : {}) };
    this.textScale = options.textScale ?? TEXT_SCALE;

    this.atlas = buildGlyphAtlas(collectChars(deps.text), deps.doc);
    const tex = new THREE.DataTexture(this.atlas.data, this.atlas.width, this.atlas.height, THREE.RedFormat, THREE.UnsignedByteType);
    tex.flipY = false;
    tex.unpackAlignment = 1;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.texture = tex;

    let longest = 1;
    for (const w of deps.text) longest = Math.max(longest, Math.min(MAX_WORD_CHARS, w.length));
    // 表示中の N 個と、消えていく途中の単語の分
    this.capacity = 2 * this.params.maxWords * longest;
    const cap = this.capacity;
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    const attr = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    g.setAttribute('iPoint', (this.aPoint = attr(3)));
    g.setAttribute('iQuad', (this.aQuad = attr(4)));
    g.setAttribute('iUv', (this.aUv = attr(4)));
    g.setAttribute('iStyle', (this.aStyle = attr(3)));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
    this.geometry = g;

    // 点群のユニフォームを共有する（点の大きさ・画面の高さ・近接フェード・霧・色）
    const cu = deps.cloud.mesh.material.uniforms;
    this.textScaleUniform = { value: this.textScale };
    const o = this.atlas.options;
    const shared = {
      uPointSize: cu.uPointSize!,
      uNearFade: cu.uNearFade!,
      uFog: cu.uFog!,
      uPalette: cu.uPalette!,
      uNoiseColor: cu.uNoiseColor!,
      uBackground: cu.uBackground!,
      uTextScale: this.textScaleUniform,
      uAtlas: { value: tex },
      uEdge: { value: 1 - o.cutoff },
      uOutline: { value: (OUTLINE_EM * o.fontSize) / o.radius },
    };
    const make = (outline: boolean, picking: boolean) => {
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: wordVertexShader,
        fragmentShader: wordFragmentShader,
        defines: { ...(outline ? { OUTLINE_PASS: '' } : {}), ...(picking ? { PICKING: '' } : {}) },
        // 描画用は点群と同じ uViewportHeight、ピッキング用は描く領域に合わせて書き換える別のもの
        uniforms: { ...shared, uViewportHeight: picking ? { value: 1 } : cu.uViewportHeight! },
        transparent: false,
        depthTest: true,
        depthWrite: true,
        alphaToCoverage: !picking,
        blending: picking ? THREE.NoBlending : THREE.NormalBlending,
        side: THREE.DoubleSide,
        // 縁取りを奥へずらし、隣の文字の縁取りが本体を削らないようにする
        polygonOffset: outline,
        polygonOffsetFactor: outline ? 1 : 0,
        polygonOffsetUnits: outline ? 4 : 0,
      });
      this.materials.push(m);
      return m;
    };
    this.outlineMesh = new THREE.Mesh(g, make(true, false));
    this.bodyMesh = new THREE.Mesh(g, make(false, false));
    for (const m of [this.outlineMesh, this.bodyMesh]) {
      m.frustumCulled = false;
      this.group.add(m);
    }
    const visible = () => this.group.visible && this.drawnGlyphs > 0;
    this.removeLayers.push(deps.picker.addLayer({ source: this.outlineMesh, material: make(true, true), visible }));
    this.removeLayers.push(deps.picker.addLayer({ source: this.bodyMesh, material: make(false, true), visible }));
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 文字の表示の有効・無効。無効にすると、すぐに消して丸い点へ戻す。 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.shown = [];
    this.shownSet = new Set();
    this.opacity.clear();
    this.viewDirty = true;
    this.sinceSelectMs = Infinity;
    this.dirtyLayout = true;
    this.rebuild();
  }

  /** 毎フレーム（描画の前）。width・height は画面の大きさ（CSS ピクセル）。 */
  update(dt: number, width: number, height: number): void {
    if (this.disposed) return;
    this.sinceSelectMs += dt * 1000;
    if (this.enabled) {
      const cam = this.deps.camera;
      cam.updateMatrixWorld();
      const key = `${width}x${height}:${this.deps.cloud.params.pointSize}:${this.deps.cloud.params.nearFadeFactors.join(',')}`;
      if (!cam.matrixWorld.equals(this.lastView) || !cam.projectionMatrix.equals(this.lastProjection) || key !== this.lastKey) {
        this.viewDirty = true;
      }
      if (this.viewDirty && this.sinceSelectMs >= SELECT_INTERVAL_MS) {
        this.lastView.copy(cam.matrixWorld);
        this.lastProjection.copy(cam.projectionMatrix);
        this.lastKey = key;
        this.viewDirty = false;
        this.sinceSelectMs = 0;
        this.select(width, height);
      }
    }
    if (stepOpacities(this.opacity, this.shownSet, dt, FADE_SECONDS)) this.dirtyLayout = true;
    if (this.dirtyLayout) this.rebuild();
    this.updateHighlights();
  }

  getState(): WordLabelsState {
    let fading = 0;
    for (const a of this.opacity.values()) if (a > 0 && a < 1) fading++;
    const s = this.stats;
    return {
      enabled: this.enabled,
      shown: this.shown.map((w) => ({
        index: w.index, text: this.deps.text[w.index] ?? '', rect: { ...w.rect }, anchorX: w.anchorX, anchorY: w.anchorY,
        textPx: w.textPx, distance: w.distance, opacity: this.opacity.get(w.index) ?? 0,
      })),
      drawnWords: this.drawnWords,
      drawnGlyphs: this.drawnGlyphs,
      fading,
      atlas: { width: this.atlas.width, height: this.atlas.height, glyphs: this.atlas.glyphs.size, buildMs: this.atlas.buildMs },
      select: { count: s.count, lastMs: s.lastMs, meanMs: s.count ? s.totalMs / s.count : 0, maxMs: s.maxMs, candidates: s.candidates, eligible: s.eligible },
      params: { maxWords: this.params.maxWords, textScale: this.textScale, outlineEm: OUTLINE_EM, intervalMs: SELECT_INTERVAL_MS, fadeSeconds: FADE_SECONDS, select: { ...this.params } },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.removeLayers) r();
    this.resetDots();
    this.deps.cloud.setHighlightBox('hover', null);
    this.deps.cloud.setHighlightBox('selected', null);
    this.group.removeFromParent();
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.texture.dispose();
  }

  private layout(index: number): WordLayout {
    let l = this.layouts.get(index);
    if (!l) {
      l = layoutWord(this.deps.text[index] ?? '', this.atlas.glyphs, this.atlas.metrics, this.atlas.fallback);
      this.layouts.set(index, l);
    }
    return l;
  }

  /** 単語の矩形（em。縁取りを含む） */
  private box(index: number): WordBox | null {
    const l = this.layout(index);
    if (!l.glyphs.length) return null;
    return { left: l.ink.left - OUTLINE_EM, right: l.ink.right + OUTLINE_EM, top: l.ink.top + OUTLINE_EM, bottom: l.ink.bottom - OUTLINE_EM };
  }

  private select(width: number, height: number): void {
    const t0 = performance.now();
    const cam = this.deps.camera;
    const p = cam.position;
    const cloud = this.deps.cloud.params;
    const candidates = this.deps.nearest(p.x, p.y, p.z, this.params.maxWords * CANDIDATE_FACTOR);
    const res = selectWords({
      candidates,
      positions: this.deps.positions,
      view: { view: cam.matrixWorldInverse.elements, projection: cam.projectionMatrix.elements, width, height },
      emWorld: this.textScale * cloud.pointSize,
      nearLimit: cloud.nearFadeFactors[1] * cloud.pointSize,
      box: (i) => this.box(i),
      shown: this.shownSet,
      params: this.params,
    });
    this.shown = res.words;
    this.shownSet = new Set(res.words.map((w) => w.index));
    this.dirtyLayout = true;
    const ms = performance.now() - t0;
    const s = this.stats;
    s.count++;
    s.lastMs = ms;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    s.candidates = candidates.length;
    s.eligible = res.eligible;
  }

  /** 描く単語（不透明度が 0 より大きいもの）のインスタンスを作り直し、丸い点の大きさを合わせる。 */
  private rebuild(): void {
    this.dirtyLayout = false;
    const words = [...this.opacity.entries()].filter(([, a]) => a > 0);
    // 入りきらないときは、不透明度の高い単語から
    words.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const pos = this.deps.positions, colors = this.deps.colorIndices;
    const P = this.aPoint.array as Float32Array, Q = this.aQuad.array as Float32Array;
    const U = this.aUv.array as Float32Array, S = this.aStyle.array as Float32Array;
    let n = 0, drawnWords = 0;
    for (const [i, a] of words) {
      const l = this.layout(i);
      if (n + l.glyphs.length > this.capacity) continue;
      drawnWords++;
      for (const g of l.glyphs) {
        P[3 * n] = pos[3 * i]!; P[3 * n + 1] = pos[3 * i + 1]!; P[3 * n + 2] = pos[3 * i + 2]!;
        const q = g.glyph.quad;
        Q[4 * n] = g.x + q.x; Q[4 * n + 1] = l.baseline + q.y; Q[4 * n + 2] = q.width; Q[4 * n + 3] = q.height;
        const uv = g.glyph.uv;
        U[4 * n] = uv.u0; U[4 * n + 1] = uv.v0; U[4 * n + 2] = uv.u1; U[4 * n + 3] = uv.v1;
        S[3 * n] = colors[i] ?? 0; S[3 * n + 1] = a; S[3 * n + 2] = i;
        n++;
      }
    }
    for (const a of [this.aPoint, this.aQuad, this.aUv, this.aStyle]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n) * a.itemSize);
      a.needsUpdate = true;
    }
    this.geometry.instanceCount = n;
    this.drawnWords = drawnWords;
    this.drawnGlyphs = n;
    this.group.visible = n > 0;
    this.updateDots();
  }

  /** 文字を出している点の丸い点を、不透明度に合わせて縮める（1 − 不透明度）。 */
  private updateDots(): void {
    const scales = this.deps.cloud.dotScales;
    if (!scales) return;
    let changed = false;
    for (const i of this.dotScaled) {
      if (!this.opacity.has(i)) { scales[i] = 1; this.dotScaled.delete(i); changed = true; }
    }
    for (const [i, a] of this.opacity) {
      const s = 1 - a;
      if (scales[i] !== s) { scales[i] = s; changed = true; }
      this.dotScaled.add(i);
    }
    if (changed) this.deps.cloud.commitDotScales();
  }

  private resetDots(): void {
    const scales = this.deps.cloud.dotScales;
    if (!scales) return;
    for (const i of this.dotScaled) scales[i] = 1;
    this.dotScaled.clear();
    this.deps.cloud.commitDotScales();
  }

  /** ホバー・選択中の点が文字を出していれば、強調表示を単語を囲む矩形にする。 */
  private updateHighlights(): void {
    const cloud = this.deps.cloud;
    const em = this.textScale * cloud.params.pointSize;
    for (const kind of ['hover', 'selected'] as const) {
      const i = cloud.getHighlight(kind);
      const a = i === null ? 0 : this.opacity.get(i) ?? 0;
      const b = i !== null && a >= BOX_HIGHLIGHT_OPACITY ? this.box(i) : null;
      cloud.setHighlightBox(kind, b
        ? [(b.right - b.left) / 2 * em, (b.top - b.bottom) / 2 * em, (b.left + b.right) / 2 * em, (b.top + b.bottom) / 2 * em]
        : null);
    }
  }
}
