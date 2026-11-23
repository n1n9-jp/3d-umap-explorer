import * as THREE from 'three';
import { labelColors } from '../render/palette';
import type { Vec3, ViewSpec } from '../render/view';
import {
  clampRange, clampToFrame, computeExtent, computeLayout, depthHistogram, depthToGauge, fromPlane, mapToPlane,
  minimapBasis, planeToMap, sampleIndices, toPlane, viewFigure,
  type MinimapBasis, type MinimapExtent, type MinimapLayout, type Rect,
} from './geometry';

/** 点の大きさ（CSS ピクセル）。描画バッファへは pixelRatio を掛けて丸める。 */
export const MINIMAP_POINT_CSS_PX = 1.5;
/** 背景の面の色と不透明度。本体の背景（#07080c）より明るく、点群と区別できる。 */
const PANEL_RGB: [number, number, number] = [0x1a / 255, 0x21 / 255, 0x31 / 255]; // sRGB の値をそのまま出力する（#1a2131）
const PANEL_OPACITY = 0.93;
/** 視野の図形の長さ（地図の 1 辺に対する割合） */
const FIGURE_LENGTH = 0.16;
/** 範囲の外にいるときの印を寄せる、枠からの内側の距離（CSS ピクセル） */
const FRAME_INSET = 7;
/** クリックとみなす、押してから離すまでの移動の上限（CSS ピクセル） */
const CLICK_SLOP = 4;
/** クリックで移動する所要時間（秒） */
export const MINIMAP_MOVE_SECONDS = 0.6;
/** カメラの印と選択中の点の色 */
const CAMERA_COLOR = '#ffffff';
const CAMERA_OUTLINE = '#07080c';
const SELECTED_COLOR = '#ffc233';
const HIST_BINS = 40;

export interface MinimapDeps {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  positions: Float32Array;
  labels: Uint8Array;
  labelCount: number;
  axes?: readonly [Vec3, Vec3, Vec3] | null;
  /** 選択中の点の番号（なければ null） */
  selected(): number | null;
  /** 視点を滑らかに移す（位置と向き）。 */
  moveTo(view: ViewSpec, seconds: number): void;
  /** 本体の描画（検証用の readFrame で使う） */
  renderMain(): void;
  /** オーバーレイ（枠・印・目盛り）を置く親要素 */
  container: HTMLElement;
}

/** ミニマップの状態（検証用）。位置は画面上の CSS ピクセル。 */
export interface MinimapState {
  visible: boolean;
  map: Rect;
  gauge: Rect;
  pointCount: number;
  basis: MinimapBasis;
  extent: MinimapExtent;
  camera: {
    /** 印の位置（範囲の外なら枠の縁に寄せた位置） */
    x: number;
    y: number;
    /** 寄せる前の位置 */
    rawX: number;
    rawY: number;
    outside: boolean;
    /** 面の座標と奥行き */
    plane: Vec3;
  };
  heading: {
    /** 視線を面へ投影した向き（画面上、下向きが y の正。単位ベクトル。面に垂直なら 0, 0） */
    x: number;
    y: number;
    /** 視線のうち面に沿った成分の長さ（0..1） */
    length: number;
    /** atan2(-y, x) を度で（右が 0、上が 90） */
    angleDeg: number;
  };
  depth: {
    /** カメラの奥行き w（上が手前＝w が大きい） */
    value: number;
    /** 目盛りの印の高さ（画面上） */
    y: number;
    outside: boolean;
    /** 目盛りの上端・下端の w */
    top: number;
    bottom: number;
    /** 全点の奥行きの範囲 */
    pointsMin: number;
    pointsMax: number;
  };
  selected: null | { index: number; x: number; y: number; outside: boolean; depthY: number; depthOutside: boolean };
}

export interface MinimapPoint {
  /** 画面上の位置（枠に寄せない） */
  x: number;
  y: number;
  /** 目盛り上の高さ（目盛りの範囲に収めない） */
  depthY: number;
  plane: Vec3;
  /** 地図の内側か */
  inside: boolean;
}

export interface MinimapDebug {
  getState(): MinimapState;
  /** ワールド座標 → ミニマップ上の位置 */
  worldToMinimap(p: Vec3): MinimapPoint;
  /** 画面上の位置（地図の中）→ ワールド座標。奥行きは depth（省略時は現在のカメラの奥行き） */
  minimapToWorld(clientX: number, clientY: number, depth?: number): Vec3;
  setVisible(visible: boolean): void;
  /** 描画ループと同じ描画を 1 回行い、画面の描画バッファの画素を返す（RGBA8、上の行から）。withMinimap で有無を指定 */
  readFrame(withMinimap?: boolean): { width: number; height: number; rgba: Uint8Array };
  /** 描いている点の数 */
  pointCount: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '0');

/**
 * 画面の右下の、全体の俯瞰と現在位置・視線の向き。
 *
 * - 点群は同じレンダラーで、ビューポートとシザーを地図の領域に切り替えて描く（別の canvas は作らない）。
 *   描く前後で、ビューポート・シザー・シザーテスト・autoClear・描画先・クリア色を保存して戻す。クリアはしない
 *   （背景は半透明の面を重ねて描く）ので、本体の描画は地図の領域の外では 1 画素も変わらない。
 * - 枠・カメラの印・視野の図形・選択中の点・奥行きの目盛りは、地図に重ねた SVG で描く。
 *   この要素がポインタを受けるので、地図の上のクリックやドラッグ、ホバーは本体（canvas）へ届かない。
 */
export class Minimap {
  readonly debug: MinimapDebug;
  private readonly deps: MinimapDeps;
  private readonly basis: MinimapBasis;
  private readonly extent: MinimapExtent;
  private readonly scene = new THREE.Scene();
  private readonly orthoCamera: THREE.OrthographicCamera;
  private readonly pointsMaterial: THREE.ShaderMaterial;
  private readonly pointCount: number;
  private layout: MinimapLayout;
  private visible = true;
  private lastSizeKey = '';
  private lastPixelRatio = 0;
  private readonly root: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly el: {
    mapGroup: SVGGElement; gaugeGroup: SVGGElement; border: SVGRectElement; gaugeBg: SVGRectElement;
    hist: SVGGElement; rangeTop: SVGLineElement; rangeBottom: SVGLineElement; labelNear: SVGTextElement; labelFar: SVGTextElement;
    fan: SVGPolygonElement; heading: SVGLineElement; cam: SVGCircleElement; camArrow: SVGPolygonElement; outsideText: SVGTextElement;
    sel: SVGCircleElement; depthCam: SVGPolygonElement; depthCamLine: SVGLineElement; depthSel: SVGLineElement;
  };
  private readonly histogram: number[];
  private down: { id: number; x: number; y: number } | null = null;
  private readonly saved = {
    viewport: new THREE.Vector4(), scissor: new THREE.Vector4(), clear: new THREE.Color(), size: new THREE.Vector2(),
  };
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3();

  constructor(deps: MinimapDeps) {
    this.deps = deps;
    this.basis = minimapBasis(deps.axes);
    this.extent = computeExtent(deps.positions, this.basis);
    this.histogram = depthHistogram(deps.positions, this.basis, this.extent, HIST_BINS);
    const { center: c, half } = this.extent;

    // ---- 点群（面の座標 u, v に直して持つ。奥の点から順に描き、手前の点が上に重なる）----
    const count = Math.floor(deps.positions.length / 3);
    const idx = sampleIndices(count);
    this.pointCount = idx.length;
    const order = Array.from(idx);
    const ws = new Float32Array(count);
    for (const i of order) ws[i] = toPlane([deps.positions[3 * i]!, deps.positions[3 * i + 1]!, deps.positions[3 * i + 2]!], this.basis)[2];
    order.sort((a, b) => ws[a]! - ws[b]! || a - b);
    const colors = labelColors(Math.max(1, deps.labelCount));
    const pos = new Float32Array(3 * order.length);
    const col = new Float32Array(3 * order.length);
    order.forEach((i, k) => {
      const q = toPlane([deps.positions[3 * i]!, deps.positions[3 * i + 1]!, deps.positions[3 * i + 2]!], this.basis);
      pos[3 * k] = q[0];
      pos[3 * k + 1] = q[1];
      pos[3 * k + 2] = 0;
      const rgb = colors[(deps.labels[i] ?? 0) % colors.length]!;
      col.set(rgb, 3 * k);
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    this.pointsMaterial = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 2 } },
      vertexShader: /* glsl */`
        attribute vec3 aColor;
        uniform float uSize;
        varying vec3 vColor;
        void main() {
          vColor = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uSize;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor;
        void main() { gl_FragColor = vec4(vColor, 1.0); }`,
      // 背景の面（半透明）と同じ「透明」の描画順に入れ、renderOrder で背景 → 点の順に描く
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    const points = new THREE.Points(geom, this.pointsMaterial);
    points.frustumCulled = false;
    points.renderOrder = 1;

    // ---- 背景の半透明の面 ----
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * half, 2 * half),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Vector3(...PANEL_RGB) }, uOpacity: { value: PANEL_OPACITY } },
        vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 uColor; uniform float uOpacity; void main() { gl_FragColor = vec4(uColor, uOpacity); }',
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    panel.position.set(c[0], c[1], -0.5);
    panel.frustumCulled = false;
    panel.renderOrder = 0;
    this.scene.add(panel, points);
    this.orthoCamera = new THREE.OrthographicCamera(c[0] - half, c[0] + half, c[1] + half, c[1] - half, -1, 1);
    this.orthoCamera.position.set(0, 0, 0);
    this.orthoCamera.updateMatrixWorld();

    // ---- オーバーレイ ----
    this.layout = this.currentLayout();
    this.root = document.createElement('div');
    this.root.id = 'minimap';
    this.root.setAttribute('role', 'img');
    this.root.setAttribute('aria-label', 'ミニマップ：全体の俯瞰と現在の位置・視線の向き（クリックでその位置へ移動、M で表示の切り替え）');
    this.svg = svgEl('svg');
    const gaugeGroup = svgEl('g');
    const mapGroup = svgEl('g');
    this.el = {
      mapGroup, gaugeGroup,
      border: svgEl('rect', { class: 'mm-border', x: 0.5, y: 0.5 }),
      gaugeBg: svgEl('rect', { class: 'mm-gauge-bg', x: 0.5, y: 0.5 }),
      hist: svgEl('g', { class: 'mm-hist' }),
      rangeTop: svgEl('line', { class: 'mm-range' }),
      rangeBottom: svgEl('line', { class: 'mm-range' }),
      labelNear: svgEl('text', { class: 'mm-gauge-label' }),
      labelFar: svgEl('text', { class: 'mm-gauge-label' }),
      fan: svgEl('polygon', { class: 'mm-fan', fill: 'rgba(255,255,255,0.16)', stroke: 'rgba(255,255,255,0.85)', 'stroke-width': 1, 'stroke-linejoin': 'round' }),
      heading: svgEl('line', { class: 'mm-heading', stroke: CAMERA_COLOR, 'stroke-width': 2, 'stroke-linecap': 'round' }),
      cam: svgEl('circle', { class: 'mm-camera', r: 4.5, fill: CAMERA_COLOR, stroke: CAMERA_OUTLINE, 'stroke-width': 2 }),
      camArrow: svgEl('polygon', { class: 'mm-camera-outside', fill: CAMERA_COLOR, stroke: CAMERA_OUTLINE, 'stroke-width': 1.5 }),
      outsideText: svgEl('text', { class: 'mm-outside-text', x: 6, y: 14 }),
      sel: svgEl('circle', { class: 'mm-selected', r: 5, fill: 'none', stroke: SELECTED_COLOR, 'stroke-width': 2 }),
      depthCam: svgEl('polygon', { class: 'mm-depth-camera', fill: CAMERA_COLOR, stroke: CAMERA_OUTLINE, 'stroke-width': 1.5 }),
      depthCamLine: svgEl('line', { class: 'mm-depth-camera-line', stroke: CAMERA_COLOR, 'stroke-width': 2 }),
      depthSel: svgEl('line', { class: 'mm-depth-selected', stroke: SELECTED_COLOR, 'stroke-width': 2 }),
    };
    this.el.labelNear.textContent = '前';
    this.el.labelFar.textContent = '奥';
    this.el.outsideText.textContent = '範囲外';
    gaugeGroup.append(this.el.gaugeBg, this.el.hist, this.el.rangeTop, this.el.rangeBottom, this.el.labelNear, this.el.labelFar,
      this.el.depthSel, this.el.depthCamLine, this.el.depthCam);
    mapGroup.append(this.el.border, this.el.fan, this.el.heading, this.el.sel, this.el.cam, this.el.camArrow, this.el.outsideText);
    this.svg.append(gaugeGroup, mapGroup);
    const gaugeTitle = svgEl('title');
    gaugeTitle.textContent = '奥行き（上が手前）。白はカメラ、黄色は選択中の点。クリックでその奥行きへ移動';
    gaugeGroup.prepend(gaugeTitle);
    this.root.append(this.svg);
    deps.container.append(this.root);
    this.applyLayout();

    this.root.addEventListener('pointerdown', this.onPointerDown);
    this.root.addEventListener('pointerup', this.onPointerUp);
    this.root.addEventListener('pointercancel', this.onPointerCancel);
    this.root.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('dblclick', (e) => e.preventDefault());

    this.debug = {
      getState: () => this.getState(),
      worldToMinimap: (p) => this.worldToMinimap(p),
      minimapToWorld: (x, y, w) => this.minimapToWorld(x, y, w),
      setVisible: (v) => this.setVisible(v),
      readFrame: (withMinimap) => this.readFrame(withMinimap ?? this.visible),
      pointCount: this.pointCount,
    };
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.hidden = !visible;
    this.down = null;
    this.applyReserve();
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  /** 画面の大きさが変わったとき（描画ループでも毎フレーム確かめる）。 */
  resize(): void {
    const key = this.sizeKey();
    if (key === this.lastSizeKey) return;
    this.layout = this.currentLayout();
    this.applyLayout();
  }

  /** 本体の描画のあとに呼ぶ。地図の領域へ点群を描き、印と目盛りを更新する。 */
  render(): void {
    if (!this.visible) return;
    this.resize();
    this.drawPoints();
    this.updateOverlay(this.getState());
  }

  dispose(): void {
    this.root.remove();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }

  // ---------- 描画 ----------

  private drawPoints(): void {
    const r = this.deps.renderer;
    const s = this.saved;
    const pr = r.getPixelRatio();
    if (pr !== this.lastPixelRatio) {
      this.lastPixelRatio = pr;
      this.pointsMaterial.uniforms.uSize!.value = Math.max(1, Math.round(MINIMAP_POINT_CSS_PX * pr));
    }
    const { height: H } = r.getSize(s.size);
    const { map } = this.layout;
    r.getViewport(s.viewport);
    r.getScissor(s.scissor);
    const scissorTest = r.getScissorTest();
    const autoClear = r.autoClear;
    const target = r.getRenderTarget();
    r.getClearColor(s.clear);
    const clearAlpha = r.getClearAlpha();
    try {
      r.autoClear = false;
      const y = H - map.top - map.height; // WebGL のビューポートは左下が原点
      r.setViewport(map.left, y, map.width, map.height);
      r.setScissor(map.left, y, map.width, map.height);
      r.setScissorTest(true);
      r.render(this.scene, this.orthoCamera);
    } finally {
      r.setRenderTarget(target);
      r.setViewport(s.viewport);
      r.setScissor(s.scissor);
      r.setScissorTest(scissorTest);
      r.autoClear = autoClear;
      r.setClearColor(s.clear, clearAlpha);
    }
  }

  private readFrame(withMinimap: boolean): { width: number; height: number; rgba: Uint8Array } {
    this.deps.renderMain();
    if (withMinimap) { this.resize(); this.drawPoints(); }
    const gl = this.deps.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const raw = new Uint8Array(4 * w * h);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const rgba = new Uint8Array(raw.length);
    for (let y = 0; y < h; y++) rgba.set(raw.subarray(4 * w * (h - 1 - y), 4 * w * (h - y)), 4 * w * y);
    return { width: w, height: h, rgba };
  }

  // ---------- 配置 ----------

  private sizeKey(): string {
    const v = this.deps.renderer.getSize(this.saved.size);
    return `${v.x}x${v.y}`;
  }

  private currentLayout(): MinimapLayout {
    const v = this.deps.renderer.getSize(this.saved.size);
    this.lastSizeKey = `${v.x}x${v.y}`;
    return computeLayout(v.x, v.y);
  }

  private applyLayout(): void {
    const { outer, map, gauge } = this.layout;
    const st = this.root.style;
    st.left = `${outer.left}px`;
    st.top = `${outer.top}px`;
    st.width = `${outer.width}px`;
    st.height = `${outer.height}px`;
    this.svg.setAttribute('width', String(outer.width));
    this.svg.setAttribute('height', String(outer.height));
    this.svg.setAttribute('viewBox', `0 0 ${outer.width} ${outer.height}`);
    this.el.gaugeGroup.setAttribute('transform', `translate(${gauge.left - outer.left},0)`);
    this.el.mapGroup.setAttribute('transform', `translate(${map.left - outer.left},0)`);
    for (const r of [this.el.border, this.el.gaugeBg]) r.setAttribute('height', String(map.height - 1));
    this.el.border.setAttribute('width', String(map.width - 1));
    this.el.gaugeBg.setAttribute('width', String(gauge.width - 1));
    // 目盛り: 全点の奥行きの分布と範囲
    const gh = gauge.height, gw = gauge.width;
    this.el.hist.replaceChildren();
    const binH = gh / this.histogram.length;
    this.histogram.forEach((v, k) => {
      if (v <= 0) return;
      const w = Math.max(1, v * (gw - 6));
      // k = 0 が最も奥（目盛りの下端）
      this.el.hist.append(svgEl('rect', { x: (gw - w) / 2, y: gh - (k + 1) * binH, width: w, height: Math.max(1, binH - 0.5) }));
    });
    const [wmin, wmax] = this.extent.depthRange;
    const yTop = depthToGauge(wmax, this.extent, gh), yBottom = depthToGauge(wmin, this.extent, gh);
    for (const [line, y] of [[this.el.rangeTop, yTop], [this.el.rangeBottom, yBottom]] as const) {
      line.setAttribute('x1', '2'); line.setAttribute('x2', String(gw - 2));
      line.setAttribute('y1', fmt(y)); line.setAttribute('y2', fmt(y));
    }
    this.el.labelNear.setAttribute('x', String(gw / 2)); this.el.labelNear.setAttribute('y', '10');
    this.el.labelFar.setAttribute('x', String(gw / 2)); this.el.labelFar.setAttribute('y', String(gh - 3));
    this.applyReserve();
  }

  /** HUD（左下）が地図に重ならないように、右側に空けておく幅を CSS 変数で渡す。 */
  private applyReserve(): void {
    const reserve = this.visible ? this.layout.outer.width + 12 : 0;
    document.documentElement.style.setProperty('--minimap-reserve', `${reserve}px`);
  }

  // ---------- 状態と変換 ----------

  private cameraPlane(): Vec3 {
    const cam = this.deps.camera;
    cam.updateMatrixWorld();
    const p = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    return toPlane([p.x, p.y, p.z], this.basis);
  }

  worldToMinimap(p: Vec3): MinimapPoint {
    const { map, gauge } = this.layout;
    const q = toPlane(p, this.basis);
    const [mx, my] = planeToMap(q[0], q[1], this.extent, map.width);
    return {
      x: map.left + mx, y: map.top + my,
      depthY: gauge.top + depthToGauge(q[2], this.extent, gauge.height),
      plane: q,
      inside: mx >= 0 && my >= 0 && mx <= map.width && my <= map.height,
    };
  }

  minimapToWorld(clientX: number, clientY: number, depth?: number): Vec3 {
    const { map } = this.layout;
    const [u, v] = mapToPlane(clientX - map.left, clientY - map.top, this.extent, map.width);
    return fromPlane([u, v, depth ?? this.cameraPlane()[2]], this.basis);
  }

  getState(): MinimapState {
    const { map, gauge } = this.layout;
    const cam = this.deps.camera;
    const q = this.cameraPlane();
    const [rx, ry] = planeToMap(q[0], q[1], this.extent, map.width);
    const cl = clampToFrame(rx, ry, map.width, FRAME_INSET);
    const fig = this.figure(cam);
    const dRaw = depthToGauge(q[2], this.extent, gauge.height);
    const dc = clampRange(dRaw, 2, gauge.height - 2);
    const selIndex = this.deps.selected();
    let selected: MinimapState['selected'] = null;
    if (selIndex !== null && selIndex >= 0 && 3 * selIndex + 2 < this.deps.positions.length) {
      const p = this.deps.positions;
      const sq = toPlane([p[3 * selIndex]!, p[3 * selIndex + 1]!, p[3 * selIndex + 2]!], this.basis);
      const [sx, sy] = planeToMap(sq[0], sq[1], this.extent, map.width);
      const sc = clampToFrame(sx, sy, map.width, FRAME_INSET);
      const sd = clampRange(depthToGauge(sq[2], this.extent, gauge.height), 2, gauge.height - 2);
      selected = { index: selIndex, x: map.left + sc.x, y: map.top + sc.y, outside: sc.outside, depthY: gauge.top + sd.value, depthOutside: sd.outside };
    }
    const [hx, hy] = fig.heading;
    return {
      visible: this.visible,
      map: { ...map },
      gauge: { ...gauge },
      pointCount: this.pointCount,
      basis: this.basis,
      extent: this.extent,
      camera: { x: map.left + cl.x, y: map.top + cl.y, rawX: map.left + rx, rawY: map.top + ry, outside: cl.outside, plane: q },
      heading: { x: hx, y: hy, length: fig.headingLength, angleDeg: (Math.atan2(-hy, hx) * 180) / Math.PI },
      depth: {
        value: q[2], y: gauge.top + dc.value, outside: dc.outside,
        top: this.extent.center[2] + this.extent.half, bottom: this.extent.center[2] - this.extent.half,
        pointsMin: this.extent.depthRange[0], pointsMax: this.extent.depthRange[1],
      },
      selected,
    };
  }

  private figure(cam: THREE.PerspectiveCamera) {
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    this.tmpRight.set(e[0]!, e[1]!, e[2]!).normalize();
    this.tmpUp.set(e[4]!, e[5]!, e[6]!).normalize();
    this.tmpDir.set(-e[8]!, -e[9]!, -e[10]!).normalize();
    return viewFigure({
      forward: this.tmpDir.toArray() as Vec3,
      right: this.tmpRight.toArray() as Vec3,
      up: this.tmpUp.toArray() as Vec3,
      fovDeg: cam.fov,
      aspect: cam.aspect,
    }, this.basis);
  }

  private updateOverlay(s: MinimapState): void {
    const { map, gauge } = this.layout;
    const el = this.el;
    const cx = s.camera.x - map.left, cy = s.camera.y - map.top;
    const L = FIGURE_LENGTH * map.width;
    const fig = this.figure(this.deps.camera);
    el.fan.setAttribute('points', fig.hull.map(([x, y]) => `${fmt(cx + x * L)},${fmt(cy + y * L)}`).join(' '));
    el.heading.setAttribute('x1', fmt(cx));
    el.heading.setAttribute('y1', fmt(cy));
    el.heading.setAttribute('x2', fmt(cx + s.heading.x * s.heading.length * L));
    el.heading.setAttribute('y2', fmt(cy + s.heading.y * s.heading.length * L));
    el.cam.setAttribute('cx', fmt(cx));
    el.cam.setAttribute('cy', fmt(cy));
    el.cam.style.display = s.camera.outside ? 'none' : '';
    el.outsideText.style.display = s.camera.outside ? '' : 'none';
    if (s.camera.outside) {
      // 外向きの矢印（中心から本当の位置の向き）
      const dx = s.camera.rawX - (map.left + map.width / 2), dy = s.camera.rawY - (map.top + map.height / 2);
      const a = Math.atan2(dy, dx);
      const tip = (r: number, t: number) => `${fmt(cx + r * Math.cos(a + t))},${fmt(cy + r * Math.sin(a + t))}`;
      el.camArrow.setAttribute('points', [tip(7, 0), tip(9, 2.6), tip(3, Math.PI), tip(9, -2.6)].join(' '));
      el.camArrow.style.display = '';
    } else {
      el.camArrow.style.display = 'none';
    }
    if (s.selected) {
      el.sel.style.display = '';
      el.sel.setAttribute('cx', fmt(s.selected.x - map.left));
      el.sel.setAttribute('cy', fmt(s.selected.y - map.top));
      el.depthSel.style.display = '';
      const y = fmt(s.selected.depthY - gauge.top);
      el.depthSel.setAttribute('x1', '1'); el.depthSel.setAttribute('x2', String(gauge.width - 1));
      el.depthSel.setAttribute('y1', y); el.depthSel.setAttribute('y2', y);
    } else {
      el.sel.style.display = 'none';
      el.depthSel.style.display = 'none';
    }
    // 目盛りのカメラの印: 横線と、右端から差す三角。範囲の外なら端で外向きの三角
    const dy = s.depth.y - gauge.top, gw = gauge.width;
    el.depthCamLine.setAttribute('x1', '1'); el.depthCamLine.setAttribute('x2', String(gw - 1));
    el.depthCamLine.setAttribute('y1', fmt(dy)); el.depthCamLine.setAttribute('y2', fmt(dy));
    if (s.depth.outside) {
      const up = s.depth.value > s.depth.top; // 手前の外
      const tipY = up ? dy - 1 : dy + 1, baseY = up ? dy + 7 : dy - 7;
      el.depthCam.setAttribute('points', `${fmt(gw / 2)},${fmt(tipY)} ${fmt(gw / 2 + 6)},${fmt(baseY)} ${fmt(gw / 2 - 6)},${fmt(baseY)}`);
    } else {
      el.depthCam.setAttribute('points', `${fmt(gw - 1)},${fmt(dy - 5)} ${fmt(gw - 1)},${fmt(dy + 5)} ${fmt(gw - 8)},${fmt(dy)}`);
    }
    this.root.classList.toggle('outside', s.camera.outside || s.depth.outside);
  }

  // ---------- クリックで移動 ----------

  private readonly onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    if (e.button !== 0) { this.down = null; return; }
    this.down = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try { this.root.setPointerCapture(e.pointerId); } catch { /* 合成イベントでは失敗してよい */ }
  };

  private readonly onPointerCancel = (): void => {
    this.down = null;
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    if (!d || d.id !== e.pointerId || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) return;
    this.moveToClient(e.clientX, e.clientY);
  };

  /** 画面上の位置（地図または目盛りの中）へ、視線の向きを保ったまま移動する。 */
  private moveToClient(x: number, y: number): void {
    const { map, gauge } = this.layout;
    const q = this.cameraPlane();
    let target: Vec3;
    if (x >= map.left && x <= map.left + map.width && y >= map.top && y <= map.top + map.height) {
      const [u, v] = mapToPlane(x - map.left, y - map.top, this.extent, map.width);
      target = [u, v, q[2]];
    } else if (x >= gauge.left && x <= gauge.left + gauge.width && y >= gauge.top && y <= gauge.top + gauge.height) {
      const t = (y - gauge.top) / gauge.height; // 0 が上端（手前）
      target = [q[0], q[1], this.extent.center[2] + (1 - 2 * t) * this.extent.half];
    } else {
      return;
    }
    const cam = this.deps.camera;
    cam.updateMatrixWorld();
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const pos = fromPlane(target, this.basis);
    this.deps.moveTo({ pos, look: [pos[0] + dir.x * 0.25, pos[1] + dir.y * 0.25, pos[2] + dir.z * 0.25] }, MINIMAP_MOVE_SECONDS);
  }
}
