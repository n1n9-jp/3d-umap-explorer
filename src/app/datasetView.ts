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
import { CameraRig } from './cameraRig';
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
  /** 近くの単語の文字の表示を有効にするか（K キーの状態。省略時は有効） */
  words?: boolean;
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
  private readonly ctx: AppContext;
  private readonly boundsCenter: THREE.Vector3;
  private disposed = false;

  constructor(ctx: AppContext, data: LoadedDataset, options: DatasetViewOptions = {}) {
    this.ctx = ctx;
    this.data = data;
    const arrays = (this.arrays = data.arrays);
    const { manifest } = arrays;
    const { renderer, scene, camera, doc } = ctx;
    this.text = arrays.text ?? null;

    const coarseLevel = manifest.clusters?.levels[0];
    const coarseIds = arrays.clusterAssignments?.[0]?.ids;
    const coarse = coarseLevel && coarseIds ? { ids: coarseIds, noise: manifest.clusters!.noise } : null;
    this.coloring = pointColoring({ count: manifest.count, labels: arrays.labels, coarse });

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
      { positions: arrays.positions, colorIndices: this.coloring.indices, atlas },
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
    this.spatialIndex = new SpatialIndex(arrays.positions);
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
      colorSource: this.coloring.source,
      flyTo: (target, opts) => this.controller.flyTo(target, opts),
    });

    // ---- ピッキング（src/picking/）----
    this.picker = new GpuPicker(renderer, this.cloud);
    this.picking = createPickingDebug(renderer, scene, camera, this.cloud, this.picker);

    // ---- 近くの単語の文字（src/text/）。画像のない単語のデータセットだけ。root に加え、ピッキングの層にする ----
    this.words = this.text && this.cloud.dotsOnly && manifest.kind === 'text'
      ? new WordLabels({
        text: this.text,
        positions: arrays.positions,
        colorIndices: this.coloring.indices,
        cloud: this.cloud,
        picker: this.picker,
        nearest: (x, y, z, k) => this.spatialIndex.kNearest(x, y, z, k).indices,
        camera,
        doc,
      })
      : null;
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
  }

  get name(): string {
    return this.arrays.manifest.name;
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
    this.words?.update(dt, width, height);
    this.clusterLabels.update(width, height);
  }

  /** 本体の描画のあと（毎フレーム）。右下の領域へミニマップを重ねて描く */
  renderOverlay(): void {
    this.minimap.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.interaction.dispose();
    this.infoPanel.dispose();
    this.clusterLabels.dispose();
    this.minimap.dispose();
    this.controller.dispose();
    this.words?.dispose();
    this.picker.dispose();
    this.ctx.scene.remove(this.root);
    this.cloud.dispose();
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
