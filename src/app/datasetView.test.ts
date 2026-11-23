/**
 * DatasetView の生成の失敗・破棄・計算中の表示。WebGL と DOM を使う部品（点群・ピッキング・ホバーと選択・目印・ミニマップ・
 * 単語の文字）は差し替え、カメラ操作（CameraRig）は本物を使って、イベントのリスナーの登録と解除を数える。
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { faults } from './faults';

const h = vi.hoisted(() => ({
  log: [] as string[],
  failOn: new Set<string>(),
  clusterLabels: [] as { enabled: boolean; available: boolean; setEnabled(v: boolean): void }[],
}));

vi.mock('../render/pointCloud', async () => {
  const T = await import('three');
  class PointCloud {
    readonly mesh = Object.assign(new T.Group(), { geometry: { getAttribute: () => ({ needsUpdate: false }) } });
    readonly highlight = new T.Group();
    readonly params = { pointSize: 0.01 };
    readonly dotsOnly = true;
    constructor() { h.log.push('new PointCloud'); }
    set(p: { pointSize?: number }) { if (p.pointSize !== undefined) this.params.pointSize = p.pointSize; }
    setViewportHeight() {}
    setPixelRatio() {}
    setHighlight() {}
    getHighlight() { return null; }
    dispose() { h.log.push('dispose PointCloud'); }
  }
  return { PointCloud };
});
vi.mock('../picking/GpuPicker', () => ({
  GpuPicker: class {
    constructor() { h.log.push('new GpuPicker'); }
    dispose() { h.log.push('dispose GpuPicker'); }
    pick() { return Promise.resolve(null); }
    addLayer() { return () => {}; }
  },
}));
vi.mock('../picking/debug', () => ({ createPickingDebug: () => ({}) }));
vi.mock('../interaction/infoPanel', () => ({
  InfoPanel: class {
    constructor() { h.log.push('new InfoPanel'); }
    dispose() { h.log.push('dispose InfoPanel'); }
  },
}));
vi.mock('../interaction/InteractionController', () => ({
  InteractionController: class {
    constructor() { h.log.push('new InteractionController'); }
    dispose() { h.log.push('dispose InteractionController'); }
    getState() { return { selected: null as number | null }; }
    select() {}
  },
}));
vi.mock('../labels/ClusterLabels', () => ({
  ClusterLabels: class {
    available: boolean;
    private on = true;
    constructor(deps: { clusters: unknown[] }) {
      this.available = deps.clusters.length > 0;
      h.log.push('new ClusterLabels');
      h.clusterLabels.push(this);
    }
    get enabled() { return this.available && this.on; }
    setEnabled(v: boolean) { if (this.available) this.on = v; }
    toggle() { this.setEnabled(!this.on); }
    update() {}
    dispose() { h.log.push('dispose ClusterLabels'); }
  },
}));
vi.mock('../minimap/Minimap', () => ({
  Minimap: class {
    isVisible = true;
    constructor() {
      h.log.push('new Minimap');
      if (h.failOn.has('Minimap')) throw new Error('ミニマップを作れません');
    }
    resize() {}
    render() {}
    setVisible(v: boolean) { this.isVisible = v; }
    getState() { return { map: { left: 100, top: 200, width: 200, height: 200 } }; }
    dispose() { h.log.push('dispose Minimap'); }
  },
}));
vi.mock('../text/WordLabels', () => ({
  WordLabels: class {
    readonly group = new THREE.Group();
    constructor() {
      h.log.push('new WordLabels');
      if (h.failOn.has('WordLabels')) throw new Error('文字の種類が多く、グリフアトラスに入りません');
    }
    setEnabled() {}
    getState() { return { enabled: true }; }
    update() {}
    dispose() { h.log.push('dispose WordLabels'); }
  },
}));

import { DatasetView, type AppContext, type LoadedDataset } from './datasetView';

type Handler = () => void;
class FakeTarget {
  readonly listeners = new Map<string, Set<Handler>>();
  readonly style = { touchAction: 'auto' };
  ownerDocument?: { defaultView: FakeTarget };
  clientWidth = 800;
  clientHeight = 600;
  addEventListener(type: string, fn: Handler): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: Handler): void { this.listeners.get(type)?.delete(fn); }
  count(): number { let n = 0; for (const s of this.listeners.values()) n += s.size; return n; }
}

class FakeElement {
  id = '';
  textContent = '';
  hidden = false;
  readonly style: Record<string, string> = {};
  removed = false;
  setAttribute() {}
  /** 画面の端の UI の矩形（単語の文字が避ける領域）を読む処理のための、大きさ 0 の矩形 */
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  remove() { this.removed = true; }
}

function makeContext() {
  const win = new FakeTarget();
  const canvas = new FakeTarget();
  canvas.ownerDocument = { defaultView: win };
  const appended: FakeElement[] = [];
  const doc = {
    getElementById: () => new FakeElement(),
    createElement: () => new FakeElement(),
    body: { append: (e: FakeElement) => appended.push(e) },
  };
  const renderer = {
    domElement: canvas,
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(800, 600),
    getPixelRatio: () => 1,
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.0005, 12);
  camera.position.set(0, 0, 3);
  const ctx = { renderer, scene, camera, doc, hud: new FakeElement(), clipOverride: () => null } as unknown as AppContext;
  return { ctx, win, canvas, scene, appended };
}

function makeData(opts: { clusters?: boolean } = {}): LoadedDataset {
  const n = 50;
  const positions = new Float32Array(3 * n);
  for (let i = 0; i < positions.length; i++) positions[i] = Math.sin(i * 12.9898) * 0.5;
  const cluster = { id: 0, name: 'a', size: n, medoid: 0, center: [0, 0, 0], radius: 0.5, bbox: [[-1, -1, -1], [1, 1, 1]], majorityLabel: null, purity: null, parent: null };
  const manifest = {
    name: 'テスト', kind: 'text', count: n,
    density: { k: 8, knnDistP05: 0.01, knnDistP50: 0.02, knnDistP95: 0.04 },
    bounds: { center: [0, 0, 0], radius: 1 },
    clusters: opts.clusters === false ? undefined : { method: 'x', noise: 65535, levels: [{ name: 'coarse', params: {}, pointFile: '', clusters: [cluster] }] },
  };
  const ids = new Uint16Array(n);
  return {
    dir: 'x', atlas: null,
    arrays: {
      manifest, positions, text: Array.from({ length: n }, (_, i) => `w${i}`),
      bounds: { min: [-1, -1, -1], max: [1, 1, 1], center: [0, 0, 0], radius: 1 },
      clusterAssignments: opts.clusters === false ? undefined : [{ level: 'coarse', ids }],
    },
  } as unknown as LoadedDataset;
}

beforeEach(() => {
  h.log.length = 0;
  h.failOn.clear();
  h.clusterLabels.length = 0;
  faults.view = 0;
  faults.words = 0;
  faults.worker = 0;
});

describe('DatasetView の生成の失敗と後始末', () => {
  it('途中で失敗したら、それまでに作ったものをすべて破棄してから、例外を投げ直す（リスナー・シーン・資源）', () => {
    const { ctx, win, canvas, scene } = makeContext();
    h.failOn.add('Minimap');
    expect(() => new DatasetView(ctx, makeData())).toThrow('ミニマップを作れません');
    expect(win.count()).toBe(0);
    expect(canvas.count()).toBe(0);
    expect(scene.children.length).toBe(0);
    for (const name of ['PointCloud', 'GpuPicker', 'InfoPanel', 'InteractionController', 'ClusterLabels', 'WordLabels']) {
      expect(h.log, name).toContain(`dispose ${name}`);
    }
    expect(h.log).not.toContain('dispose Minimap'); // 作れなかったものは破棄しない
  });

  it('点群を作る前に失敗しても、破棄が例外を出さず、元の例外が伝わる', () => {
    const { ctx, win } = makeContext();
    const data = makeData();
    (data.arrays.manifest as { count: number }).count = 50;
    data.arrays.bounds = undefined as never; // 点群の中心を求めるところで失敗する
    expect(() => new DatasetView(ctx, data)).toThrow();
    expect(win.count()).toBe(0);
    expect(h.log).toContain('dispose PointCloud');
  });

  it('失敗のあとに作り直しても、カメラ操作のリスナーが二重に登録されない', () => {
    const { ctx, win, canvas } = makeContext();
    const one = new DatasetView(ctx, makeData());
    const single = { win: win.count(), canvas: canvas.count() };
    expect(single.win).toBeGreaterThan(0);
    one.dispose();
    expect(win.count() + canvas.count()).toBe(0);

    faults.view = 1; // すべて作ったあとで失敗させる
    expect(() => new DatasetView(ctx, makeData())).toThrow('検証用');
    expect(win.count() + canvas.count()).toBe(0);
    const rebuilt = new DatasetView(ctx, makeData());
    expect({ win: win.count(), canvas: canvas.count() }).toEqual(single);
    rebuilt.dispose();
    expect(win.count() + canvas.count()).toBe(0);
  });

  it('dispose は何度呼んでも 1 回だけ破棄する', () => {
    const { ctx } = makeContext();
    const v = new DatasetView(ctx, makeData());
    v.dispose();
    v.dispose();
    expect(h.log.filter((l) => l === 'dispose PointCloud').length).toBe(1);
  });
});

describe('単語の文字の生成だけが失敗したとき', () => {
  it('表示全体は失敗にせず、文字なし（words が null）で続け、知らせる文を持つ。ほかの部品は生きている', () => {
    const { ctx, win, scene } = makeContext();
    h.failOn.add('WordLabels');
    const v = new DatasetView(ctx, makeData());
    expect(v.words).toBeNull();
    expect(v.notice).toMatch(/単語の文字を表示できません.*グリフアトラス.*丸い点だけ/);
    expect(h.log).not.toContain('dispose PointCloud');
    expect(scene.children.length).toBe(1);
    expect(win.count()).toBeGreaterThan(0);
    v.dispose();
  });

  it('検証用の注入（faults.words）でも同じ。注入は 1 回で尽きる', () => {
    const { ctx } = makeContext();
    faults.words = 1;
    const a = new DatasetView(ctx, makeData());
    expect(a.words).toBeNull();
    expect(a.notice).not.toBeNull();
    a.dispose();
    const b = new DatasetView(ctx, makeData());
    expect(b.words).not.toBeNull();
    expect(b.notice).toBeNull();
    b.dispose();
  });
});

describe('計算の途中の表示（setComputingDisplay）', () => {
  it('目印を隠し、ミニマップのそばに「計算中」を出し、戻すと元の状態に戻す', () => {
    const { ctx, appended } = makeContext();
    const v = new DatasetView(ctx, makeData());
    const labels = h.clusterLabels[0]!;
    expect(labels.enabled).toBe(true);
    v.setComputingDisplay(true);
    expect(labels.enabled).toBe(false);
    expect(appended.length).toBe(1);
    expect(appended[0]!.textContent).toBe('計算中');
    expect(appended[0]!.style.left).toBe('104px'); // ミニマップの地図の左上
    expect(appended[0]!.style.top).toBe('204px');
    v.setComputingDisplay(true); // 二重に呼んでも、表示は 1 つ
    expect(appended.length).toBe(1);
    v.setComputingDisplay(false);
    expect(labels.enabled).toBe(true);
    expect(appended[0]!.removed).toBe(true);
    v.dispose();
  });

  it('利用者が目印を消していたら、戻したあとも消えたまま。隠している間の L キーは、戻すときの状態を切り替える', () => {
    const { ctx } = makeContext();
    const v = new DatasetView(ctx, makeData());
    const labels = h.clusterLabels[0]!;
    labels.setEnabled(false);
    v.setComputingDisplay(true);
    v.setComputingDisplay(false);
    expect(labels.enabled).toBe(false);

    labels.setEnabled(true);
    v.setComputingDisplay(true);
    v.toggleClusterLabels(); // 隠している間に L を押した
    expect(labels.enabled).toBe(false); // まだ出さない
    expect(v.captureUiState().labelsEnabled).toBe(false); // 作り直しへ引き継ぐ状態は、利用者の選択
    v.setComputingDisplay(false);
    expect(labels.enabled).toBe(false);
    v.toggleClusterLabels();
    expect(labels.enabled).toBe(true);
    v.dispose();
  });

  it('ミニマップを隠している間は「計算中」も隠し、dispose で外す。目印のないデータセットでも働く', () => {
    const { ctx, appended } = makeContext();
    const v = new DatasetView(ctx, makeData({ clusters: false }));
    v.setComputingDisplay(true);
    v.minimap.setVisible(false);
    v.update(0.016, 800, 600);
    expect(appended[0]!.hidden).toBe(true);
    v.dispose();
    expect(appended[0]!.removed).toBe(true);
  });
});
