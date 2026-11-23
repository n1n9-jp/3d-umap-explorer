import { Matrix4, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { FlyToOptions } from '../controls/FlyCameraControls';
import type { ClusterInfo } from '../data/manifest';
import { appearanceParamsForBounds, labelAppearance, type AppearanceParams } from './appearance';
import { clusterViewDistance } from './flyDistance';
import { focusFallback } from './focus';
import { clusterColor, clusterTitle, formatLocation } from './format';
import { describeDirection, locateCamera, type ClusterSphere, type Location } from './location';
import { resolveOverlaps, type OverlapItem } from './overlap';
import { projectPoint, screenVisibility, type Vec3 } from './projection';

/** 目印をクリックして飛ぶ所要時間 */
export const FLY_TO_CLUSTER_MS = 1000;
/** 目印を新しく出すときに、すでに出ている目印との間に空ける最小の間隔（CSS ピクセル） */
export const LABEL_GAP_PX = 4;
/** 出ている目印どうしが、出し続けるために保つ最小の間隔。新しく出す間隔より小さくして、切り替えに幅を持たせる */
export const LABEL_STAY_GAP_PX = 1;
/** 目印を新しく出すときに、目印の矩形の全体が画面の端から離れていなければならない距離（CSS ピクセル） */
export const EDGE_MARGIN_PX = 8;
/** 出ている目印が、出し続けるために、画面の端から離れていなければならない距離。新しく出す距離より小さくして、切り替えに幅を持たせる */
export const EDGE_STAY_MARGIN_PX = 0.5;
/** 目印の上で押したまま、これを超えて動いたら、カメラの操作（視点を回す）として扱う（CSS ピクセル） */
export const DRAG_THRESHOLD_PX = 4;

export type HiddenReason = 'behind' | 'offscreen' | 'inside' | 'overlap' | 'disabled';

export interface LabelState {
  id: number;
  name: string;
  /** 目印が画面に出ているか */
  visible: boolean;
  /** 出ていない理由（出ているときは null） */
  reason: HiddenReason | null;
  /** クラスタの中心を投影した画面上の位置（CSS ピクセル）。カメラの後ろでは null */
  x: number | null;
  y: number | null;
  /** カメラからクラスタの中心までの距離 */
  distance: number;
  /** 距離に応じた大きさの倍率と不透明度 */
  scale: number;
  opacity: number;
}

export interface LocationState {
  kind: 'inside' | 'nearest' | 'none';
  /** 現在地のクラスタ（内部）または最寄りのクラスタ。none では null */
  clusterId: number | null;
  name: string | null;
  /** 画面に出している文面（無効のときは空） */
  text: string;
  /** 最寄りのときのカメラから見た向き（矢印と語）。内部では null */
  direction: { arrow: string; word: string } | null;
  /** 内部のときは中心まで、最寄りのときは縁までの距離 */
  distance: number | null;
}

export interface ClusterLabelsState {
  available: boolean;
  enabled: boolean;
  /** `update` を呼んだ回数 */
  frame: number;
  labels: LabelState[];
  location: LocationState;
}

export interface ClusterLabelsDeps {
  document: Document;
  /** 目印を置く、画面全体を覆う要素（pointer-events なし） */
  container: HTMLElement;
  /** 現在地を出す要素 */
  locationEl: HTMLElement;
  /**
   * カメラの操作とホバー・選択を受ける要素（canvas）。目印の上のホイールとドラッグは、この要素へ渡す。
   * 目印の上でも、目印のない場所と同じように働くようにするため。
   */
  pointerTarget: HTMLElement;
  /** HUD の要素（現在地を HUD の上へ置くために高さを見る）。なければ固定の位置 */
  hud?: HTMLElement | null;
  camera: PerspectiveCamera;
  /** 粗い階層のクラスタ */
  clusters: readonly ClusterInfo[];
  /** 点群を含む球の半径（距離に応じた見せ方の基準） */
  boundsRadius: number;
  /** クラスタへ飛ぶ（俯瞰モードなら飛行モードへ切り替えてから） */
  flyTo(target: Vector3, options: FlyToOptions): void;
}

const EMPTY_LOCATION: LocationState = { kind: 'none', clusterId: null, name: null, text: '', direction: null, distance: null };

interface Chip {
  cluster: ClusterInfo;
  el: HTMLButtonElement;
  /** 拡大縮小前の大きさ（CSS ピクセル。小数のまま） */
  width: number;
  height: number;
  transform: string;
  opacity: string;
  shown: boolean;
}

/**
 * クラスタごとの名前の目印（HTML の要素を canvas の上に重ねる）と、現在地の表示。
 * 毎フレーム `update` で、クラスタの中心を画面へ投影して位置を合わせる。
 */
export class ClusterLabels {
  readonly available: boolean;
  private readonly deps: ClusterLabelsDeps;
  private readonly chips: Chip[] = [];
  private readonly spheres: ClusterSphere[];
  private readonly appearance: AppearanceParams;
  private readonly viewProj = new Matrix4();
  private readonly inverse = new Matrix4();
  private readonly position = new Vector3();
  private _enabled = true;
  private frame = 0;
  private labelStates: LabelState[] = [];
  private locationState: LocationState = EMPTY_LOCATION;
  private location: { swatch: HTMLElement; text: HTMLElement } | null = null;
  private locationText = '';
  private locationKind = '';
  private locationClusterId: number | null = null;
  private locationHidden = true;
  private resizeObserver: ResizeObserver | null = null;

  constructor(deps: ClusterLabelsDeps) {
    this.deps = deps;
    this.available = deps.clusters.length > 0;
    this.spheres = deps.clusters.map((c) => ({ id: c.id, center: c.center, radius: c.radius }));
    this.appearance = appearanceParamsForBounds(deps.boundsRadius);
    if (!this.available) return;
    const doc = deps.document;
    for (const cluster of deps.clusters) {
      const el = doc.createElement('button');
      el.type = 'button';
      el.className = 'cluster-label is-hidden';
      el.dataset.clusterId = String(cluster.id);
      el.setAttribute('aria-label', `${clusterTitle(cluster.name)}へ移動`);
      el.style.setProperty('--c', clusterColor(cluster));
      const swatch = doc.createElement('span');
      swatch.className = 'cluster-label-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      const name = doc.createElement('span');
      name.className = 'cluster-label-name';
      name.textContent = cluster.name;
      el.append(swatch, name);
      this.bindPointer(el, cluster);
      deps.container.appendChild(el);
      this.chips.push({ cluster, el, width: 0, height: 0, transform: '', opacity: '', shown: false });
    }
    deps.container.hidden = false;
    // 大きさは名前が決まれば変わらないので、一度だけ測る（visibility: hidden でもレイアウトは残る）
    for (const chip of this.chips) {
      const rect = chip.el.getBoundingClientRect();
      chip.width = rect.width;
      chip.height = rect.height;
    }
    if (deps.hud && typeof ResizeObserver !== 'undefined') {
      const hud = deps.hud;
      const sync = () => deps.locationEl.style.setProperty('--hud-height', `${hud.offsetHeight}px`);
      this.resizeObserver = new ResizeObserver(sync);
      this.resizeObserver.observe(hud);
      sync();
    }
  }

  get enabled(): boolean {
    return this.available && this._enabled;
  }

  setEnabled(value: boolean): void {
    if (!this.available || value === this._enabled) return;
    this._enabled = value;
    this.deps.container.hidden = !this.enabled;
    if (!this.enabled) this.setLocationHidden(true);
  }

  toggle(): void {
    this.setEnabled(!this._enabled);
  }

  getState(): ClusterLabelsState {
    return {
      available: this.available,
      enabled: this.enabled,
      frame: this.frame,
      labels: this.labelStates.map((s) => ({ ...s })),
      location: { ...this.locationState },
    };
  }

  /** 目印のクラスタへ、クラスタ全体が視野に収まる距離まで飛ぶ。 */
  flyToCluster(cluster: ClusterInfo): void {
    const cam = this.deps.camera;
    const distance = clusterViewDistance(cluster.radius, cam.fov, cam.aspect);
    this.deps.flyTo(new Vector3(...cluster.center), { distance, durationMs: FLY_TO_CLUSTER_MS });
  }

  /** 毎フレーム、カメラの更新とクリップ面の決定のあとに呼ぶ。`width`・`height` は画面の大きさ（CSS ピクセル）。 */
  update(width: number, height: number): void {
    if (!this.available) return;
    this.frame++;
    const cam = this.deps.camera;
    cam.updateMatrixWorld();
    this.inverse.copy(cam.matrixWorld).invert();
    this.viewProj.multiplyMatrices(cam.projectionMatrix, this.inverse);
    this.position.setFromMatrixPosition(cam.matrixWorld);
    const camPos: Vec3 = [this.position.x, this.position.y, this.position.z];

    const location = locateCamera(camPos, this.spheres);
    const insideId = location.kind === 'inside' ? location.id : -1;

    // フォーカス中の目印は、重なりでは隠さない（隠れるとフォーカスが何も知らされずに body へ移るため）
    const doc = this.deps.document;
    const focused = this.chips.find((chip) => chip.el === doc.activeElement) ?? null;

    // 1. 投影と表示の可否、距離に応じた見せ方。出ていたものは、画面の端の判定を緩くして、境目での切り替わりを防ぐ
    const states: LabelState[] = [];
    const candidates: OverlapItem[] = [];
    for (const chip of this.chips) {
      const c = chip.cluster;
      const pt = projectPoint(this.viewProj.elements, c.center, width, height);
      const distance = Math.hypot(camPos[0] - c.center[0], camPos[1] - c.center[1], camPos[2] - c.center[2]);
      const look = labelAppearance(distance, this.appearance);
      const w = chip.width * look.scale;
      const h = chip.height * look.scale;
      let reason: HiddenReason | null = null;
      if (!this.enabled) reason = 'disabled';
      else if (c.id === insideId) reason = 'inside';
      else {
        const v = screenVisibility(pt, width, height, chip.shown ? EDGE_STAY_MARGIN_PX : EDGE_MARGIN_PX, w / 2, h / 2);
        if (v !== 'ok') reason = v;
      }
      states.push({
        id: c.id, name: c.name, visible: reason === null, reason,
        x: pt.inFront ? pt.x : null, y: pt.inFront ? pt.y : null,
        distance, scale: look.scale, opacity: look.opacity,
      });
      if (reason === null) candidates.push({ id: c.id, x: pt.x, y: pt.y, width: w, height: h, distance });
    }

    // 2. 画面上で重なるものは、近いほうを残して遠いほうを隠す。前のフレームで出ていたものは、距離の順位や間隔の閾値の付近でも残す
    const shown = new Set<number>();
    for (const chip of this.chips) if (chip.shown) shown.add(chip.cluster.id);
    const kept = resolveOverlaps(candidates, LABEL_GAP_PX, { shown, stayGap: LABEL_STAY_GAP_PX, pinned: focused?.cluster.id ?? null });
    for (const s of states) {
      if (s.visible && !kept.has(s.id)) { s.visible = false; s.reason = 'overlap'; }
    }
    this.labelStates = states;

    // 3. 要素へ反映する
    this.moveFocusIfHidden(focused, states);
    this.chips.forEach((chip, i) => this.applyChip(chip, states[i]!));
    this.updateLocation(location, camPos);
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private applyChip(chip: Chip, s: LabelState): void {
    if (s.visible && s.x !== null && s.y !== null) {
      const transform = `translate(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px) translate(-50%, -50%) scale(${s.scale.toFixed(3)})`;
      if (transform !== chip.transform) { chip.el.style.transform = transform; chip.transform = transform; }
      const opacity = s.opacity.toFixed(3);
      if (opacity !== chip.opacity) { chip.el.style.setProperty('--o', opacity); chip.opacity = opacity; }
    }
    if (s.visible !== chip.shown) {
      chip.el.classList.toggle('is-hidden', !s.visible);
      chip.shown = s.visible;
    }
  }

  /**
   * キーボードでフォーカスしている目印が出なくなるときは、Tab の順で次に出ている目印へフォーカスを移す
   * （ほかに出ているものがなければ外す）。L キーで全体を隠すときは、隠した本人の操作なので何もしない。
   */
  private moveFocusIfHidden(focused: Chip | null, states: readonly LabelState[]): void {
    if (!focused) return;
    const state = states[this.chips.indexOf(focused)]!;
    if (state.visible || state.reason === 'disabled') return;
    const visible = new Set(states.filter((s) => s.visible).map((s) => s.id));
    const next = focusFallback(this.chips.map((chip) => chip.cluster.id), visible, state.id);
    const target = next === null ? null : this.chips.find((chip) => chip.cluster.id === next)!;
    if (target) target.el.focus({ preventScroll: true });
    else focused.el.blur();
  }

  /**
   * 目印の上のポインタの操作を、目印のない場所と同じように働かせる。
   * - ホイール: canvas へ同じ内容の wheel を渡す。ページのズーム（Ctrl＋ホイール、ピンチ）は目印の上でも止める。
   * - ドラッグ: 押したままの移動が `DRAG_THRESHOLD_PX` を超えたら、押した位置からの pointerdown と現在位置の pointermove を
   *   canvas へ渡す。以降の移動と離す操作は、canvas が capture して受ける（視点の回転、ドラッグとしての扱い）。
   *   動かさずに離したときの click は、目印が受ける（クリックとしては canvas へ渡さないので、背後の点は選ばれない）。
   */
  private bindPointer(el: HTMLButtonElement, cluster: ClusterInfo): void {
    const target = this.deps.pointerTarget;
    let press: { pointerId: number; x: number; y: number } | null = null;
    let dragged = false;

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      target.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, composed: true,
        clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
        deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
      }));
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || press) return;
      dragged = false;
      press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      try { el.setPointerCapture(e.pointerId); } catch { /* 合成イベントなどでは無視 */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (!press || e.pointerId !== press.pointerId) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DRAG_THRESHOLD_PX) return;
      const { x, y } = press;
      press = null;
      dragged = true;
      try { el.releasePointerCapture(e.pointerId); } catch { /* すでに解放済み */ }
      const init = { pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary, bubbles: true, cancelable: true, composed: true };
      target.dispatchEvent(new PointerEvent('pointerdown', { ...init, button: 0, buttons: 1, clientX: x, clientY: y }));
      target.dispatchEvent(new PointerEvent('pointermove', { ...init, button: -1, buttons: e.buttons, clientX: e.clientX, clientY: e.clientY }));
    });
    const end = (e: PointerEvent) => { if (press && e.pointerId === press.pointerId) press = null; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('click', (e) => {
      if (dragged) { dragged = false; return; } // ドラッグの終わりはクリックではない
      this.flyToCluster(cluster);
      if (e.detail > 0) el.blur(); // マウスで押したあとはフォーカスを残さない（キーボードの操作はそのまま）
    });
  }

  private updateLocation(location: Location, camPos: Vec3): void {
    const el = this.deps.locationEl;
    if (!this.enabled || location.kind === 'none') {
      this.setLocationHidden(true);
      this.locationState = { ...EMPTY_LOCATION, kind: location.kind };
      return;
    }
    const chip = this.chips.find((c) => c.cluster.id === location.id)!;
    const cluster = chip.cluster;
    let direction: { arrow: string; word: string } | null = null;
    if (location.kind === 'nearest') {
      const m = this.deps.camera.matrixWorld.elements;
      const d: Vec3 = [cluster.center[0] - camPos[0], cluster.center[1] - camPos[1], cluster.center[2] - camPos[2]];
      const right = m[0]! * d[0] + m[1]! * d[1] + m[2]! * d[2];
      const up = m[4]! * d[0] + m[5]! * d[1] + m[6]! * d[2];
      const forward = -(m[8]! * d[0] + m[9]! * d[1] + m[10]! * d[2]);
      direction = describeDirection(right, up, forward);
    }
    const view = formatLocation(location, cluster.name, direction)!;
    this.locationState = {
      kind: location.kind, clusterId: cluster.id, name: cluster.name, text: view.text, direction, distance: location.distance,
    };
    // 要素は一度だけ作り、変わった部分（文面・色・種類）だけを書き換える
    if (!this.location) {
      const swatch = this.deps.document.createElement('span');
      swatch.className = 'cluster-location-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      const text = this.deps.document.createElement('span');
      el.textContent = '';
      el.append(swatch, text);
      this.location = { swatch, text };
    }
    if (view.text !== this.locationText) {
      this.location.text.textContent = view.text;
      this.locationText = view.text;
    }
    if (cluster.id !== this.locationClusterId) {
      this.location.swatch.style.background = clusterColor(cluster);
      this.locationClusterId = cluster.id;
    }
    if (location.kind !== this.locationKind) {
      el.dataset.kind = location.kind;
      this.locationKind = location.kind;
    }
    this.setLocationHidden(false);
  }

  private setLocationHidden(hidden: boolean): void {
    if (hidden === this.locationHidden) return;
    this.locationHidden = hidden;
    this.deps.locationEl.hidden = hidden;
  }
}
