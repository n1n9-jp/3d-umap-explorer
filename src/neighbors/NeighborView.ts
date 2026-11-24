/**
 * 選択中の点の「元の空間で近い点」の表示（DatasetView ごとに作り、`dispose` で外す）。
 *
 * - 点を選ぶと（`onSelect`）、kNN グラフ（`NeighborsShared.source`。まだなら、ここで読み込み始める）から元の空間での近傍を取り出し、
 *   表示している埋め込みの座標の空間索引で、同じ数の 3 次元での近傍を求めて、一覧（情報パネル）と地図の上の表示を作る。
 * - 地図の上の表示（`NeighborOverlay` の輪と線、画面の外の近傍の方向を示す画面の端の印）は、N キー（`NeighborsShared.enabled`）で切り替える。
 *   位置は毎フレーム、点群に描いている座標（計算の途中の表示や、新旧の座標の間の移動も含む）から取り直すので、点が動いている間も合う。
 * - 一覧の項目を押すと、その点を選択して手前へ飛ぶ。戻る操作で、選択の履歴の 1 つ前へ戻る（そこへも飛ぶ）。
 */
import * as THREE from 'three';
import type { PointCloud } from '../render/pointCloud';
import { NEIGHBOR_COLOR, NeighborOverlay } from '../render/neighborOverlay';
import { NeighborList } from '../interaction/neighborList';
import type { PointInfoSource } from '../interaction/infoPanel';
import { compareNeighbors, mapNeighbors, originalNeighbors, summaryText, type KNearestSearch } from './neighbors';
import { placeOnEdge, type EdgePlacement } from './edge';
import type { NeighborsShared } from './shared';

/** 画面の端の印を、端からこの距離（CSS ピクセル）の内側に置く（上は、データセットの選択欄の行の下） */
export const EDGE_MARGINS = { top: 50, right: 18, bottom: 18, left: 18 };

export interface NeighborViewDeps {
  doc: Document;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  cloud: PointCloud;
  shared: NeighborsShared;
  /** 表示中の埋め込みの座標（3 次元での近傍の判定に使う。空間索引と同じ座標） */
  positions: Float32Array;
  /** 点群に描いている座標（地図の上の表示の位置に使う） */
  shownPositions(): Float32Array;
  /** 表示中の埋め込みの座標の空間索引 */
  index: KNearestSearch;
  info: PointInfoSource;
  /** 点を選択して、その点の手前へ飛ぶ */
  selectAndFly(index: number): void;
  /**
   * 単語の文字を出している点の、点の中心から見た文字の矩形（CSS ピクセル）。近傍の輪を文字に重ねず、文字を囲む矩形にするのに使う。
   * 単語のデータセットでなければ省略
   */
  wordBoxes?(): Map<number, { dx: number; dy: number; hw: number; hh: number }>;
}

/** 検証用の状態（`window.__explorer.neighbors.getState()`）。 */
export interface NeighborViewState {
  /** 表示中のデータセットに kNN グラフがあり、使えるか */
  available: boolean;
  /** 地図の上の表示（N キー）が有効か */
  enabled: boolean;
  /** kNN グラフの読み込みの状態 */
  graph: 'unavailable' | 'idle' | 'loading' | 'ready' | 'error' | 'disposed';
  /** kNN グラフの読み込みを始めた回数 */
  graphLoads: number;
  selected: number | null;
  /** 選択中の点の、元の空間での近傍（近い順）・距離・3 次元での近傍（近い順）・一致 */
  original: number[];
  originalDistances: number[];
  map: number[];
  inMap: boolean[];
  matches: number;
  count: number;
  summary: string | null;
  /** 一覧の状態と、一覧に出している点の番号（DOM から読む） */
  list: { state: string; indices: number[]; marks: string[]; summary: string; hint: string; focused: number };
  /** 地図の上の表示（輪と線）を描いているか */
  overlayVisible: boolean;
  /** 線の端点（画面上の CSS ピクセル。選択中の点と近傍を投影した位置。カメラの前にあるものだけ） */
  lines: { from: [number, number]; to: [number, number]; rank: number; index: number }[];
  /** 画面の端の印 */
  edgeMarkers: { index: number; rank: number; x: number; y: number; behind: boolean }[];
  /** 選択の履歴（戻る先。古い順） */
  history: number[];
}

export class NeighborView {
  readonly overlay: NeighborOverlay;
  private readonly deps: NeighborViewDeps;
  private readonly list: NeighborList;
  private readonly edgeRoot: HTMLElement;
  private readonly edgeEls: HTMLElement[] = [];
  private selected: number | null = null;
  private original: number[] = [];
  private originalDistances: number[] = [];
  private map: number[] = [];
  private inMap: boolean[] = [];
  private matches = 0;
  private ready = false;
  private token = 0;
  private navigatingBack = false;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly v = new THREE.Vector4();
  private readonly vpMatrix = new THREE.Matrix4();
  private lastEdges: NeighborViewState['edgeMarkers'] = [];
  private readonly startBuf = new Float32Array(3);
  private endBuf: Float32Array;

  constructor(deps: NeighborViewDeps) {
    this.deps = deps;
    const n = deps.shared.count;
    this.endBuf = new Float32Array(3 * n);
    this.overlay = new NeighborOverlay(deps.cloud, n);
    this.list = new NeighborList(deps.doc, deps.info, {
      onFocus: (rank) => this.overlay.setFocus(rank),
      onPick: (i) => this.deps.selectAndFly(i),
      onBack: () => this.back(),
    });
    const edgeRoot = deps.doc.getElementById('neighbor-edges');
    if (!edgeRoot) throw new Error('#neighbor-edges がありません');
    this.edgeRoot = edgeRoot;
    for (let k = 0; k < n; k++) {
      const el = deps.doc.createElement('div');
      el.className = 'nb-edge';
      el.hidden = true;
      el.style.setProperty('--c', NEIGHBOR_COLOR);
      const arrow = deps.doc.createElement('span');
      arrow.className = 'nb-edge-arrow';
      const label = deps.doc.createElement('span');
      label.className = 'nb-edge-rank';
      label.textContent = String(k + 1);
      el.append(arrow, label);
      this.edgeRoot.append(el);
      this.edgeEls.push(el);
    }
    this.unsubscribe = deps.shared.onChange(() => this.refreshVisibility());
    this.refreshVisibility();
  }

  get available(): boolean {
    return this.deps.shared.source?.available ?? false;
  }

  /** 選択が変わったとき（InteractionController から）。 */
  onSelect(index: number | null): void {
    if (this.disposed) return;
    const shared = this.deps.shared;
    if (this.available) {
      shared.history.record(index, { back: this.navigatingBack });
      this.list.setBackAvailable(shared.history.canGoBack);
    }
    if (index === this.selected && this.ready) return;
    this.selected = index;
    this.ready = false;
    this.original = [];
    this.originalDistances = [];
    this.map = [];
    this.inMap = [];
    this.matches = 0;
    const token = ++this.token;
    const source = shared.source;
    if (index === null || !source || !source.available) {
      this.list.set({ kind: 'hidden' });
      this.overlay.setNeighbors([]);
      this.refreshVisibility();
      return;
    }
    // 3 次元での近傍は、いま表示している埋め込みの座標で求める
    this.map = mapNeighbors(this.deps.index, this.deps.positions, index, shared.count);
    const graph = source.graph;
    if (graph) {
      this.apply(index);
      return;
    }
    this.list.set({ kind: 'loading' });
    this.overlay.setNeighbors([]);
    this.refreshVisibility();
    source.load().then(() => {
      if (this.disposed || token !== this.token || this.deps.shared.source !== source) return;
      this.apply(index);
    }, (e: unknown) => {
      if (this.disposed || token !== this.token || this.deps.shared.source !== source) return;
      console.warn('元の空間での kNN グラフを読み込めませんでした:', e);
      this.list.set({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  }

  /** 選択の履歴の 1 つ前へ戻り、その点の手前へ飛ぶ。戻れなければ何もしない。 */
  back(): void {
    const prev = this.deps.shared.history.back();
    if (prev === null) { this.list.setBackAvailable(false); return; }
    this.navigatingBack = true;
    try {
      this.deps.selectAndFly(prev);
    } finally {
      this.navigatingBack = false;
    }
  }

  /** 毎フレーム（描画の前）。地図の上の表示の位置と、画面の端の印を合わせる。 */
  update(width: number, height: number): void {
    if (this.disposed) return;
    const show = this.overlayShown();
    if (!show || this.selected === null) {
      this.hideEdges();
      return;
    }
    const pos = this.deps.shownPositions();
    const s = this.selected;
    this.startBuf[0] = pos[3 * s]!; this.startBuf[1] = pos[3 * s + 1]!; this.startBuf[2] = pos[3 * s + 2]!;
    const n = this.original.length;
    for (let k = 0; k < n; k++) {
      const j = this.original[k]!;
      this.endBuf[3 * k] = pos[3 * j]!; this.endBuf[3 * k + 1] = pos[3 * j + 1]!; this.endBuf[3 * k + 2] = pos[3 * j + 2]!;
    }
    this.overlay.setPositions(this.startBuf, this.endBuf.subarray(0, 3 * n));
    const boxes = this.deps.wordBoxes?.();
    this.overlay.setWordBoxes((k) => (boxes ? boxes.get(this.original[k]!) ?? null : null));
    this.updateEdges(width, height);
  }

  /** 描画バッファの大きさと倍率（DatasetView.resize から）。 */
  resize(bufferWidth: number, bufferHeight: number, pixelRatio: number): void {
    this.overlay.setViewport(bufferWidth, bufferHeight, pixelRatio);
  }

  getState(): NeighborViewState {
    const src = this.deps.shared.source;
    const listState = this.list.getState();
    const doc = this.deps.doc;
    const buttons = [...doc.querySelectorAll<HTMLButtonElement>('#info-neighbors-list button.nb-item')];
    return {
      available: this.available,
      enabled: this.deps.shared.enabled,
      graph: src ? src.status : 'unavailable',
      graphLoads: src?.loads ?? 0,
      selected: this.selected,
      original: [...this.original],
      originalDistances: [...this.originalDistances],
      map: [...this.map],
      inMap: [...this.inMap],
      matches: this.matches,
      count: this.deps.shared.count,
      summary: this.ready ? summaryText(this.matches, this.original.length) : null,
      list: {
        state: listState.kind,
        indices: buttons.map((b) => Number(b.dataset.index)),
        marks: buttons.map((b) => b.querySelector('.nb-mark')?.textContent ?? ''),
        summary: doc.getElementById('info-neighbors-summary')?.textContent ?? '',
        hint: doc.getElementById('info-neighbors-hint')?.textContent ?? '',
        focused: this.list.focused,
      },
      overlayVisible: this.overlay.visible,
      lines: this.overlay.visible ? this.projectLines() : [],
      edgeMarkers: this.lastEdges.map((e) => ({ ...e })),
      history: this.deps.shared.history.entries(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.token++;
    this.unsubscribe();
    this.list.dispose();
    for (const el of this.edgeEls) el.remove();
    this.edgeEls.length = 0;
    this.overlay.dispose();
  }

  // ---------------------------------------------------------------- 内部

  private apply(index: number): void {
    const graph = this.deps.shared.source?.graph;
    if (!graph) return;
    const n = this.deps.shared.count;
    const o = originalNeighbors(graph, index, n);
    this.original = o.indices;
    this.originalDistances = o.distances;
    // 地図での近傍は、元の空間での近傍と同じ数で比べる（グラフの k が一覧の数より小さいときも合わせる）
    if (this.map.length > o.indices.length) this.map = this.map.slice(0, o.indices.length);
    const cmp = compareNeighbors(this.original, this.map);
    this.inMap = cmp.inMap;
    this.matches = cmp.matches;
    this.ready = true;
    this.list.set({ kind: 'ready', items: this.original.map((j, k) => ({ index: j, inMap: cmp.inMap[k]! })), matches: cmp.matches });
    this.overlay.setNeighbors(cmp.inMap);
    this.overlay.setFocus(-1);
    this.refreshVisibility();
  }

  private overlayShown(): boolean {
    return this.deps.shared.enabled && this.ready && this.selected !== null && this.original.length > 0;
  }

  private refreshVisibility(): void {
    if (this.disposed) return;
    const show = this.overlayShown();
    this.overlay.setVisible(show);
    if (!show) this.hideEdges();
  }

  private hideEdges(): void {
    for (const el of this.edgeEls) if (!el.hidden) el.hidden = true;
    this.lastEdges = [];
  }

  private computeViewProjection(): THREE.Matrix4 {
    const cam = this.deps.camera;
    cam.updateMatrixWorld();
    return this.vpMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(this.deps.cloud.mesh.matrixWorld);
  }

  private place(m: THREE.Matrix4, pos: ArrayLike<number>, i: number, width: number, height: number): EdgePlacement {
    this.v.set(pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!, 1).applyMatrix4(m);
    return placeOnEdge(this.v.x, this.v.y, this.v.w, width, height, EDGE_MARGINS);
  }

  /** 画面の外（またはカメラの後ろ）の近傍の方向を、画面の端の印で示す。 */
  private updateEdges(width: number, height: number): void {
    const m = this.computeViewProjection();
    const pos = this.deps.shownPositions();
    const edges: NeighborViewState['edgeMarkers'] = [];
    for (let k = 0; k < this.edgeEls.length; k++) {
      const el = this.edgeEls[k]!;
      const j = this.original[k];
      if (j === undefined) { if (!el.hidden) el.hidden = true; continue; }
      const p = this.place(m, pos, j, width, height);
      if (p.onScreen) { if (!el.hidden) el.hidden = true; continue; }
      edges.push({ index: j, rank: k, x: p.x, y: p.y, behind: p.behind });
      el.hidden = false;
      el.dataset.index = String(j);
      el.classList.toggle('is-behind', p.behind);
      el.style.opacity = String(k === this.list.focused ? 1 : 0.9 - 0.4 * (k / Math.max(1, this.edgeEls.length - 1)));
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      (el.firstElementChild as HTMLElement).style.transform = `rotate(${p.angle.toFixed(3)}rad)`;
    }
    this.lastEdges = edges;
  }

  /** 線の端点を、画面上の位置へ投影する（検証用。カメラの前にある端点の組だけ）。 */
  private projectLines(): NeighborViewState['lines'] {
    if (this.selected === null) return [];
    const canvas = this.deps.canvas;
    const rect = canvas.getBoundingClientRect();
    const m = this.computeViewProjection();
    const pos = this.deps.shownPositions();
    const proj = (i: number): [number, number] | null => {
      this.v.set(pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!, 1).applyMatrix4(m);
      if (!(this.v.w > 1e-9)) return null;
      return [rect.left + (this.v.x / this.v.w + 1) / 2 * rect.width, rect.top + (1 - this.v.y / this.v.w) / 2 * rect.height];
    };
    const from = proj(this.selected);
    if (!from) return [];
    const out: NeighborViewState['lines'] = [];
    this.original.forEach((j, k) => {
      const to = proj(j);
      if (to) out.push({ from, to, rank: k, index: j });
    });
    return out;
  }
}
