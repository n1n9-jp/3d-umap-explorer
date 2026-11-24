/**
 * 単語のデータセットで、カメラに近い単語を空間内に文字として描く。
 *
 * - 全点は点群（src/render/）が丸い点として描き、カメラに近い最大 N 個の単語だけを、ここで文字として描く。
 * - 文字は、データセットの単語に出てくる文字だけで作った SDF のグリフアトラス（glyphAtlas.ts）から、
 *   文字 1 つを 1 インスタンスとして描く（shaders.ts）。単語の組み立ては layout.ts、選び方は selection.ts。
 * - 画面上の文字の高さは、透視投影のままの高さを、下限と上限のある緩やかな変化に写す（selection.ts の textSizePx）。
 * - UI の領域や目印（`setObstacles`）と重なる単語は出さない。
 * - 選び直しは、カメラ（と点の大きさ・画面の大きさ・障害物）が変わったときだけ、0.1 秒に 1 回まで行う。カメラが速く動いて、
 *   表示中の単語が画面上で大きく動いたときは、33 ミリ秒（選び直しが重いときはその 6 倍）まで間隔を縮め、障害物との間隔も広げる（motion.ts）。
 *   新しく入る単語と抜ける単語は、`fadeSeconds` 秒で不透明度を変える。
 * - 表示中の単語の矩形（`shownRects`）は、毎フレーム、いまの視点で求め直す（描かれている文字の位置と合う）。
 *   点の番号で引く読み取り口（`currentBox`）も、同じ矩形と基準点を返す（配列やオブジェクトを作らない）。
 * - 文字を出している点の丸い点は縮めて消し（不透明度に合わせる）、ホバー・選択の強調は単語を囲む矩形にする。
 *   表示中の単語の矩形の近くの丸い点は小さくして（clearance.ts）、同じ色の点の塊が文字を読みにくくしないようにする。
 * - ピッキング（src/picking/GpuPicker.ts）の層として、文字の本体の画素をその点の番号で描く。
 */
import * as THREE from 'three';
import type { PointCloud } from '../render/pointCloud';
import type { GpuPicker } from '../picking/GpuPicker';
import { buildGlyphAtlas, type GlyphAtlas } from './glyphAtlas';
import { collectChars, layoutWord, MAX_WORD_CHARS, type WordLayout } from './layout';
import {
  DEFAULT_SELECT_PARAMS, placeWordRect, selectWords, stepOpacities, textSizePx, type PlacedRect, type PlacedWord, type ScreenRect, type SelectView, type WordBox, type WordSelectParams,
} from './selection';
import { wordFragmentShader, wordVertexShader } from './shaders';
import { DOT_CLEARANCE_MARGIN_PX, DOT_CLEARANCE_SCALE, pointsNearRects, pointsNearRectsIndexed, type BoxQueryIndex } from './clearance';
import { BASE_INTERVAL_MS, maxAnchorDisplacement, motionMarginPx, selectIntervalMs } from './motion';

/** 文字の大きさ: 1 em = TEXT_SCALE × 点の大きさ（ワールド単位）。 */
export const TEXT_SCALE = 0.4;
/** 縁取りの幅（em） */
export const OUTLINE_EM = 0.12;
/** 選び直しの間隔の下限（ミリ秒） */
export const SELECT_INTERVAL_MS = BASE_INTERVAL_MS;
/** 表示の切り替えにかける時間（秒） */
export const FADE_SECONDS = 0.2;
/** 空間索引から取る候補の数（表示する数の上限 N に対する倍率） */
export const CANDIDATE_FACTOR = 6;
/**
 * クラスタに属さない点の文字の色。点の灰色（src/render/colorScheme.ts の NOISE_COLOR #686d78）のままでは、
 * 霧の中で暗い背景に沈むので、文字だけ明るくする（点の色は変えない）。
 */
export const NOISE_TEXT_COLOR = '#a3a9b5';
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
  /** 点の空間索引。あれば、単語の周りの丸い点を、全点ではなく木を巡って探す（結果は全点を調べた場合と同じ）。なければ全点を調べる */
  index?: BoxQueryIndex;
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
  shown: { index: number; text: string; rect: PlacedWord['rect']; anchorX: number; anchorY: number; textPx: number; naturalPx: number; distance: number; opacity: number }[];
  /** 表示中の単語の、いまの視点での画面上の矩形（`shownRects()` と同じ。カメラの後ろへ回った単語は含まない） */
  currentRects: ScreenRect[];
  /** `currentBox(index)` が返す矩形と基準点を持つ単語（不透明度が十分高いもの。検証用） */
  currentBoxes: { index: number; rect: ScreenRect; anchorX: number; anchorY: number }[];
  /** 単語を重ねない領域（UI の要素・目印。CSS ピクセル） */
  obstacles: ScreenRect[];
  /** 単語の矩形の近くにあって、丸い点を小さくしている点の数（clearance.ts） */
  cleared: number;
  /** 描いている単語（表示中と、消えていく途中のもの）の数と文字の数 */
  drawnWords: number;
  drawnGlyphs: number;
  /** 不透明度が 0 と 1 の間の単語の数 */
  fading: number;
  atlas: { width: number; height: number; glyphs: number; buildMs: number };
  select: { count: number; lastMs: number; meanMs: number; maxMs: number; candidates: number; eligible: number; clearMs: number; clearMeanMs: number };
  /** カメラの動き: 表示中の単語の基準点が、最後に選び直したときから動いた量（CSS ピクセル。`atSelectPx` は最後の選び直しの時点の値）、障害物との間隔に足している余裕、いまの選び直しの間隔 */
  motion: { px: number; atSelectPx: number; marginPx: number; intervalMs: number };
  params: { maxWords: number; textScale: number; outlineEm: number; intervalMs: number; fadeSeconds: number; noiseTextColor: string; select: WordSelectParams };
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
  private readonly pixelRatioUniform = { value: 1 };
  private obstacles: ScreenRect[] = [];
  private obstacleKey = '';
  private viewHeight = 1;

  private enabled = true;
  private shown: PlacedWord[] = [];
  private shownSet = new Set<number>();
  private readonly opacity = new Map<number, number>();
  private readonly dotScaled = new Set<number>();
  /** 単語の矩形の近くにあって、丸い点を小さくする点（最後に選んだとき） */
  private clearTargets = new Set<number>();
  /** 丸い点を小さくする量（0..1。0 で元の大きさ、1 で DOT_CLEARANCE_SCALE 倍）。単語の不透明度と同じ速さで切り替える */
  private readonly clearance = new Map<number, number>();
  private sinceSelectMs = Infinity;
  /** 表示中の単語の基準点が、最後に選び直したときの位置から動いた量（CSS ピクセル） */
  private motionPx = 0;
  /** 最後の選び直しで足した、障害物との間隔の余裕（CSS ピクセル） */
  private lastMarginPx = 0;
  private motionAtSelectPx = 0;
  /** いまの視点での、表示中の単語の矩形（`shown` と同じ順） */
  private currentRects: ScreenRect[] = [];
  /** `currentRects` と同じ矩形・基準点を、点の番号で引けるようにしたもの（毎フレーム `trackMotion` で作り直す。値は作った `PlacedRect` そのもの） */
  private readonly currentById = new Map<number, PlacedRect>();
  private dirtyLayout = true;
  private drawnWords = 0;
  private drawnGlyphs = 0;
  private readonly lastView = new THREE.Matrix4();
  private readonly lastProjection = new THREE.Matrix4();
  private lastKey = '';
  private viewDirty = true;
  private readonly stats = { count: 0, lastMs: 0, totalMs: 0, maxMs: 0, candidates: 0, eligible: 0, clearMs: 0, clearTotalMs: 0 };
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
      uTextSize: { value: new THREE.Vector4(this.params.size.referencePx, this.params.size.exponent, this.params.size.minPx, Math.min(this.params.size.maxPx, 1e9)) },
      uPixelRatio: this.pixelRatioUniform,
      uNoiseTextColor: { value: new THREE.Color(NOISE_TEXT_COLOR) },
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
    this.clearTargets = new Set();
    this.clearance.clear();
    this.currentRects = [];
    this.currentById.clear();
    this.motionPx = 0;
    this.viewDirty = true;
    this.sinceSelectMs = Infinity;
    this.dirtyLayout = true;
    this.rebuild();
  }

  /**
   * 単語を重ねない画面上の領域（CSS ピクセル）。UI の要素や目印の矩形を、毎フレーム（update の前）渡す。
   * 1 ピクセル単位で変わったときだけ選び直す。
   */
  setObstacles(rects: readonly ScreenRect[]): void {
    const key = rects.map((r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`).join(';');
    if (key === this.obstacleKey) return;
    this.obstacleKey = key;
    this.obstacles = rects.map((r) => ({ ...r }));
    this.viewDirty = true;
  }

  /**
   * 表示中（選ばれている）の単語の画面上の矩形（CSS ピクセル）。毎フレームの `update` で、いまの視点で求め直した位置
   * （カメラが動いても、描かれている文字の位置と合う）。カメラの後ろへ回った単語は含まない。無効なら空。
   */
  shownRects(): readonly ScreenRect[] {
    return this.currentRects;
  }

  /**
   * 点 `index` の単語を囲む矩形と基準点（点の中心の画面上の位置。CSS ピクセル）を、いまの視点で返す（直近の `update` で求めた、
   * 描かれている文字の位置と大きさ）。毎フレーム求めている値を返すだけで、配列やオブジェクトを作らない（戻り値は読むだけ。書き換えない）。
   * 単語として表示されていない・薄れかけている（不透明度が半分未満。強調表示が単語を囲む矩形に切り替わる境と同じ）・
   * カメラの後ろにあるときは null。
   */
  currentBox(index: number): Readonly<PlacedRect> | null {
    const b = this.currentById.get(index);
    if (!b) return null;
    return (this.opacity.get(index) ?? 0) >= BOX_HIGHLIGHT_OPACITY ? b : null;
  }

  /** 毎フレーム（描画の前）。width・height は画面の大きさ（CSS ピクセル）。 */
  update(dt: number, width: number, height: number): void {
    if (this.disposed) return;
    this.sinceSelectMs += dt * 1000;
    this.viewHeight = height;
    // 描画の画素 / CSS ピクセル（文字の高さの写し方は CSS ピクセルで決める）
    const bufferHeight = this.deps.cloud.mesh.material.uniforms.uViewportHeight!.value as number;
    this.pixelRatioUniform.value = height > 0 && bufferHeight > 0 ? bufferHeight / height : 1;
    if (this.enabled) {
      const cam = this.deps.camera;
      cam.updateMatrixWorld();
      const key = `${width}x${height}:${this.deps.cloud.params.pointSize}:${this.deps.cloud.params.nearFadeFactors.join(',')}:${this.obstacleKey}`;
      if (!cam.matrixWorld.equals(this.lastView) || !cam.projectionMatrix.equals(this.lastProjection) || key !== this.lastKey) {
        this.viewDirty = true;
      }
      this.trackMotion(width, height);
      const lastCost = this.stats.lastMs;
      if (this.viewDirty && this.sinceSelectMs >= selectIntervalMs(this.motionPx, lastCost)) {
        // 速く動いているときは、次の選び直しまでに動く量を見込んで、障害物との間隔を広げる
        this.lastMarginPx = motionMarginPx(this.motionPx, this.sinceSelectMs);
        this.motionAtSelectPx = this.motionPx;
        this.lastView.copy(cam.matrixWorld);
        this.lastProjection.copy(cam.projectionMatrix);
        this.lastKey = key;
        this.viewDirty = false;
        this.sinceSelectMs = 0;
        this.select(width, height);
        this.trackMotion(width, height);
      }
    }
    if (stepOpacities(this.opacity, this.shownSet, dt, FADE_SECONDS)) this.dirtyLayout = true;
    const clearing = stepOpacities(this.clearance, this.clearTargets, dt, FADE_SECONDS);
    if (this.dirtyLayout) this.rebuild();
    else if (clearing) this.updateDots();
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
        textPx: w.textPx, naturalPx: w.naturalPx, distance: w.distance, opacity: this.opacity.get(w.index) ?? 0,
      })),
      currentRects: this.currentRects.map((r) => ({ ...r })),
      currentBoxes: this.shown.flatMap((w) => {
        const b = this.currentBox(w.index);
        return b ? [{ index: w.index, rect: { ...b.rect }, anchorX: b.anchorX, anchorY: b.anchorY }] : [];
      }),
      obstacles: this.obstacles.map((r) => ({ ...r })),
      cleared: this.clearTargets.size,
      drawnWords: this.drawnWords,
      drawnGlyphs: this.drawnGlyphs,
      fading,
      atlas: { width: this.atlas.width, height: this.atlas.height, glyphs: this.atlas.glyphs.size, buildMs: this.atlas.buildMs },
      select: {
        count: s.count, lastMs: s.lastMs, meanMs: s.count ? s.totalMs / s.count : 0, maxMs: s.maxMs, candidates: s.candidates, eligible: s.eligible,
        clearMs: s.clearMs, clearMeanMs: s.count ? s.clearTotalMs / s.count : 0,
      },
      motion: { px: this.motionPx, atSelectPx: this.motionAtSelectPx, marginPx: this.lastMarginPx, intervalMs: selectIntervalMs(this.motionPx, s.lastMs) },
      params: { maxWords: this.params.maxWords, textScale: this.textScale, outlineEm: OUTLINE_EM, intervalMs: SELECT_INTERVAL_MS, fadeSeconds: FADE_SECONDS, noiseTextColor: NOISE_TEXT_COLOR, select: { ...this.params, size: { ...this.params.size } } },
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
    const view = { view: cam.matrixWorldInverse.elements, projection: cam.projectionMatrix.elements, width, height };
    const res = selectWords({
      candidates,
      positions: this.deps.positions,
      view,
      emWorld: this.textScale * cloud.pointSize,
      nearLimit: cloud.nearFadeFactors[1] * cloud.pointSize,
      box: (i) => this.box(i),
      shown: this.shownSet,
      obstacles: this.obstacles,
      motionMarginPx: this.lastMarginPx,
      params: this.params,
    });
    this.shown = res.words;
    this.shownSet = new Set(res.words.map((w) => w.index));
    const t1 = performance.now();
    // 単語の矩形の近くの丸い点を小さくする。離れた点も上限の大きさで描かれるので、全点が対象（空間索引の木を巡って、全点を調べた場合と同じ結果を得る）
    const rects = res.words.map((w) => w.rect);
    this.clearTargets = !this.deps.cloud.dotScales ? new Set()
      : this.deps.index ? pointsNearRectsIndexed(this.deps.index, view, rects, DOT_CLEARANCE_MARGIN_PX, this.shownSet)
        : pointsNearRects(null, this.deps.positions, view, rects, DOT_CLEARANCE_MARGIN_PX, this.shownSet);
    this.dirtyLayout = true;
    const clearMs = performance.now() - t1;
    const ms = performance.now() - t0;
    const s = this.stats;
    s.count++;
    s.lastMs = ms;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    s.candidates = candidates.length;
    s.eligible = res.eligible;
    s.clearMs = clearMs;
    s.clearTotalMs += clearMs;
  }

  /**
   * 表示中の単語の矩形をいまの視点で求め直し（`currentRects`）、基準点が最後に選び直したときの位置から動いた量を測る（`motionPx`）。
   * 選び直しの間隔と、障害物との間隔の余裕を決める（motion.ts）。
   */
  private trackMotion(width: number, height: number): void {
    const cam = this.deps.camera;
    const view: SelectView = { view: cam.matrixWorldInverse.elements, projection: cam.projectionMatrix.elements, width, height };
    const pos = this.deps.positions;
    const emWorld = this.textScale * this.deps.cloud.params.pointSize;
    const rects: ScreenRect[] = [];
    const anchors: ({ x: number; y: number } | null)[] = [];
    this.currentById.clear();
    for (const w of this.shown) {
      const b = this.box(w.index);
      const placed = b ? placeWordRect(view, pos[3 * w.index]!, pos[3 * w.index + 1]!, pos[3 * w.index + 2]!, b, emWorld, this.params.size) : null;
      anchors.push(placed ? { x: placed.anchorX, y: placed.anchorY } : null);
      if (placed) { rects.push(placed.rect); this.currentById.set(w.index, placed); }
    }
    this.currentRects = rects;
    this.motionPx = maxAnchorDisplacement(this.shown.map((w) => ({ x: w.anchorX, y: w.anchorY })), anchors);
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

  /**
   * 丸い点の倍率を合わせる。文字を出している点は不透明度に合わせて縮め（1 − 不透明度）、単語の矩形の近くの点は
   * DOT_CLEARANCE_SCALE 倍まで小さくする（両方に当たるときは小さいほう）。
   */
  private updateDots(): void {
    const cloud = this.deps.cloud;
    if (!cloud.dotScales) return;
    const target = (i: number): number => {
      const a = this.opacity.get(i);
      const c = this.clearance.get(i) ?? 0;
      return Math.min(a === undefined ? 1 : 1 - a, 1 - (1 - DOT_CLEARANCE_SCALE) * c);
    };
    for (const i of this.dotScaled) {
      if (!this.opacity.has(i) && !this.clearance.has(i)) { cloud.setDotScale(i, 1); this.dotScaled.delete(i); }
    }
    for (const i of [...this.opacity.keys(), ...this.clearance.keys()]) {
      cloud.setDotScale(i, target(i));
      this.dotScaled.add(i);
    }
    cloud.commitDotScales(); // 値が変わった点（の範囲）だけを GPU へ送る
  }

  private resetDots(): void {
    const cloud = this.deps.cloud;
    if (!cloud.dotScales) return;
    for (const i of this.dotScaled) cloud.setDotScale(i, 1);
    this.dotScaled.clear();
    cloud.commitDotScales();
  }

  /**
   * 点 i の 1 em のワールドでの大きさ（文字の高さを写したあと。シェーダと同じ式）。
   * 奥行きで変わるので、強調の矩形は毎フレーム合わせ直す。
   */
  private effectiveEm(i: number): number {
    const em = this.textScale * this.deps.cloud.params.pointSize;
    const cam = this.deps.camera;
    const m = cam.matrixWorldInverse.elements, pos = this.deps.positions;
    const x = pos[3 * i]!, y = pos[3 * i + 1]!, z = pos[3 * i + 2]!;
    const depth = -(m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
    if (!(depth > 0)) return em;
    const natural = em * 0.5 * this.viewHeight * cam.projectionMatrix.elements[5]! / depth;
    return natural > 0 ? em * textSizePx(natural, this.params.size) / natural : em;
  }

  /** ホバー・選択中の点が文字を出していれば、強調表示を単語を囲む矩形にする。 */
  private updateHighlights(): void {
    const cloud = this.deps.cloud;
    for (const kind of ['hover', 'selected'] as const) {
      const i = cloud.getHighlight(kind);
      const a = i === null ? 0 : this.opacity.get(i) ?? 0;
      const b = i !== null && a >= BOX_HIGHLIGHT_OPACITY ? this.box(i) : null;
      const em = b ? this.effectiveEm(i!) : 0;
      cloud.setHighlightBox(kind, b
        ? [(b.right - b.left) / 2 * em, (b.top - b.bottom) / 2 * em, (b.left + b.right) / 2 * em, (b.top + b.bottom) / 2 * em]
        : null);
    }
  }
}
