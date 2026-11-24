import * as THREE from 'three';
import type { PointCloud } from '../render/pointCloud';
import type { FlyToOptions } from '../controls/FlyCameraControls';
import type { NeighborIndex } from '../app/autoSpeed';
import { PointerGesture } from './gesture';
import { HoverTracker, LatestOnly, type PickFn } from './latest';
import { clickEffect } from './clickEffect';
import { isFromEditable } from '../app/keyEvents';
import { computeStopDistance, type StopDistance } from './stopDistance';
import type { InfoPanel } from './infoPanel';

/** 止まる距離を決めるのに使う近傍の点数（自分を除く） */
export const STOP_NEIGHBORS = 6;
/** 止まった位置で、点を画面上でこの大きさ（CSS ピクセル）以上に見せる */
export const STOP_MIN_CSS_PX = 32;
/** 点へ飛ぶ所要時間 */
export const FLY_TO_POINT_MS = 800;

export interface InteractionState {
  hovered: number | null;
  selected: number | null;
}

export interface InteractionDeps {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  cloud: PointCloud;
  /** 画面上の位置にある点の番号 */
  pick: PickFn;
  /** 近傍検索（止まる距離に使う） */
  index: NeighborIndex;
  panel: InfoPanel;
  /** 点へ移動する（俯瞰モードなら飛行モードへ切り替えてから）。 */
  flyTo(target: THREE.Vector3, options: FlyToOptions): void;
  /** 描画バッファの高さ（画素） */
  bufferHeight(): number;
  /**
   * 押下 `e`（pointerdown）が、視点の回転の慣性を止めた押下か。そうなら、その押下は動かさずに離しても、
   * クリック（選択・選択の解除・ダブルクリック）に数えない。カメラ操作のリスナーとの登録順によらず答えが変わらない
   * 関数を渡すこと（`CameraRig.pressStopsInertia`）。
   */
  pressStopsInertia(e: PointerEvent): boolean;
  /** 選択が変わったとき（解除を含む）に呼ぶ。情報パネルを更新したあとに呼ぶ（元の空間で近い点の一覧など。src/neighbors/） */
  onSelect?(index: number | null): void;
}

/**
 * ホバー・クリックでの選択・ダブルクリックで点へ飛ぶ操作。
 * カメラ操作（FlyCameraControls・OverviewControls）と同じキャンバスのポインタイベントを並行して聞き、
 * 押してから離すまで動かなかった操作だけをクリックとして扱う（ドラッグの終わりはクリックにしない）。
 * 視点が慣性で回っている最中の押下は、慣性を止める操作なので、動かさずに離してもクリックにしない（`gesture.ts`）。
 * ホバーの特定は 1 フレームに 1 回まで。ドラッグ中とカメラの移動中は止め、表示中のホバーを消す。
 */
export class InteractionController {
  private readonly deps: InteractionDeps;
  private readonly gesture = new PointerGesture();
  private readonly hover: HoverTracker;
  private readonly clicks = new LatestOnly();
  private selected: number | null = null;
  private readonly lastCamera = new THREE.Matrix4();
  private readonly lastProjection = new THREE.Matrix4();
  private cameraMoving = false;
  private rafId = 0;
  private disposed = false;
  private readonly positions: THREE.BufferAttribute;

  constructor(deps: InteractionDeps) {
    this.deps = deps;
    this.positions = deps.cloud.mesh.geometry.getAttribute('instancePosition') as THREE.BufferAttribute;
    this.hover = new HoverTracker(deps.pick, (index) => this.onHoverChange(index));
    const c = deps.canvas;
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerCancel);
    c.addEventListener('lostpointercapture', this.onPointerCancel);
    c.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('blur', this.onBlur);
    deps.camera.updateMatrixWorld();
    this.lastCamera.copy(deps.camera.matrixWorld);
    this.lastProjection.copy(deps.camera.projectionMatrix);
    this.rafId = requestAnimationFrame(this.frame);
  }

  getState(): InteractionState {
    return { hovered: this.hover.hovered, selected: this.selected };
  }

  select(index: number | null): void {
    this.selected = index;
    this.deps.cloud.setHighlight('selected', index);
    this.deps.panel.show(index);
    this.deps.onSelect?.(index);
  }

  /** 点 index へ飛ぶときに止まる距離（点からの距離）。 */
  stopDistance(index: number): StopDistance {
    const p = this.point(index);
    const res = this.deps.index.kNearest(p.x, p.y, p.z, STOP_NEIGHBORS + 1);
    const dists: number[] = [];
    // 自分自身（距離 0）と、同じ位置に重なった点は除く
    for (let i = 0; i < res.distances.length; i++) if (res.distances[i]! > 0) dists.push(res.distances[i]!);
    const params = this.deps.cloud.params;
    const cam = this.deps.camera;
    const bh = this.deps.bufferHeight();
    const ratio = bh / Math.max(1, this.deps.canvas.getBoundingClientRect().height);
    return computeStopDistance({
      neighborDistances: dists.slice(0, STOP_NEIGHBORS),
      pointSize: params.pointSize,
      nearFadeStartFactor: params.nearFadeFactors[1],
      pxPerUnitAtUnitDepth: 0.5 * bh * cam.projectionMatrix.elements[5]!,
      minPixels: STOP_MIN_CSS_PX * ratio,
    });
  }

  /** 点 index へ飛ぶ。 */
  flyToPoint(index: number): void {
    const { distance } = this.stopDistance(index);
    this.deps.flyTo(this.point(index), { distance, durationMs: FLY_TO_POINT_MS });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.clicks.invalidate();
    const c = this.deps.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerCancel);
    c.removeEventListener('lostpointercapture', this.onPointerCancel);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('blur', this.onBlur);
  }

  private point(index: number): THREE.Vector3 {
    return new THREE.Vector3(this.positions.getX(index), this.positions.getY(index), this.positions.getZ(index))
      .applyMatrix4(this.deps.cloud.mesh.matrixWorld);
  }

  private readonly frame = (): void => {
    if (this.disposed) return;
    const cam = this.deps.camera;
    cam.updateMatrixWorld();
    this.cameraMoving = !cam.matrixWorld.equals(this.lastCamera) || !cam.projectionMatrix.equals(this.lastProjection);
    this.lastCamera.copy(cam.matrixWorld);
    this.lastProjection.copy(cam.projectionMatrix);
    if (this.gesture.dragging || this.cameraMoving) this.hover.suspend();
    else this.hover.resume();
    this.hover.frame();
    this.rafId = requestAnimationFrame(this.frame);
  };

  private onHoverChange(index: number | null): void {
    if (this.disposed) return; // 破棄の前に出した要求の結果（データセットの切り替え後）は使わない
    this.deps.cloud.setHighlight('hover', index);
    const pos = this.hover.position;
    this.deps.panel.showHover(index, pos?.x, pos?.y);
    this.deps.canvas.style.cursor = index === null ? '' : 'pointer';
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.gesture.down(e.pointerId, e.button, e.clientX, e.clientY, e.buttons, this.deps.pressStopsInertia(e));
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.gesture.move(e.pointerId, e.clientX, e.clientY, e.buttons)) this.hover.suspend();
    this.hover.move(e.clientX, e.clientY);
    // 表示中のラベルはカーソルに付いていく（特定し直すのは次のフレーム）
    if (this.hover.hovered !== null) this.deps.panel.showHover(this.hover.hovered, e.clientX, e.clientY);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const r = this.gesture.up(e.pointerId, e.clientX, e.clientY, e.timeStamp, e.button);
    if (!r || r.kind !== 'click') return;
    const { x, y, double } = r;
    // 押した瞬間のホバーではなく、離した位置で改めて特定する（ホバーの要求がまだ返っていなくても正しい）
    // 選択と移動の規則は clickEffect.ts（ダブルクリックの 1 回目のクリックでも選択は変わる）
    this.clicks.issue(this.deps.pick(x, y), (index) => {
      if (this.disposed) return;
      const effect = clickEffect(index, double);
      this.select(effect.select);
      if (effect.flyTo !== null) this.flyToPoint(effect.flyTo);
    });
  };

  /**
   * pointercancel と lostpointercapture（O キーでのモード切り替えなどで capture が外れると、要素の外で離した
   * pointerup が届かない）。押下の状態を破棄して、次のクリックを取りこぼさない。
   */
  private readonly onPointerCancel = (e: PointerEvent): void => {
    this.gesture.cancel(e.pointerId);
  };

  private readonly onBlur = (): void => {
    this.gesture.cancel();
  };

  private readonly onPointerLeave = (): void => {
    if (this.gesture.pressed) return; // ドラッグ中はキャプチャされているので、外へ出ても終わりではない
    this.hover.leave();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.repeat) return;
    if (isFromEditable(e)) return; // 入力欄での Esc は、入力欄の操作（キー判定は src/app/keyEvents.ts に共通）
    this.clicks.invalidate(); // 返ってくる途中のクリックの結果で選び直さない
    this.select(null);
  };
}
