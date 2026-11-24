import * as THREE from 'three';
import { BACKGROUND_COLOR } from './render/palette';
import { type ClipPlanes } from './render/clip';
import { formatView, parsePositiveNumber, parseView, type ViewSpec } from './render/view';
import type { CameraState } from './app/cameraRig';
import { renderHud } from './app/hud';
import type { PickResult } from './picking/GpuPicker';
import type { PickingDebug } from './picking/debug';
import { bindAutoSpeedKey } from './app/autoSpeedKey';
import { bindShortcut, isShortcutPress, isFromEditable } from './app/keyEvents';
import type { InteractionState } from './interaction/InteractionController';
import type { StopDistance } from './interaction/stopDistance';
import type { ClusterLabelsState } from './labels/ClusterLabels';
import type { MinimapDebug } from './minimap/Minimap';
import type { PointCloud } from './render/pointCloud';
import { faults, type Faults } from './app/faults';
import { DatasetView, loadDataset, releaseLoadedDataset, type AppContext, type LoadedDataset } from './app/datasetView';
import {
  FALLBACK_CATALOG, parseCatalog, resolveDatasetParam, searchForDataset, type DatasetCatalog, type DatasetTarget,
} from './data/catalog';
import { DatasetSwitcher } from './app/datasetSwitcher';
import { colorIndexHex, type PointColoring } from './render/colorScheme';
import type { SpatialIndex } from './spatial/SpatialIndex';
import type { DatasetKind } from './data/manifest';
import type { EmbeddingHost, UmapFeatureState } from './compute/host';
import type { UmapFeature, UmapOutcome } from './compute/umapFeature';
import { embeddingStatusText, parseUrlParams, searchWithParams, type UmapParams } from './compute/params';
import type { WordLabelsState } from './text/WordLabels';
import { NeighborsShared } from './neighbors/shared';
import type { NeighborViewState } from './neighbors/NeighborView';

interface FrameStats { frames: number; meanMs: number; medianMs: number; p95Ms: number; maxMs: number }

/** 表示中のデータセットと、切り替えの状態（検証用）。 */
export interface DatasetState {
  /** 表示中のデータセット（一覧の id。一覧にないパスで開いたときは null）・場所・名前・種類。表示中のものがなければ null */
  current: { id: string | null; dir: string; name: string; kind: DatasetKind; count: number } | null;
  /** 読み込み中か */
  loading: boolean;
  /** 直近の切り替えの失敗（成功すると null） */
  error: string | null;
  /** 切り替えが完了した回数（起動時の読み込みを含む） */
  generation: number;
}

declare global {
  interface Window {
    __explorer?: {
      ready: boolean;
      error?: string;
      setView(view: ViewSpec): void;
      /** いまの画面の縦横比での、点群全体が収まるホームの視点（H キーの移動先、起動時の視点）。 */
      homeView(): ViewSpec;
      /** 現在のモード・位置・注視点・速度・速度の自動調整の状態。 */
      getState(): CameraState;
      measureFrames(n: number): Promise<FrameStats>;
      pointCloud: PointCloud;
      /** カメラのクリップ面（検証用）。override に値を渡すと、カメラの位置による決定の代わりにその値を使う（null で戻す） */
      clip: {
        get(): ClipPlanes;
        override(planes: ClipPlanes | null): void;
      };
      /** 画面上の位置（CSS ピクセル）に見えている点 */
      pick(clientX: number, clientY: number): Promise<PickResult | null>;
      /** ピッキングの検証用の補助 */
      picking: PickingDebug;
      /** ホバー・選択（src/interaction/）。ホバー中と選択中の点の番号、点へ飛ぶときに止まる距離 */
      interaction: {
        getState(): InteractionState;
        stopDistance(index: number): StopDistance;
        /** 点を選択する（null で解除。クリックと同じく情報パネルと元のデータで近い点を更新する。移動はしない） */
        select(index: number | null): void;
      };
      /** クラスタの目印と現在地（src/labels/）。クラスタのないデータセットでは available が false */
      labels: {
        getState(): ClusterLabelsState;
      };
      /** ミニマップ（src/minimap/）。状態、ワールド座標とミニマップ上の位置の変換、表示の切り替え */
      minimap: MinimapDebug;
      /** データセットの一覧・表示中のデータセット・切り替え（`?data=` と同じ形の値。失敗すると前の表示を保ってエラーを返す） */
      dataset: {
        getState(): DatasetState;
        list(): DatasetCatalog;
        switchTo(param: string): Promise<{ ok: boolean; error?: string }>;
        /** 点ごとの表示用の文字列（単語のデータセットだけ。なければ null） */
        text(index: number): string | null;
        /** 点の色（'#rrggbb'。描画・ミニマップ・情報パネルと同じ規則） */
        pointColor(index: number): string;
      };
      /** 近くの単語の文字（src/text/）。単語のデータセットでなければ state は null。enabled は K キーと同じ切り替え */
      words: {
        getState(): WordLabelsState | null;
        setEnabled(enabled: boolean): void;
        /** 点が新旧の位置の間を動いている間など、文字を止めているか */
        paused(): boolean;
      };
      /**
       * 選択中の点の「元のデータで近い点」（src/neighbors/）。`getState()` は、元の空間での近傍・3 次元での近傍・一致の数・
       * 一覧と地図の上の表示の状態（表示中のものがなければ null）。`setEnabled` は N キーと同じ切り替え。
       * `back()` は一覧の「前の点へ戻る」と同じ
       */
      neighbors: {
        getState(): NeighborViewState | null;
        setEnabled(enabled: boolean): void;
        back(): void;
      };
      /** 検証用の故障の注入（`src/app/faults.ts`）。次に起こす失敗の回数を書く */
      faults: Faults;
      /** 表示中の表示に出している、利用者への通知（単語の文字を作れなかったときなど。なければ null） */
      notice(): string | null;
      /** WebGL の資源の数（renderer.info.memory と programs） */
      memory(): { geometries: number; textures: number; programs: number };
      /**
       * ブラウザ内の UMAP の再計算（src/compute/。U キーのパネル）。`open()` までは計算の部分（チャンク・Worker・kNN グラフ）を読み込まない。
       * `getState()` は、読み込む前なら `{ loaded: false }`。
       */
      umap: {
        getState(): UmapFeatureState | { loaded: false };
        open(): Promise<void>;
        close(): void;
        compute(params: UmapParams, opts?: { force?: boolean }): Promise<UmapOutcome>;
        cancel(): void;
        revert(): Promise<UmapOutcome>;
        setPreview(enabled: boolean): Promise<void>;
        /** 保持している結果の、Worker が返した座標（正規化の前）。なければ null */
        raw(key: string): Float32Array | null;
        /** 表示中の埋め込みの座標（データに依存する部分が使っている座標）と、点群に描いている座標 */
        positions(): Float32Array;
        shownPositions(): Float32Array;
        /** 表示中の粗い階層のクラスタ（目印に使っているもの）。なければ null */
        clusters(): { id: number; name: string; center: [number, number, number]; radius: number; size: number; medoid: number }[] | null;
        /** 表示中の manifest の bounds・density・overview */
        structure(): unknown;
      };
    };
  }
}

const MAX_PIXEL_RATIO = 2;

async function loadCatalog(): Promise<DatasetCatalog> {
  try {
    const res = await fetch('data/datasets.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseCatalog(await res.json());
  } catch (e) {
    console.warn('データセットの一覧（data/datasets.json）を読めないので、MNIST だけを使います:', e);
    return FALLBACK_CATALOG;
  }
}

async function start(): Promise<void> {
  const doc = document;
  const container = doc.getElementById('app')!;
  const hud = doc.getElementById('hud')!;

  THREE.ColorManagement.enabled = false; // シェーダは sRGB の値をそのまま出力する

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  // 描画バッファの倍率。ブラウザのズームや別のモニタへの移動で devicePixelRatio が変わるので、resize() と描画ループで追従する
  const currentPixelRatio = () => Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  renderer.setPixelRatio(currentPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(new THREE.Color(BACKGROUND_COLOR), 1);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // クリップ面はデータを読んだあと、カメラの位置と点群の範囲（bounds）から毎フレーム決める（src/render/clip.ts）
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.0005, 12);

  let clipOverride: ClipPlanes | null = null;
  const ctx: AppContext = { renderer, scene, camera, doc, hud, clipOverride: () => clipOverride };

  // ---- データセット（src/app/datasetView.ts）。切り替えのたびに作り直す ----
  const catalog = await loadCatalog();
  let view: DatasetView | null = null;
  let target: DatasetTarget | null = null;
  /** 表示中のデータセットの、読み込んだ（事前計算の）データ。ブラウザで計算した埋め込みを表示していても、これは変わらない */
  let baseData: LoadedDataset | null = null;
  /** ブラウザ内の UMAP の再計算（使うときにだけ読み込む） */
  let umapFeature: UmapFeature | null = null;
  let umapFeaturePromise: Promise<UmapFeature> | null = null;
  const embeddingStatus = doc.getElementById('embedding-status');
  const umapOpenButton = doc.getElementById('umap-open') as HTMLButtonElement | null;
  const setEmbeddingStatus = (text: string, computed: boolean) => {
    if (!embeddingStatus) return;
    if (embeddingStatus.textContent !== text) embeddingStatus.textContent = text;
    embeddingStatus.classList.toggle('computed', computed);
  };
  const state: DatasetState = { current: null, loading: false, error: null, generation: 0 };
  let loadToken = 0;
  let wordsEnabled = true; // K キーの状態（データセットを切り替えても保つ）
  // 点が動いている間（文字を止めている間）は、DatasetView が止め終わったあとの状態として覚える
  const setWordsEnabled = (enabled: boolean) => { wordsEnabled = enabled; view?.setWordsEnabled(enabled); };
  // 元のデータで近い点（src/neighbors/）。kNN グラフと選択の履歴はデータセットごと、N キーの状態はデータセットをまたいで保つ
  const neighbors = new NeighborsShared();

  const switcher = new DatasetSwitcher(doc, catalog, (id) => { void switchTo(id, { pushHistory: true }); });

  const updateHud = () => {
    if (!view) return;
    const s = view.controller.getState();
    renderHud(hud, {
      datasetName: view.name,
      pointCount: view.arrays.manifest.count,
      pointSize: view.cloud.params.pointSize,
      mode: s.mode,
      speed: s.speed,
      autoSpeed: { available: s.autoSpeed.available, enabled: s.autoSpeed.enabled, effectiveSpeed: s.effectiveSpeed },
      viewParams: formatView({ pos: s.position, look: s.lookAt }),
      notice: view.notice ?? undefined,
      labels: view.clusterLabels.available, // L キー（クラスタのないデータセットでは使えない）
      words: view.words !== null, // K キー（単語のデータセットだけ）
      neighbors: view.neighbors?.available ?? false, // N キー（kNN グラフのあるデータセットだけ）
      minimap: true, // M キー
    });
  };

  const showHudError = (message: string) => {
    hud.textContent = `読み込みに失敗しました: ${message}`;
    hud.classList.add('error');
  };

  /** 読み込んだデータで表示を作り直す。作れなければ前のデータで作り直して、エラーを投げる。 */
  const install = (data: LoadedDataset, next: DatasetTarget, search: string | null) => {
    const pointSize = search !== null ? parsePositiveNumber(search, 'size') : null;
    const prev = view;
    const prevTarget = target;
    prev?.dispose();
    view = null;
    try {
      view = new DatasetView(ctx, data, { pointSize, words: wordsEnabled, neighbors });
    } catch (e) {
      // 作れなければ、前のデータで作り直して表示を保つ（視点はホーム）
      if (prev && prevTarget) {
        view = new DatasetView(ctx, prev.data, { coloring: prev.coloring, words: wordsEnabled, spatialIndex: prev.spatialIndex, neighbors });
        view.controller.onChange(() => updateHud());
        view.controller.setView(view.homeView());
      }
      throw e;
    }
    target = next;
    if (prev && prev.data !== data) releaseLoadedDataset(prev.data);
    baseData = data;
    neighbors.setDataset({ dir: data.dir, manifest: data.arrays.manifest }); // 前のデータセットの kNN グラフと選択の履歴を捨てる
    view.controller.onChange(() => updateHud()); // モードと速度の変化はすぐに見せる
    // URL の pos・look があればその視点、なければホームの視点から始める（切り替えでは常にホームの視点）
    view.controller.setView(search !== null ? parseView(search, view.homeView()) : view.homeView());
    view.updateCameraDependent();
    hud.classList.remove('error');
    state.current = {
      id: next.entry?.id ?? null, dir: next.dir, name: view.name, kind: view.arrays.manifest.kind, count: view.arrays.manifest.count,
    };
    state.generation++;
    switcher.setCurrent(next.entry?.id ?? null, next.entry ? null : next.dir);
    setEmbeddingStatus(embeddingStatusText({ kind: 'precomputed', umap: data.arrays.manifest.umap }), false);
    if (umapOpenButton) umapOpenButton.disabled = false;
    umapFeature?.datasetChanged(); // 計算中の Worker を止め、保持していた結果を捨てる
    updateHud();
  };

  /**
   * 同じデータセットのまま、座標（ブラウザで計算した埋め込み）を差し替えて表示を作り直す。利用者の状態（点の大きさ・カメラ・モード・
   * 速度・自動調整・目印とミニマップの表示・選択）を引き継ぐ。読み込んだ画像は共有なので解放しない。
   */
  const replaceView = (data: LoadedDataset, options: { coloring: PointColoring | null; spatialIndex?: SpatialIndex }): DatasetView => {
    const prev = view;
    if (!prev) throw new Error('表示中のデータセットがありません');
    const ui = prev.captureUiState();
    prev.dispose();
    view = null;
    let next: DatasetView;
    try {
      next = new DatasetView(ctx, data, { pointSize: ui.pointSize, coloring: options.coloring, words: wordsEnabled, spatialIndex: options.spatialIndex, neighbors });
    } catch (e) {
      // 作れなければ（作りかけのものは DatasetView が破棄している）、前のデータで作り直して表示を保つ
      view = new DatasetView(ctx, prev.data, { pointSize: ui.pointSize, coloring: prev.coloring, words: wordsEnabled, spatialIndex: prev.spatialIndex, neighbors });
      view.controller.onChange(() => updateHud());
      view.applyUiState(ui);
      throw e;
    }
    view = next;
    next.controller.onChange(() => updateHud());
    next.applyUiState(ui);
    updateHud();
    return next;
  };

  const umapHost: EmbeddingHost = {
    doc,
    view: () => view,
    baseData: () => baseData,
    generation: () => state.generation,
    knnGraph: () => neighbors.knnGraph(),
    replaceView,
    setUrlParams: (p) => {
      const url = `${window.location.pathname}${searchWithParams(window.location.search, p)}${window.location.hash}`;
      window.history.replaceState(window.history.state, '', url);
    },
    setEmbeddingStatus,
  };
  const loadUmapFeature = (): Promise<UmapFeature> => {
    umapFeaturePromise ??= import('./compute/umapFeature').then((m) => {
      umapFeature = new m.UmapFeature(umapHost);
      return umapFeature;
    }, (e: unknown) => {
      umapFeaturePromise = null;
      throw e;
    });
    return umapFeaturePromise;
  };
  const toggleUmapPanel = (moveFocus: boolean) => {
    loadUmapFeature().then((f) => f.toggle(moveFocus), (e: unknown) => console.warn('UMAP の再計算を読み込めませんでした:', e));
  };
  umapOpenButton?.addEventListener('click', () => toggleUmapPanel(true));

  /** URL に nn・md・seed があれば、読み込みのあとに同じ計算をして表示する。 */
  const applyUrlEmbedding = (search: string) => {
    const p = parseUrlParams(search);
    if (p === null) return;
    if ('error' in p) { console.warn(`URL の nn・md・seed を使えません: ${p.error}`); return; }
    if (!baseData?.arrays.manifest.knn) { console.warn('このデータセットには kNN グラフがないため、URL の nn・md・seed は使えません'); return; }
    loadUmapFeature().then((f) => f.computeFromUrl(p), (e: unknown) => console.warn('UMAP の再計算を読み込めませんでした:', e));
  };

  /**
   * `?data=` と同じ形の値でデータセットを開く。読み込みに失敗したら、表示中のデータセットを保ってエラーを表示する。
   * `search` を渡すと、その pos・look・size を使う（起動時と、ブラウザの戻る・進む）。
   */
  const switchTo = async (param: string, opts: { pushHistory?: boolean; search?: string } = {}): Promise<{ ok: boolean; error?: string }> => {
    const token = ++loadToken;
    state.loading = true;
    state.error = null;
    switcher.setLoading(true);
    let data: LoadedDataset | null = null;
    try {
      const next = resolveDatasetParam(param, catalog);
      data = await loadDataset(next.dir);
      if (token !== loadToken) { releaseLoadedDataset(data); return { ok: false, error: '別の切り替えで置き換えられました' }; }
      install(data, next, opts.search ?? null);
      if (opts.search) applyUrlEmbedding(opts.search);
      explorer.ready = true;
      delete explorer.error;
      if (opts.pushHistory) {
        const url = `${window.location.pathname}${searchForDataset(window.location.search, next)}${window.location.hash}`;
        window.history.pushState({ data: next.entry?.id ?? next.dir }, '', url);
      }
      state.loading = false;
      switcher.setLoading(false);
      switcher.setError(null);
      return { ok: true };
    } catch (err) {
      if (data && view?.data !== data) releaseLoadedDataset(data);
      const message = err instanceof Error ? err.message : String(err);
      if (token === loadToken) {
        state.loading = false;
        state.error = message;
        switcher.setLoading(false);
        switcher.setError(`読み込みに失敗しました: ${message}`);
        switcher.setCurrent(target?.entry?.id ?? null, target && !target.entry ? target.dir : null); // 選択欄を表示中のものへ戻す
        if (!view) showHudError(message);
      }
      console.warn('データセットの読み込みに失敗しました:', err);
      return { ok: false, error: message };
    }
  };

  // ブラウザの戻る・進むで、URL のデータセット（と視点）へ切り替える
  window.addEventListener('popstate', () => {
    const search = window.location.search;
    void switchTo(new URLSearchParams(search).get('data') ?? '', { search });
  });

  // ---- 画面の大きさ ----
  const resize = () => {
    renderer.setPixelRatio(currentPixelRatio());
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    view?.resize();
  };
  window.addEventListener('resize', resize);
  resize();

  // ---- キー操作（表示中のデータセットに対して働く。データセットを切り替えても付け直さない）----
  // 点の大きさを [ ] キーで変える
  window.addEventListener('keydown', (e) => {
    if (view && (e.key === '[' || e.key === ']') && !isFromEditable(e)) {
      const k = e.key === ']' ? 1.25 : 0.8;
      view.cloud.set({ pointSize: Math.min(0.1, Math.max(0.0005, view.cloud.params.pointSize * k)) });
    }
  });
  // O キーで飛行モードと俯瞰モードを切り替える
  window.addEventListener('keydown', (e) => {
    if (view && isShortcutPress(e, 'KeyO')) view.controller.toggle();
  });
  bindAutoSpeedKey(window, { toggleAutoSpeed: () => view?.controller.toggleAutoSpeed() }); // T キーで有効・無効を切り替える
  bindShortcut(window, 'KeyH', () => view?.controller.goHome(view.homeView())); // H キーでホームの視点へ戻る
  bindShortcut(window, 'KeyL', () => view?.toggleClusterLabels()); // L キーで目印の表示・非表示
  bindShortcut(window, 'KeyM', () => view?.minimap.toggle()); // M キーでミニマップの表示・非表示
  bindShortcut(window, 'KeyU', () => toggleUmapPanel(true)); // U キーで UMAP の再計算のパネルを開閉
  bindShortcut(window, 'KeyK', () => setWordsEnabled(!wordsEnabled)); // K キーで近くの単語の文字の表示・非表示
  bindShortcut(window, 'KeyN', () => neighbors.setEnabled(!neighbors.enabled)); // N キーで元のデータで近い点の、地図の上の表示の入切

  // ---- 描画ループ ----
  let frameTimes: number[] | null = null;
  let frameWanted = 0;
  let frameArmed = false;
  let frameResolve: ((s: FrameStats) => void) | null = null;
  let last = performance.now();
  let hudTimer = 0;

  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    if (frameTimes && frameArmed) {
      frameTimes.push(now - last);
      if (frameTimes.length >= frameWanted && frameResolve) {
        const s = [...frameTimes].sort((a, b) => a - b);
        const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
        frameResolve({
          frames: s.length,
          meanMs: s.reduce((a, b) => a + b, 0) / s.length,
          medianMs: pick(0.5),
          p95Ms: pick(0.95),
          maxMs: s[s.length - 1] as number,
        });
        frameTimes = null;
        frameResolve = null;
      }
    }
    frameArmed = frameTimes !== null; // 計測要求の直後のフレームは区間が不完全なので数えない
    last = now;

    // 画面の倍率（devicePixelRatio）が変わったら、画面の大きさが変わったときと同じ経路で、描画バッファ・点の大きさ・
    // ミニマップを合わせ直す（ズームやモニタの移動では resize イベントが来ないことがある）
    if (currentPixelRatio() !== renderer.getPixelRatio()) resize();
    umapFeature?.update(dt); // 埋め込みを切り替えるとき、点を新旧の座標の間で動かす
    view?.update(dt, window.innerWidth, window.innerHeight);
    renderer.render(scene, camera);
    view?.renderOverlay(); // 本体の描画のあと、右下の領域へ重ねて描く（src/minimap/）

    hudTimer += dt;
    if (hudTimer > 0.25) { hudTimer = 0; updateHud(); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ---- 検証用の窓口。表示中のデータセットの部品へ、呼ばれた時点で振り向ける ----
  const v = () => {
    if (!view) throw new Error('表示中のデータセットがありません');
    return view;
  };
  const explorer = {
    ready: false,
    pick: (x, y) => v().picker.pick(camera, x, y),
    get picking() { return v().picking; },
    interaction: {
      getState: () => v().interaction.getState(),
      stopDistance: (i) => v().interaction.stopDistance(i),
      select: (i) => v().interaction.select(i),
    },
    labels: { getState: () => v().clusterLabels.getState() },
    setView: (spec) => v().controller.setView(spec),
    homeView: () => v().homeView(),
    getState: () => v().controller.getState(),
    measureFrames: (n) =>
      new Promise((resolve) => {
        frameTimes = [];
        frameArmed = false;
        frameWanted = n;
        frameResolve = resolve;
      }),
    get pointCloud() { return v().cloud; },
    get minimap() { return v().minimap.debug; },
    clip: {
      get: () => ({ near: camera.near, far: camera.far }),
      override: (planes) => {
        clipOverride = planes ? { near: planes.near, far: planes.far } : null;
        view?.updateCameraDependent();
      },
    },
    dataset: {
      getState: () => ({ ...state, current: state.current ? { ...state.current } : null }),
      list: () => catalog,
      switchTo: (param) => switchTo(param, { pushHistory: true }),
      text: (i) => view?.text?.[i] ?? null,
      pointColor: (i) => colorIndexHex(v().coloring.indices[i] ?? 0),
    },
    umap: {
      getState: () => umapFeature ? umapFeature.getState() : { loaded: false },
      open: () => loadUmapFeature().then((f) => f.open()),
      close: () => { if (umapFeature?.isOpen) umapFeature.toggle(); },
      compute: (p, o) => loadUmapFeature().then((f) => f.compute(p, o)),
      cancel: () => umapFeature?.cancel(),
      revert: () => loadUmapFeature().then((f) => f.revert()),
      setPreview: (on) => loadUmapFeature().then((f) => f.setPreview(on)),
      raw: (key) => umapFeature?.raw(key) ?? null,
      positions: () => new Float32Array(v().arrays.positions),
      shownPositions: () => new Float32Array(v().shownPositions),
      clusters: () => v().arrays.manifest.clusters?.levels[0]?.clusters.map((c) => ({
        id: c.id, name: c.name, center: [...c.center] as [number, number, number], radius: c.radius, size: c.size, medoid: c.medoid,
      })) ?? null,
      structure: () => {
        const m = v().arrays.manifest;
        return { bounds: m.bounds ?? null, density: m.density ?? null, overview: m.overview ?? null, umap: m.umap ?? null };
      },
    },
    words: {
      getState: () => v().words?.getState() ?? null,
      setEnabled: (enabled) => setWordsEnabled(enabled),
      paused: () => v().wordsPaused,
    },
    neighbors: {
      getState: () => view?.neighbors?.getState() ?? null,
      setEnabled: (enabled) => neighbors.setEnabled(enabled),
      back: () => view?.neighbors?.back(),
    },
    faults,
    notice: () => view?.notice ?? null,
    memory: () => ({
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
    }),
  } as NonNullable<Window['__explorer']>;

  // ---- 起動時のデータセット ----
  // 起動時に失敗しても、選択欄（または dataset.switchTo）から別のデータセットを開けば、ready が true になって使える
  const search = window.location.search;
  const result = await switchTo(new URLSearchParams(search).get('data') ?? '', { search });
  if (!result.ok) explorer.error = result.error ?? '不明なエラー';
  window.__explorer = explorer;
}

start().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  const hud = document.getElementById('hud');
  if (hud) { hud.textContent = `読み込みに失敗しました: ${message}`; hud.classList.add('error'); }
  window.__explorer = { ready: false, error: message } as Window['__explorer'];
});
