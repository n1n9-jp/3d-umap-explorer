/**
 * データセットに依存する部分のまとまり（生成と破棄の入口）。
 *
 * アプリ全体（src/main.ts）は、レンダラー・シーン・カメラ・描画ループ・HUD・キー操作・データセットの選択欄を
 * 1 つだけ持ち、データセットごとに `DatasetView` を作り直す。`DatasetView` は、点群（描画・ピッキング・強調表示）、
 * 空間索引、速度の自動調整、カメラ操作（飛行・俯瞰・ホーム復帰）、ホバーと選択、情報パネル、クラスタの目印と現在地、
 * ミニマップを、読み込んだデータ（`LoadedDataset`）から作る。`dispose()` で、GPU の資源（テクスチャ・バッファ・
 * レンダーターゲット）、イベントのリスナー、DOM の要素を解放し、共有の要素（情報パネルなど）を空に戻す。
 *
 * 点群の表示は `root`（THREE.Group）にまとめてシーンへ足す。あとから足す表示（近くの単語の文字など）も、
 * `root` に加えて `dispose()` で外せばよい。
 */
import * as THREE from 'three';
import { atlasLayout, cellOrigins, inkIsDark } from '../data/atlas';
import { loadAtlasImage, loadDatasetArrays, measureBorderLuma, type DatasetArrays } from '../data/loader';
import { PointCloud } from '../render/pointCloud';
import { pointColoring, colorIndexHex, type PointColoring } from '../render/colorScheme';
import { defaultPointSize } from '../render/pointSize';
import { INTERIOR_FOG, fogForCamera } from '../render/fog';
import { clipPlanesForCamera, type ClipPlanes } from '../render/clip';
import type { ViewSpec } from '../render/view';
import { CameraRig, type CameraMode } from './cameraRig';
import { AutoSpeed, autoSpeedParams } from './autoSpeed';
import { computeHomeView } from './homeView';
import { GpuPicker } from '../picking/GpuPicker';
import { createPickingDebug, type PickingDebug } from '../picking/debug';
import { SpatialIndex } from '../spatial/SpatialIndex';
import { InteractionController } from '../interaction/InteractionController';
import { InfoPanel, type PointInfoSource } from '../interaction/infoPanel';
import { ClusterLabels } from '../labels/ClusterLabels';
import { Minimap } from '../minimap/Minimap';
import { WordLabels } from '../text/WordLabels';
import { takeFault } from './faults';
import type { ScreenRect } from '../text/selection';

/**
 * 画面の端の UI の要素（単語の文字をこの下に出さない）。HUD・データセットの選択欄・UMAP のパネル・現在地・
 * 情報パネル・ミニマップ。毎フレーム、要素の実際の矩形を読む（開閉や大きさの変化に追従する）。
 */
export const WORD_OBSTACLE_IDS = ['hud', 'dataset-switcher', 'umap-panel', 'cluster-location', 'info', 'minimap'] as const;

/** 読み込み済みのデータ（GPU の資源はまだ作らない）。 */
export interface LoadedDataset {
  /** 読み込んだ場所（`public/` からの相対パス） */
  dir: string;
  arrays: DatasetArrays;
  /** 画像アトラス（`manifest.sprite` があるときだけ） */
  atlas: ImageBitmap | null;
}

/** データセットを読み込む（manifest・数値バイナリ・単語・画像）。GPU の資源は作らないので、失敗しても表示中のものに影響しない。 */
export async function loadDataset(dir: string): Promise<LoadedDataset> {
  const arrays = await loadDatasetArrays(dir);
  // 画像は、点が画像を表すデータセット（kind が image）でだけ読む
  const sprite = arrays.manifest.kind === 'image' ? arrays.manifest.sprite : undefined;
  const atlas = sprite ? await loadAtlasImage(dir, sprite) : null;
  if (atlas && sprite) {
    try {
      atlasLayout(sprite, atlas.width, atlas.height); // 大きさの検査（ここで失敗させて、表示中のものを壊さない）
    } catch (e) {
      atlas.close();
      throw e;
    }
  }
  return { dir, arrays, atlas };
}

/** 読み込んだデータの画像を解放する（データセットを切り替えて不要になったとき）。 */
export function releaseLoadedDataset(data: LoadedDataset): void {
  data.atlas?.close();
}

/** アプリ全体で 1 つだけ持ち、データセットをまたいで使うもの。 */
export interface AppContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  doc: Document;
  hud: HTMLElement;
  /** クリップ面の上書き（検証用。null ならカメラの位置から決める） */
  clipOverride(): ClipPlanes | null;
}

export interface DatasetViewOptions {
  /** 点の大きさ（URL の `size`）。省略時はデータの点の間隔から決める */
  pointSize?: number | null;
  /**
   * 点の色の上書き（ブラウザで計算した埋め込みで、ラベルのないデータセットの色を、事前計算のクラスタの色のまま引き継ぐ）。
   * 省略時は arrays のラベル・クラスタから決める
   */
  coloring?: PointColoring | null;
  /** 近くの単語の文字の表示を有効にするか（K キーの状態。省略時は有効） */
  words?: boolean;
  /**
   * `arrays.positions` から構築済みの空間索引（Worker で構造と一緒に作ったもの、または前の表示のもの）。
   * 渡すと、空間索引を作り直さずに使う。省略時は、ここで構築する
   */
  spatialIndex?: SpatialIndex;
}

/**
 * 表示を作り直すときに引き継ぐ、利用者が決めた状態（ブラウザで計算した埋め込みへ差し替えるとき。src/compute/）。
 * カメラの位置と向きは、カメラ（アプリ全体で 1 つ）がそのまま持つ。
 */
export interface ViewUiState {
  mode: CameraMode;
  position: [number, number, number];
  lookAt: [number, number, number];
  speed: number;
  autoSpeedEnabled: boolean;
  pointSize: number;
  labelsEnabled: boolean;
  minimapVisible: boolean;
  selected: number | null;
}

export class DatasetView {
  readonly data: LoadedDataset;
  readonly arrays: DatasetArrays;
  /** 点群の表示をまとめたグループ（点群・強調表示の輪。あとから足す表示もここへ） */
  readonly root = new THREE.Group();
  readonly cloud: PointCloud;
  readonly coloring: PointColoring;
  readonly spatialIndex: SpatialIndex;
  readonly controller: CameraRig;
  readonly picker: GpuPicker;
  readonly picking: PickingDebug;
  readonly infoPanel: InfoPanel;
  readonly interaction: InteractionController;
  readonly clusterLabels: ClusterLabels;
  readonly minimap: Minimap;
  /** 点ごとの表示用の文字列（単語のデータセットだけ） */
  readonly text: string[] | null;
  /** 近くの単語の文字（単語のデータセットで、画像のないときだけ。src/text/） */
  readonly words: WordLabels | null;
  /** 利用者に知らせる文（単語の文字を作れず、丸い点だけで表示しているときなど）。なければ null。HUD に出す */
  private _notice: string | null = null;
  /** 計算の途中の座標や新旧の座標の間の移動を点群に出している間（`setComputingDisplay`）、目印を隠し、ミニマップに「計算中」を出す */
  private computingDisplay = false;
  private labelsBeforeComputing = true;
  private computingBadge: HTMLElement | null = null;
  private badgeLayoutKey = '';
  /** 描いている座標が arrays.positions と違う間、単語の文字を止めているか（setDisplayPositions） */
  private wordsSuspended = false;
  private wordsEnabledBeforeSuspend = true;
  private readonly ctx: AppContext;
  private readonly boundsCenter: THREE.Vector3;
  /**
   * 点群の描画に渡している座標（`arrays.positions` のコピー）。ブラウザで計算した埋め込みへ切り替えるとき、
   * 計算の途中の座標や、新旧の座標の間を動く点を、ここへ書いて見せる（`setDisplayPositions`）。
   */
  private readonly displayPositions: Float32Array;
  private disposed = false;

  constructor(ctx: AppContext, data: LoadedDataset, options: DatasetViewOptions = {}) {
    this.ctx = ctx;
    this.data = data;
    try {
      const arrays = (this.arrays = data.arrays);
      const { manifest } = arrays;
      const { renderer, scene, camera, doc } = ctx;
      this.text = arrays.text ?? null;

      const coarseLevel = manifest.clusters?.levels[0];
      const coarseIds = arrays.clusterAssignments?.[0]?.ids;
      const coarse = coarseLevel && coarseIds ? { ids: coarseIds, noise: manifest.clusters!.noise } : null;
      this.coloring = options.coloring ?? pointColoring({ count: manifest.count, labels: arrays.labels, coarse });
      this.displayPositions = new Float32Array(arrays.positions);

      // ---- 点群（src/render/）。画像があれば画像と丸い点、なければすべて丸い点 ----
      let atlas = null;
      if (data.atlas && manifest.sprite && manifest.kind === 'image') {
        const layout = atlasLayout(manifest.sprite, data.atlas.width, data.atlas.height);
        atlas = {
          image: data.atlas,
          cellOrigins: cellOrigins(manifest.count, layout),
          cellSize: [layout.cellU, layout.cellV] as [number, number],
          inkIsDark: inkIsDark(measureBorderLuma(data.atlas)),
        };
      }
      this.cloud = new PointCloud(
        { positions: this.displayPositions, colorIndices: this.coloring.indices, atlas },
        { fog: INTERIOR_FOG, pointSize: options.pointSize ?? defaultPointSize(manifest.density) },
      );
      this.root.add(this.cloud.mesh);
      this.root.add(this.cloud.highlight); // 輪の太さの倍率は resize() の setPixelRatio で設定する
      scene.add(this.root);

      // 点群の中心（バウンディングボックスの中心）。俯瞰モードの回転の中心になる
      const cloudCenter = new THREE.Vector3(...arrays.bounds.min).add(new THREE.Vector3(...arrays.bounds.max)).multiplyScalar(0.5);
      // 点群を含む球の中心。霧の距離の基準になる（俯瞰モードの回転の中心とは別）
      this.boundsCenter = new THREE.Vector3(...arrays.bounds.center);
      // 空間索引は 1 つを、速度の自動調整とホバー・選択の「止まる距離」で共有する。
      // 問い合わせは同期的に終わり、結果は都度コピーされる。JS は単一スレッドで、互いの問い合わせの途中に割り込まないので安全
      this.spatialIndex = options.spatialIndex ?? new SpatialIndex(arrays.positions);
      const autoParams = autoSpeedParams(manifest.density); // manifest に density がなければ使わない
      const autoSpeed = autoParams ? new AutoSpeed(this.spatialIndex, autoParams) : null;
      this.controller = new CameraRig(camera, renderer.domElement, cloudCenter, { autoSpeed });

      // ---- クラスタの目印と現在地（src/labels/。粗い階層を使う。クラスタのないデータセットでは何もしない）----
      this.clusterLabels = new ClusterLabels({
        document: doc,
        container: doc.getElementById('cluster-labels')!,
        locationEl: doc.getElementById('cluster-location')!,
        pointerTarget: renderer.domElement, // 目印の上のホイールとドラッグは、目印のない場所と同じようにカメラへ届ける
        hud: ctx.hud,
        camera,
        clusters: coarseLevel?.clusters ?? [],
        boundsRadius: arrays.bounds.radius,
        boundsCenter: arrays.bounds.center,
        colorSource: this.coloring.source,
        flyTo: (target, opts) => this.controller.flyTo(target, opts),
        // クラスタの内部では、単語の文字と重なる目印を隠す（this.words はこのあと作る）
        wordRects: () => this.words?.shownRects() ?? [],
      });

      // ---- ピッキング（src/picking/）----
      this.picker = new GpuPicker(renderer, this.cloud);
      this.picking = createPickingDebug(renderer, scene, camera, this.cloud, this.picker);

      // ---- 近くの単語の文字（src/text/）。画像のない単語のデータセットだけ。root に加え、ピッキングの層にする ----
      // 文字の表示だけが作れないとき（グリフアトラスが文字の種類の多さで溢れるなど）は、表示全体を失敗にせず、丸い点だけで続ける
      let words: WordLabels | null = null;
      if (this.text && this.cloud.dotsOnly && manifest.kind === 'text') {
        try {
          if (takeFault('words')) throw new Error('（検証用）単語の文字の生成を失敗させました');
          words = new WordLabels({
            text: this.text,
            positions: arrays.positions,
            colorIndices: this.coloring.indices,
            cloud: this.cloud,
            picker: this.picker,
            nearest: (x, y, z, k) => this.spatialIndex.kNearest(x, y, z, k).indices,
            index: this.spatialIndex,
            camera,
            doc,
          });
        } catch (e) {
          console.warn('単語の文字の表示を作れないので、丸い点だけで表示します:', e);
          this._notice = `単語の文字を表示できません（${e instanceof Error ? e.message : String(e)}）。丸い点だけで表示しています`;
        }
      }
      this.words = words;
      if (this.words) {
        this.root.add(this.words.group);
        if (options.words === false) this.words.setEnabled(false);
      }

      // ---- ホバー・選択・ダブルクリックで点へ飛ぶ（src/interaction/）----
      this.infoPanel = new InfoPanel(doc, this.pointInfoSource(coarseLevel?.clusters.map((c) => c.name) ?? []), () => this.interaction.select(null));
      this.interaction = new InteractionController({
        canvas: renderer.domElement,
        camera,
        cloud: this.cloud,
        pick: (x, y) => this.picker.pick(camera, x, y).then((r) => (r ? r.index : null)),
        index: this.spatialIndex, // 速度の自動調整と共有（上で構築）
        panel: this.infoPanel,
        flyTo: (target, opts) => this.controller.flyTo(target, opts),
        pressStopsInertia: (e) => this.controller.pressStopsInertia(e),
        bufferHeight: () => renderer.getDrawingBufferSize(new THREE.Vector2()).y,
      });

      // ---- ミニマップ（src/minimap/）：右下に全体の俯瞰と現在位置・視線の向き ----
      this.minimap = new Minimap({
        renderer,
        camera,
        positions: arrays.positions,
        colorIndices: this.coloring.indices,
        axes: manifest.overview?.axes,
        selected: () => this.interaction.getState().selected,
        moveTo: (view, seconds) => this.controller.goHome(view, seconds), // 位置と向きを滑らかに補間する（向きは同じなので位置だけ動く）
        renderMain: () => renderer.render(scene, camera),
        container: doc.body,
      });

      this.updateCameraDependent();
      this.resize();
      if (takeFault('view')) throw new Error('（検証用）表示の生成を失敗させました');
    } catch (e) {
      // 途中で失敗したら、それまでに作ったもの（カメラ操作のリスナー・目印の DOM・ピッキングの資源など）をすべて破棄してから投げ直す。
      // 呼び出し側が前のデータで作り直すときに、リスナーが二重に登録されたり、DOM や GPU の資源が残ったりしない
      this.dispose();
      throw e;
    }
  }

  get name(): string {
    return this.arrays.manifest.name;
  }

  /** 点群に描いている座標（長さ 3 * count。書き換えないこと）。 */
  get shownPositions(): Float32Array {
    return this.displayPositions;
  }

  /**
   * 点群の描画だけを、指定の座標で描く（空間索引・ピッキングの対応・目印・ミニマップは作り直さない）。
   * 計算の途中の座標と、新旧の座標の間を動く点を見せるのに使う。GPU ピッキングは描画と同じ座標を使う。
   */
  setDisplayPositions(positions: ArrayLike<number>): void {
    if (positions.length !== this.displayPositions.length) throw new RangeError('座標の長さが点の数と一致しません');
    this.displayPositions.set(positions);
    const attr = this.cloud.mesh.geometry.getAttribute('instancePosition');
    attr.needsUpdate = true;
    // 近くの単語の文字は、空間索引と同じ座標（arrays.positions）に置かれる。描いている座標がそれと違う間
    // （計算の途中の表示、新旧の座標の間の移動）は、文字が点から離れてしまうので、文字を出さない。
    if (this.words) {
      const base = this.arrays.positions;
      let detached = false;
      for (let i = 0; i < base.length; i++) { if (base[i] !== this.displayPositions[i]) { detached = true; break; } }
      if (detached && !this.wordsSuspended) {
        this.wordsSuspended = true;
        this.wordsEnabledBeforeSuspend = this.words.getState().enabled;
        this.words.setEnabled(false);
      } else if (!detached && this.wordsSuspended) {
        this.wordsSuspended = false;
        this.words.setEnabled(this.wordsEnabledBeforeSuspend);
      }
    }
    // 強調表示の輪の位置も合わせ直す
    for (const kind of ['hover', 'selected'] as const) this.cloud.setHighlight(kind, this.cloud.getHighlight(kind));
  }

  /** 利用者に知らせる文（単語の文字を作れず丸い点だけで表示しているときなど）。なければ null。 */
  get notice(): string | null {
    return this._notice;
  }

  /**
   * 点群に、計算の途中の座標や新旧の座標の間の移動を出している間 true にする。目印とミニマップは、表示中の埋め込みの座標
   * （`arrays.positions`）のままなので、目印は古い位置に浮いて見える。その間、目印を一時的に隠し（利用者の表示の選択は保つ）、
   * ミニマップのそばに「計算中」を出す。false に戻すと、目印を元の状態へ戻して、「計算中」を消す。
   */
  setComputingDisplay(on: boolean): void {
    if (this.disposed || on === this.computingDisplay) return;
    this.computingDisplay = on;
    if (on) {
      this.labelsBeforeComputing = this.clusterLabels.enabled;
      this.clusterLabels.setEnabled(false);
      const badge = this.ctx.doc.createElement('div');
      badge.id = 'minimap-computing';
      badge.textContent = '計算中';
      badge.setAttribute('aria-hidden', 'true'); // 進捗は UMAP のパネルが伝える
      badge.style.cssText = 'position:fixed;z-index:2;pointer-events:none;font:11px/1.4 sans-serif;padding:1px 6px;border-radius:3px;'
        + 'background:#ffc233;color:#07080c;';
      this.ctx.doc.body.append(badge);
      this.computingBadge = badge;
      this.badgeLayoutKey = '';
      this.layoutComputingBadge();
    } else {
      this.clusterLabels.setEnabled(this.labelsBeforeComputing);
      this.computingBadge?.remove();
      this.computingBadge = null;
    }
  }

  /** L キー。計算の途中の表示の間は、隠している目印を戻すときの状態を切り替える（目印はまだ出さない）。 */
  toggleClusterLabels(): void {
    if (this.computingDisplay) this.labelsBeforeComputing = !this.labelsBeforeComputing;
    else this.clusterLabels.toggle();
  }

  private layoutComputingBadge(): void {
    const badge = this.computingBadge;
    if (!badge) return;
    const visible = this.minimap.isVisible;
    badge.hidden = !visible;
    if (!visible) return;
    const key = `${this.ctx.renderer.domElement.clientWidth}x${this.ctx.renderer.domElement.clientHeight}`;
    if (key === this.badgeLayoutKey) return;
    this.badgeLayoutKey = key;
    const { map } = this.minimap.getState(); // ミニマップの地図の領域（画面上の CSS ピクセル）
    badge.style.left = `${Math.round(map.left + 4)}px`;
    badge.style.top = `${Math.round(map.top + 4)}px`;
  }

  /**
   * 近くの単語の文字の表示の有効・無効（K キー）。点が新旧の位置の間を動いている間や、計算の途中を表示している間
   * （setDisplayPositions で文字を止めている間）は、止め終わったあとの状態として覚えておくだけにする。
   */
  setWordsEnabled(enabled: boolean): void {
    if (!this.words) return;
    if (this.wordsSuspended) this.wordsEnabledBeforeSuspend = enabled;
    else this.words.setEnabled(enabled);
  }

  /** 単語の文字を止めているか（setDisplayPositions）。 */
  get wordsPaused(): boolean {
    return this.wordsSuspended;
  }

  /** 表示を作り直すときに引き継ぐ状態。 */
  captureUiState(): ViewUiState {
    const s = this.controller.getState();
    return {
      mode: s.mode, position: s.position, lookAt: s.lookAt, speed: s.speed, autoSpeedEnabled: s.autoSpeed.enabled,
      pointSize: this.cloud.params.pointSize,
      labelsEnabled: this.computingDisplay ? this.labelsBeforeComputing : this.clusterLabels.enabled,
      minimapVisible: this.minimap.isVisible, selected: this.interaction.getState().selected,
    };
  }

  /** `captureUiState` の状態を引き継ぐ（作り直した直後に呼ぶ）。選択は番号で引き継ぐ。 */
  applyUiState(s: ViewUiState): void {
    this.controller.setMode(s.mode);
    this.controller.setView({ pos: s.position, look: s.lookAt });
    this.controller.fly.speed = s.speed;
    if (this.controller.autoSpeedAvailable) this.controller.autoSpeedEnabled = s.autoSpeedEnabled;
    this.cloud.set({ pointSize: s.pointSize });
    if (this.clusterLabels.enabled !== s.labelsEnabled) this.clusterLabels.setEnabled(s.labelsEnabled);
    if (this.minimap.isVisible !== s.minimapVisible) this.minimap.setVisible(s.minimapVisible);
    if (s.selected !== null && s.selected < this.arrays.manifest.count) this.interaction.select(s.selected);
    this.updateCameraDependent();
  }

  /** ホームの視点: 点群全体（bounds の球）が画面に収まる位置。向きは manifest の overview.axes（第3軸の方向から見る） */
  homeView(): ViewSpec {
    const cam = this.ctx.camera;
    return computeHomeView(this.arrays.bounds, cam.fov, cam.aspect, this.arrays.manifest.overview?.axes);
  }

  /** カメラの位置に応じたクリップ面と霧。点群を含む球（bounds）の中心までの距離から決める */
  updateCameraDependent(): void {
    const camera = this.ctx.camera;
    const { radius } = this.arrays.bounds;
    const d = camera.position.distanceTo(this.boundsCenter);
    const clip = this.ctx.clipOverride() ?? clipPlanesForCamera(d, radius, { fovDeg: camera.fov, aspect: camera.aspect });
    if (camera.near !== clip.near || camera.far !== clip.far) {
      camera.near = clip.near;
      camera.far = clip.far;
      camera.updateProjectionMatrix();
    }
    this.cloud.set({ fog: fogForCamera(d, radius, INTERIOR_FOG) });
  }

  /** 画面の大きさ・倍率が変わったとき（レンダラーとカメラを合わせたあとに呼ぶ）。 */
  resize(): void {
    const r = this.ctx.renderer;
    this.cloud.setViewportHeight(r.getDrawingBufferSize(new THREE.Vector2()).y);
    // 画面上の大きさのパラメータは CSS ピクセルで持ち、描画バッファの画素へはこの倍率で直す
    this.cloud.setPixelRatio(r.getPixelRatio());
    this.minimap.resize();
  }

  /** 描画の前（毎フレーム）。 */
  update(dt: number, width: number, height: number): void {
    this.controller.update(dt);
    this.updateCameraDependent();
    if (this.words) {
      this.words.setObstacles(this.wordObstacles());
      this.words.update(dt, width, height);
    }
    this.clusterLabels.update(width, height);
    this.layoutComputingBadge();
  }

  /** 本体の描画のあと（毎フレーム）。右下の領域へミニマップを重ねて描く */
  renderOverlay(): void {
    this.minimap.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // コンストラクタの途中で失敗したときにも呼ぶ。まだ作っていないものは飛ばす
    const made = this as Partial<Pick<DatasetView, 'interaction' | 'infoPanel' | 'clusterLabels' | 'minimap' | 'controller' | 'words' | 'picker' | 'cloud'>>;
    made.interaction?.dispose();
    made.infoPanel?.dispose();
    made.clusterLabels?.dispose();
    made.minimap?.dispose();
    made.controller?.dispose();
    made.words?.dispose();
    made.picker?.dispose();
    this.computingBadge?.remove();
    this.computingBadge = null;
    this.ctx.scene.remove(this.root);
    made.cloud?.dispose();
  }

  /**
   * 単語の文字を重ねない画面上の領域: UI の要素の矩形と、目印。クラスタの外では目印を優先し（出ている目印と重なる単語を出さない）、
   * 内部では単語を優先する（目印のほうを隠す。ClusterLabels）。内部でも、キーボードのフォーカスがある目印とは重ねない。
   * 目印は前のフレームの位置（単語の選び直しは、位置が変われば次のフレームで追いつく）。
   */
  private wordObstacles(): ScreenRect[] {
    const out: ScreenRect[] = [];
    const doc = this.ctx.doc;
    for (const id of WORD_OBSTACLE_IDS) {
      const el = doc.getElementById(id);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height });
    }
    const labels = this.clusterLabels;
    out.push(...labels.visibleRects(labels.insideCluster));
    return out;
  }

  private pointInfoSource(clusterNames: string[]): PointInfoSource {
    const { manifest, labels } = this.arrays;
    const indices = this.coloring.indices;
    const names = manifest.labels?.names;
    const text = this.text;
    const sprite = manifest.sprite;
    const coarseIds = this.arrays.clusterAssignments?.[0]?.ids;
    return {
      kind: manifest.kind,
      title: (i) => {
        if (text) return text[i] ?? `#${i}`;
        if (labels && names) return names[labels[i]!] ?? String(labels[i]);
        return `#${i}`;
      },
      color: (i) => colorIndexHex(indices[i] ?? 0),
      image: this.data.atlas && sprite ? { atlas: this.data.atlas, cellSize: sprite.cellSize, columns: sprite.columns } : null,
      coarse: coarseIds && manifest.clusters ? { ids: coarseIds, names: clusterNames, noise: manifest.clusters.noise } : null,
    };
  }
}
