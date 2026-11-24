import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { CameraRig } from './cameraRig';
import { MAX_VIEW_PITCH, viewAngles } from '../render/view';
import { PointerGesture } from '../interaction/gesture';

type Handler = (e: never) => void;

/** DOM を使わずにイベントを流せる最小の EventTarget。 */
class FakeTarget {
  private readonly listeners = new Map<string, Set<Handler>>();
  readonly style = { touchAction: 'auto' };
  ownerDocument?: { defaultView: FakeTarget };
  addEventListener(type: string, fn: Handler): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.listeners.get(type)?.delete(fn);
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  emit(type: string, props: object = {}): void {
    const event = { defaultPrevented: false, preventDefault() {}, ...props };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event as never);
  }
}

function createRig(options: { cloudRadius?: number; reducedMotion?: boolean; center?: Vector3 } = {}) {
  const camera = new PerspectiveCamera(60, 1.6, 0.0005, 12);
  const win = new FakeTarget() as FakeTarget & { matchMedia?: (q: string) => { matches: boolean } };
  if (options.reducedMotion !== undefined) {
    const reduced = options.reducedMotion;
    win.matchMedia = (q: string) => ({ matches: reduced && q.includes('prefers-reduced-motion: reduce') });
  }
  const el = new FakeTarget();
  el.ownerDocument = { defaultView: win };
  const rig = new CameraRig(camera, el as unknown as HTMLElement, options.center ?? new Vector3(), { cloudRadius: options.cloudRadius });
  return { camera, win, el, rig };
}

const HOME = { pos: [0, 0.3, 2.6] as [number, number, number], look: [0, 0, 0] as [number, number, number] };
const forward = (camera: PerspectiveCamera) => camera.getWorldDirection(new Vector3());
const pitchOf = (camera: PerspectiveCamera) => Math.asin(forward(camera).y);

/** 1 秒の移動を 0.1 秒刻みで最後まで進める。 */
function runFlight(rig: CameraRig, seconds = 1.0, dt = 0.1): void {
  for (let t = 0; t < seconds + 1e-9; t += dt) rig.update(dt);
}

describe('CameraRig.setView: 真上・真下を向く視点', () => {
  for (const mode of ['fly', 'overview'] as const) {
    it(`${mode}モードでも仰角は ±89° に収まる`, () => {
      const { camera, rig } = createRig();
      rig.setMode(mode);
      for (const [pos, look, sign] of [[[0, 2, 0], [0, 0, 0], -1], [[0, -2, 0], [0, 0, 0], 1]] as const) {
        rig.setView({ pos: [...pos], look: [...look] });
        expect(pitchOf(camera)).toBeCloseTo(sign * MAX_VIEW_PITCH, 9);
        expect(camera.position.toArray()).toEqual([...pos]);
        expect(rig.getState().direction[1]).toBeCloseTo(sign * Math.sin(MAX_VIEW_PITCH), 9);
      }
    });
  }

  it('俯瞰モードで真下を向かせても、飛行モードへ戻して向きが跳ばない', () => {
    const { camera, rig } = createRig();
    rig.setMode('overview');
    rig.setView({ pos: [0, 2, 0], look: [0, 0, 0] });
    const before = forward(camera).clone();
    rig.setMode('fly');
    expect(forward(camera).distanceTo(before)).toBeLessThan(1e-9);
    rig.setMode('overview');
    expect(forward(camera).distanceTo(before)).toBeLessThan(1e-9);
  });

  it('位置と注視点が一致するときは向きを変えない', () => {
    const { camera, rig } = createRig();
    rig.setMode('overview');
    rig.setView({ pos: [1, 0, 0], look: [0, 0, -1] });
    const before = forward(camera).clone();
    rig.setView({ pos: [3, 3, 3], look: [3, 3, 3] });
    expect(forward(camera).distanceTo(before)).toBeLessThan(1e-9);
  });
});

describe('CameraRig.goHome', () => {
  for (const mode of ['fly', 'overview'] as const) {
    it(`${mode}モード: 約 1 秒でホームの視点へ着き、モードは変わらない`, () => {
      const { camera, rig } = createRig();
      rig.setMode(mode);
      rig.setView({ pos: [0.5, -0.4, 0.2], look: [0.9, -0.2, -0.5] });
      rig.goHome(HOME);
      expect(rig.getState().homing).toBe(true);
      runFlight(rig, 0.5);
      expect(rig.getState().homing).toBe(true);
      runFlight(rig, 0.6);
      const s = rig.getState();
      expect(s.homing).toBe(false);
      expect(s.mode).toBe(mode);
      expect(s.position).toEqual(HOME.pos);
      const want = new Vector3(...HOME.look).sub(new Vector3(...HOME.pos)).normalize();
      expect(forward(camera).distanceTo(want)).toBeLessThan(1e-9);
    });
  }

  it('位置と向きの両方が途中の値をとり、フレーム間で跳ばない', () => {
    const { camera, rig } = createRig();
    rig.setView({ pos: [1.5, 0, -0.5], look: [0, 0, -3] });
    const startPos = camera.position.clone();
    const startDir = forward(camera).clone();
    rig.goHome(HOME);
    const total = startPos.distanceTo(new Vector3(...HOME.pos));
    let prev = startPos.clone();
    let prevDir = startDir.clone();
    let maxStep = 0;
    let maxTurn = 0;
    let sawMidPos = false;
    let sawMidDir = false;
    const homeDir = new Vector3(...HOME.look).sub(new Vector3(...HOME.pos)).normalize();
    for (let i = 0; i < 10; i++) {
      rig.update(0.1);
      maxStep = Math.max(maxStep, camera.position.distanceTo(prev));
      maxTurn = Math.max(maxTurn, forward(camera).angleTo(prevDir));
      if (i === 4) {
        sawMidPos = camera.position.distanceTo(startPos) > 0.1 * total && camera.position.distanceTo(new Vector3(...HOME.pos)) > 0.1 * total;
        sawMidDir = forward(camera).angleTo(startDir) > 0.1 && forward(camera).angleTo(homeDir) > 0.1;
      }
      prev = camera.position.clone();
      prevDir = forward(camera).clone();
    }
    expect(sawMidPos).toBe(true);
    expect(sawMidDir).toBe(true);
    expect(maxStep).toBeLessThan(total * 0.2);
    expect(maxTurn).toBeLessThan(startDir.angleTo(homeDir) * 0.2);
  });

  it('始まりと終わりが緩やか（最初と最後のフレームの移動量が中ほどより小さい）', () => {
    const { camera, rig } = createRig();
    rig.setView({ pos: [1.5, 0, -0.5], look: [0, 0, -3] });
    rig.goHome(HOME);
    const steps: number[] = [];
    let prev = camera.position.clone();
    for (let i = 0; i < 10; i++) {
      rig.update(0.1);
      steps.push(camera.position.distanceTo(prev));
      prev = camera.position.clone();
    }
    expect(steps[0]).toBeLessThan((steps[4] as number) * 0.3);
    expect(steps[9]).toBeLessThan((steps[4] as number) * 0.3);
  });

  it('途中の姿勢は横傾き（roll）を持たない', () => {
    const { camera, rig } = createRig();
    rig.setMode('overview');
    rig.setView({ pos: [1.5, 0.9, -0.5], look: [0, 0, -3] });
    rig.goHome({ pos: [-1.2, 0.5, 2.0], look: [0, 0, 0] });
    for (let i = 0; i < 10; i++) {
      rig.update(0.1);
      expect(new Vector3(1, 0, 0).applyQuaternion(camera.quaternion).y).toBeCloseTo(0, 9);
    }
  });

  it('ホームが真上を向く視点でも仰角は ±89° に収まる', () => {
    const { camera, rig } = createRig();
    rig.goHome({ pos: [0, 2, 0], look: [0, 0, 0] });
    runFlight(rig);
    expect(pitchOf(camera)).toBeCloseTo(-MAX_VIEW_PITCH, 9);
  });

  it('飛行モードの移動キーで中断し、その場に留まる', () => {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ', 'ArrowUp']) {
      const { camera, win, rig } = createRig();
      rig.setView({ pos: [1.5, 0, -0.5], look: [0, 0, -3] });
      rig.goHome(HOME);
      runFlight(rig, 0.3);
      win.emit('keydown', { code, target: null });
      expect(rig.getState().homing).toBe(false);
      const at = camera.position.clone();
      rig.update(0); // 入力はまだ動きを生まない。ホームへの補間が止まっていること
      expect(camera.position.distanceTo(at)).toBeLessThan(1e-9);
      expect(at.distanceTo(new Vector3(...HOME.pos))).toBeGreaterThan(0.1);
    }
  });

  it('飛行モードの Shift・ホイール・修飾キー付きのキー・入力欄でのキーでは中断しない', () => {
    const { win, el, rig } = createRig();
    rig.setView({ pos: [1.5, 0, -0.5], look: [0, 0, -3] });
    rig.goHome(HOME);
    win.emit('keydown', { code: 'ShiftLeft', target: null });
    win.emit('keydown', { code: 'KeyW', ctrlKey: true, target: null });
    win.emit('keydown', { code: 'KeyW', target: { tagName: 'INPUT' } });
    win.emit('keydown', { code: 'KeyW', target: { tagName: 'DIV' }, composedPath: () => [{ tagName: 'INPUT' }] });
    el.emit('wheel', { deltaY: 100, ctrlKey: false });
    el.emit('pointerdown', { button: 2 });
    expect(rig.getState().homing).toBe(true);
  });

  it('ドラッグ（左ボタンの pointerdown）で中断する', () => {
    for (const mode of ['fly', 'overview'] as const) {
      const { el, rig } = createRig();
      rig.setMode(mode);
      rig.goHome(HOME);
      el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      expect(rig.getState().homing).toBe(false);
    }
  });

  it('俯瞰モードでは、ホイールで中断し、移動キーでは中断しない', () => {
    const { win, el, rig } = createRig();
    rig.setMode('overview');
    rig.goHome(HOME);
    win.emit('keydown', { code: 'KeyW', target: null });
    expect(rig.getState().homing).toBe(true);
    el.emit('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: false });
    expect(rig.getState().homing).toBe(false);
  });

  it('俯瞰モードでは、ピンチ（ctrlKey つきのホイール）でも中断する。deltaY が 0 のピンチと、飛行モードのピンチでは中断しない', () => {
    const { el, rig } = createRig();
    rig.setMode('overview');
    rig.goHome(HOME);
    el.emit('wheel', { deltaY: 0, deltaMode: 0, ctrlKey: true });
    expect(rig.getState().homing).toBe(true);
    el.emit('wheel', { deltaY: -5, deltaMode: 0, ctrlKey: true });
    expect(rig.getState().homing).toBe(false);

    const fly = createRig();
    fly.rig.goHome(HOME);
    fly.el.emit('wheel', { deltaY: -5, deltaMode: 0, ctrlKey: true });
    expect(fly.rig.getState().homing).toBe(true);
  });

  it('寄っている途中でホームへの移動を始めると、寄りは止まり、着いたあとに再開しない', () => {
    const { camera, el, rig } = createRig();
    rig.setView({ pos: [1.5, 0.5, 1.5], look: [0, 0, 0] });
    rig.setMode('overview');
    el.emit('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: false, timeStamp: 0 });
    rig.update(1 / 60);
    expect(rig.getState().overview?.zooming).toBe(true);
    rig.goHome(HOME);
    expect(rig.getState().overview?.zooming).toBe(false);
    runFlight(rig);
    expect(camera.position.toArray()).toEqual(HOME.pos);
    rig.update(0.1);
    expect(camera.position.toArray()).toEqual(HOME.pos);
  });

  it('寄っている途中の setView は、寄りを止めて指定の位置に留まる', () => {
    const { camera, el, rig } = createRig();
    rig.setView({ pos: [1.5, 0.5, 1.5], look: [0, 0, 0] });
    rig.setMode('overview');
    el.emit('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: false, timeStamp: 0 });
    rig.update(1 / 60);
    rig.setView({ pos: [0, 0, 1], look: [0, 0, 0] });
    rig.update(0.1);
    expect(camera.position.toArray()).toEqual([0, 0, 1]);
    expect(rig.getState().overview?.zooming).toBe(false);
  });

  it('getState の overview は、俯瞰モードの目標の距離・実際の距離・寄っている途中かを返す（飛行モードでは null）', () => {
    const { el, rig } = createRig();
    rig.setView({ pos: [0, 0, 2], look: [0, 0, 0] });
    expect(rig.getState().overview).toBeNull();
    rig.setMode('overview');
    expect(rig.getState().overview).toEqual({ distance: 2, targetDistance: 2, zooming: false });
    el.emit('wheel', { deltaY: -100, deltaMode: 0, ctrlKey: false, timeStamp: 0 });
    const mid = rig.getState().overview;
    expect(mid?.zooming).toBe(true);
    expect(mid?.distance).toBe(2);
    expect(mid?.targetDistance).toBeCloseTo(2 / 1.15, 12);
    for (let i = 0; i < 300; i++) rig.update(1 / 60);
    const end = rig.getState().overview;
    expect(end?.zooming).toBe(false);
    expect(end?.distance).toBeCloseTo(2 / 1.15, 12);
    expect(end?.targetDistance).toBe(end?.distance);
    rig.setMode('fly');
    expect(rig.getState().overview).toBeNull();
  });

  it('zoomTimeConstant は、オプションでも代入でも設定でき、null で既定へ戻る。0 では 1 度に動く', () => {
    const camera = new PerspectiveCamera(60, 1.6, 0.0005, 12);
    const win = new FakeTarget();
    const el = new FakeTarget();
    el.ownerDocument = { defaultView: win };
    const rig = new CameraRig(camera, el as unknown as HTMLElement, new Vector3(), { zoomTimeConstant: 0 });
    expect(rig.zoomTimeConstant).toBe(0);
    rig.setView({ pos: [0, 0, 2], look: [0, 0, 0] });
    rig.setMode('overview');
    el.emit('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: false, timeStamp: 0 });
    expect(camera.position.z).toBeCloseTo(2.3, 12);
    rig.zoomTimeConstant = null;
    expect(rig.zoomTimeConstant).toBe(0.15);
  });

  it('setView で中断する', () => {
    const { camera, rig } = createRig();
    rig.goHome(HOME);
    rig.setView({ pos: [0, 0, 1], look: [0, 0, 0] });
    expect(rig.getState().homing).toBe(false);
    runFlight(rig);
    expect(camera.position.toArray()).toEqual([0, 0, 1]);
  });

  it('移動中に O でモードを切り替えても、移動は続き、位置と向きは跳ばない', () => {
    const { camera, rig } = createRig();
    rig.setView({ pos: [1.5, 0, -0.5], look: [0, 0, -3] });
    rig.goHome(HOME);
    runFlight(rig, 0.4);
    const pos = camera.position.clone();
    const dir = forward(camera).clone();
    rig.setMode('overview');
    expect(camera.position.distanceTo(pos)).toBeLessThan(1e-9);
    expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-9);
    expect(rig.getState().homing).toBe(true);
    runFlight(rig, 0.7);
    expect(camera.position.toArray()).toEqual(HOME.pos);
    expect(rig.getState().mode).toBe('overview');
  });

  it('終わったあと、飛行モードの操作が着いた位置から使える', () => {
    const { camera, win, rig } = createRig();
    rig.goHome(HOME);
    runFlight(rig);
    win.emit('keydown', { code: 'KeyW', target: null });
    for (let i = 0; i < 5; i++) rig.update(0.1);
    expect(camera.position.z).toBeLessThan(HOME.pos[2]);
    const a = viewAngles({ pos: camera.position.toArray(), look: camera.position.clone().add(forward(camera)).toArray() });
    expect(a.pitch).toBeCloseTo(viewAngles(HOME).pitch, 6);
  });

  it('dispose でリスナーを外す', () => {
    const { win, el, rig } = createRig();
    rig.goHome(HOME);
    rig.dispose();
    win.emit('keydown', { code: 'KeyW', target: null });
    el.emit('pointerdown', { button: 0 });
    expect(rig.getState().homing).toBe(false); // dispose が移動を捨てる
  });
});

describe('CameraRig: 回転の慣性', () => {
  /** 16 ミリ秒ごとに (dx, 0) ピクセル動かして離す。 */
  function flick(el: FakeTarget, dx: number, frameCount = 12, startT = 1000) {
    let t = startT;
    el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: t });
    for (let i = 1; i <= frameCount; i++) {
      t += 16;
      el.emit('pointermove', { pointerId: 1, clientX: 100 + dx * i, clientY: 100, timeStamp: t });
    }
    el.emit('pointerup', { pointerId: 1, timeStamp: t });
    return t;
  }
  const inertiaStarted = (rig: CameraRig) => rig.isRotatingByInertia;

  for (const mode of ['fly', 'overview'] as const) {
    describe(`${mode}モード`, () => {
      it('離したあと、rig.update で回り続け、やがて止まる', () => {
        const { camera, el, rig } = createRig();
        rig.setMode(mode);
        rig.setView({ pos: [0, 0.2, 2], look: [0, 0, 0] });
        flick(el, 12);
        expect(inertiaStarted(rig)).toBe(true);
        const before = forward(camera).clone();
        rig.update(1 / 60);
        const afterOne = forward(camera).clone();
        expect(afterOne.distanceTo(before)).toBeGreaterThan(1e-4);
        for (let i = 0; i < 300; i++) rig.update(1 / 60);
        expect(inertiaStarted(rig)).toBe(false);
        const settled = forward(camera).clone();
        rig.update(1 / 60);
        expect(forward(camera).distanceTo(settled)).toBe(0);
        expect(settled.distanceTo(before)).toBeGreaterThan(0.1);
      });

      it('goHome で止まり、ホームへの移動のあとに回り出さない', () => {
        const { camera, el, rig } = createRig();
        rig.setMode(mode);
        flick(el, 12);
        rig.update(1 / 60);
        expect(inertiaStarted(rig)).toBe(true);
        rig.goHome(HOME);
        expect(inertiaStarted(rig)).toBe(false);
        runFlight(rig, 1.2);
        const want = new Vector3(...HOME.look).sub(new Vector3(...HOME.pos)).normalize();
        expect(forward(camera).distanceTo(want)).toBeLessThan(1e-9);
        for (let i = 0; i < 30; i++) rig.update(1 / 60);
        expect(forward(camera).distanceTo(want)).toBeLessThan(1e-9);
        expect(camera.position.toArray()).toEqual(HOME.pos);
      });

      it('setView で止まる', () => {
        const { camera, el, rig } = createRig();
        rig.setMode(mode);
        flick(el, 12);
        rig.update(1 / 60);
        rig.setView({ pos: [0, 0, 1], look: [0, 0, 0] });
        expect(inertiaStarted(rig)).toBe(false);
        const dir = forward(camera).clone();
        for (let i = 0; i < 20; i++) rig.update(1 / 60);
        expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-12);
      });

      it('flyTo で止まる（俯瞰モードからは飛行モードへ切り替わる）', () => {
        const { el, rig } = createRig();
        rig.setMode(mode);
        flick(el, 12);
        rig.update(1 / 60);
        rig.flyTo(new Vector3(0, 0, -3), { durationMs: 500 });
        expect(rig.mode).toBe('fly');
        expect(inertiaStarted(rig)).toBe(false);
        expect(rig.fly.isRotatingByInertia).toBe(false);
        expect(rig.overview.isRotatingByInertia).toBe(false);
      });

      it('ポインタを押すと止まる', () => {
        const { el, rig } = createRig();
        rig.setMode(mode);
        flick(el, 12);
        el.emit('pointerdown', { button: 0, pointerId: 5, clientX: 0, clientY: 0, timeStamp: 3000 });
        expect(inertiaStarted(rig)).toBe(false);
      });

      it('ウィンドウがフォーカスを失うと止まる', () => {
        const { win, el, rig } = createRig();
        rig.setMode(mode);
        flick(el, 12);
        win.emit('blur');
        expect(inertiaStarted(rig)).toBe(false);
      });

      it('時定数を 0 にすると無効（飛行・俯瞰の両方に効く）', () => {
        const { el, rig } = createRig();
        rig.rotationTimeConstant = 0;
        rig.setMode(mode);
        flick(el, 12);
        expect(inertiaStarted(rig)).toBe(false);
      });
    });
  }

  it('モードを切り替えると、慣性は操作側では止まり、切り替えの瞬間に向きが跳ばない（残った回転は短い時定数で消える）', () => {
    const { camera, el, rig } = createRig();
    rig.setView({ pos: [0.2, 0.1, 1.5], look: [0, 0, 0] });
    flick(el, 12);
    rig.update(1 / 60);
    const dir = forward(camera).clone();
    rig.setMode('overview');
    expect(rig.fly.isRotatingByInertia).toBe(false);
    expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-9); // 切り替えの瞬間は跳ばない
    for (let i = 0; i < 120; i++) rig.update(1 / 60);
    expect(rig.getState().reorienting).toBe(false);
    const settled = forward(camera).clone();
    for (let i = 0; i < 20; i++) rig.update(1 / 60);
    expect(forward(camera).distanceTo(settled)).toBeLessThan(1e-12); // やがて止まる

    flick(el, 12, 12, 5000);
    rig.update(1 / 60);
    expect(rig.overview.isRotatingByInertia).toBe(true);
    rig.setMode('fly');
    expect(rig.overview.isRotatingByInertia).toBe(false);
    const dir2 = forward(camera).clone();
    expect(forward(camera).distanceTo(dir2)).toBeLessThan(1e-9);
    for (let i = 0; i < 120; i++) rig.update(1 / 60);
    const settled2 = forward(camera).clone();
    for (let i = 0; i < 20; i++) rig.update(1 / 60);
    expect(forward(camera).distanceTo(settled2)).toBeLessThan(1e-12);
  });

  it('飛行モードでは、慣性で回っている間も移動キーで進む（位置は回転では変わらない）', () => {
    const { camera, win, el, rig } = createRig();
    rig.setView({ pos: [0, 0, 0], look: [0, 0, -1] });
    flick(el, 12);
    rig.update(1 / 60);
    expect(camera.position.length()).toBe(0);
    for (let i = 0; i < 10; i++) rig.update(1 / 60);
    expect(camera.position.length()).toBe(0); // 回転だけでは位置は変わらない
    win.emit('keydown', { code: 'KeyW', target: null });
    for (let i = 0; i < 10; i++) rig.update(1 / 60);
    expect(rig.isRotatingByInertia).toBe(true);
    expect(camera.position.length()).toBeGreaterThan(0.001);
    win.emit('keyup', { code: 'KeyW', target: null });
  });

  it('速度の自動調整は、回転だけの慣性では位置が変わらないので影響を受けない', () => {
    const { camera, el, rig } = createRig();
    rig.setView({ pos: [0.1, 0.2, 0.3], look: [0, 0, 0] });
    flick(el, 12);
    const p = camera.position.clone();
    for (let i = 0; i < 100; i++) rig.update(1 / 60);
    expect(camera.position.distanceTo(p)).toBe(0);
    expect(rig.getState().speedScale).toBe(1);
  });
});

/**
 * 点のクリックの判定（`InteractionController` の pointerdown / pointerup）と同じ配線を、DOM なしで再現する。
 * カメラ操作より先に登録した場合（`before`）と、後に登録した場合（`after`）の両方で、同じ結果になることを確かめる。
 */
describe('CameraRig: 慣性を止めた押下はクリックに数えない', () => {
  type Order = 'before' | 'after';

  function createWired(order: Order, mode: 'fly' | 'overview') {
    const camera = new PerspectiveCamera(60, 1.6, 0.0005, 12);
    const win = new FakeTarget();
    const el = new FakeTarget();
    el.ownerDocument = { defaultView: win };
    const gesture = new PointerGesture();
    const releases: unknown[] = [];
    let rig!: CameraRig;
    const wire = () => {
      el.addEventListener('pointerdown', ((e: { pointerId: number; button: number; clientX: number; clientY: number; buttons?: number }) => {
        gesture.down(e.pointerId, e.button, e.clientX, e.clientY, e.buttons ?? 1, rig.pressStopsInertia(e as unknown as PointerEvent));
      }) as never);
      el.addEventListener('pointerup', ((e: { pointerId: number; clientX: number; clientY: number; timeStamp: number; button?: number }) => {
        releases.push(gesture.up(e.pointerId, e.clientX, e.clientY, e.timeStamp, e.button ?? 0));
      }) as never);
    };
    if (order === 'before') wire();
    rig = new CameraRig(camera, el as unknown as HTMLElement, new Vector3(), {});
    if (order === 'after') wire();
    rig.setMode(mode);
    rig.setView({ pos: [0, 0.2, 2], look: [0, 0, 0] });
    return { camera, el, rig, releases };
  }

  /** 右へ速く払って離す（慣性が付く）。 */
  function flick(el: FakeTarget, startT = 1000) {
    let t = startT;
    el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: t });
    for (let i = 1; i <= 12; i++) {
      t += 16;
      el.emit('pointermove', { pointerId: 1, clientX: 100 + 16 * i, clientY: 100, timeStamp: t });
    }
    el.emit('pointerup', { pointerId: 1, clientX: 292, clientY: 100, timeStamp: t });
    return t;
  }

  for (const mode of ['fly', 'overview'] as const) {
    for (const order of ['before', 'after'] as const) {
      describe(`${mode}モード・クリックの判定のリスナーがカメラ操作の${order === 'before' ? '前' : '後'}`, () => {
        it('回っている最中に押して動かさずに離すと、慣性は止まり、クリックに数えない。次の押下は通常どおりクリック', () => {
          const { el, rig, releases } = createWired(order, mode);
          flick(el);
          releases.length = 0;
          rig.update(1 / 60);
          expect(rig.isRotatingByInertia).toBe(true);

          el.emit('pointerdown', { button: 0, pointerId: 2, clientX: 400, clientY: 300, timeStamp: 3000 });
          expect(rig.isRotatingByInertia).toBe(false);
          el.emit('pointerup', { pointerId: 2, clientX: 400, clientY: 300, timeStamp: 3040 });
          expect(releases).toEqual([{ kind: 'stop' }]);

          // 慣性が止まったあとの押下は、通常どおりクリック（ダブルクリックの 1 回目）
          el.emit('pointerdown', { button: 0, pointerId: 3, clientX: 400, clientY: 300, timeStamp: 3100 });
          el.emit('pointerup', { pointerId: 3, clientX: 400, clientY: 300, timeStamp: 3140 });
          expect(releases[1]).toEqual({ kind: 'click', x: 400, y: 300, double: false });
        });

        it('慣性を止めた押下の直後のクリックは、ダブルクリックにならない', () => {
          const { el, rig, releases } = createWired(order, mode);
          flick(el);
          rig.update(1 / 60);
          releases.length = 0;
          el.emit('pointerdown', { button: 0, pointerId: 2, clientX: 400, clientY: 300, timeStamp: 3000 });
          el.emit('pointerup', { pointerId: 2, clientX: 400, clientY: 300, timeStamp: 3030 });
          el.emit('pointerdown', { button: 0, pointerId: 3, clientX: 400, clientY: 300, timeStamp: 3100 });
          el.emit('pointerup', { pointerId: 3, clientX: 400, clientY: 300, timeStamp: 3130 });
          expect(releases).toEqual([{ kind: 'stop' }, { kind: 'click', x: 400, y: 300, double: false }]);
        });

        it('慣性を止めた押下からドラッグを始めたら、視点を回せて、クリックには数えない', () => {
          const { camera, el, rig, releases } = createWired(order, mode);
          flick(el);
          rig.update(1 / 60);
          releases.length = 0;
          el.emit('pointerdown', { button: 0, pointerId: 2, clientX: 400, clientY: 300, timeStamp: 3000 });
          expect(rig.isRotatingByInertia).toBe(false);
          const before = forward(camera).clone();
          el.emit('pointermove', { pointerId: 2, clientX: 460, clientY: 300, timeStamp: 3200 });
          el.emit('pointerup', { pointerId: 2, clientX: 460, clientY: 300, timeStamp: 3400 });
          rig.update(1 / 60); // 飛行モードは、ドラッグの回転をフレームの更新でカメラへ反映する
          expect(forward(camera).distanceTo(before)).toBeGreaterThan(0.01);
          expect(releases).toEqual([{ kind: 'drag' }]);
        });

        it('回っていないときの押下は、通常どおりクリック', () => {
          const { el, rig, releases } = createWired(order, mode);
          el.emit('pointerdown', { button: 0, pointerId: 2, clientX: 50, clientY: 50, timeStamp: 100 });
          el.emit('pointerup', { pointerId: 2, clientX: 50, clientY: 50, timeStamp: 130 });
          expect(rig.isRotatingByInertia).toBe(false);
          expect(releases).toEqual([{ kind: 'click', x: 50, y: 50, double: false }]);
        });

        it('慣性がもう止まっている（自然に止まったあと）の押下は、通常どおりクリック', () => {
          const { el, rig, releases } = createWired(order, mode);
          flick(el);
          for (let i = 0; i < 300; i++) rig.update(1 / 60);
          expect(rig.isRotatingByInertia).toBe(false);
          releases.length = 0;
          el.emit('pointerdown', { button: 0, pointerId: 2, clientX: 50, clientY: 50, timeStamp: 9000 });
          el.emit('pointerup', { pointerId: 2, clientX: 50, clientY: 50, timeStamp: 9030 });
          expect(releases).toEqual([{ kind: 'click', x: 50, y: 50, double: false }]);
        });
      });
    }
  }
});


describe('CameraRig: モードごとの回転の慣性の既定値', () => {
  it('飛行モード 0.35 秒・俯瞰モード 0.45 秒。代入は両方に効き、null でモードごとの既定へ戻る', () => {
    const { rig } = createRig();
    expect(rig.fly.rotationTimeConstant).toBe(0.35);
    expect(rig.overview.rotationTimeConstant).toBe(0.45);
    expect(rig.rotationTimeConstant).toBe(0.35); // 現在（飛行）のモードの値
    rig.setMode('overview');
    expect(rig.rotationTimeConstant).toBe(0.45);
    rig.rotationTimeConstant = 0.8;
    expect(rig.fly.rotationTimeConstant).toBe(0.8);
    expect(rig.overview.rotationTimeConstant).toBe(0.8);
    rig.rotationTimeConstant = null;
    expect(rig.fly.rotationTimeConstant).toBe(0.35);
    expect(rig.overview.rotationTimeConstant).toBe(0.45);
  });

  it('オプションで時定数を指定すると、両方のモードがその値を使う', () => {
    const camera = new PerspectiveCamera(60, 1.6, 0.0005, 12);
    const win = new FakeTarget();
    const el = new FakeTarget();
    el.ownerDocument = { defaultView: win };
    const rig = new CameraRig(camera, el as unknown as HTMLElement, new Vector3(), { rotationInertia: { timeConstant: 0.2 } });
    expect(rig.fly.rotationTimeConstant).toBe(0.2);
    expect(rig.overview.rotationTimeConstant).toBe(0.2);
    rig.rotationTimeConstant = null;
    expect(rig.fly.rotationTimeConstant).toBe(0.35);
    expect(rig.overview.rotationTimeConstant).toBe(0.45);
  });

  it('「動きを減らす」設定では、どちらのモードも既定で無効', () => {
    const { rig } = createRig({ reducedMotion: true });
    expect(rig.fly.rotationTimeConstant).toBe(0);
    expect(rig.overview.rotationTimeConstant).toBe(0);
  });
});

describe('CameraRig: 飛行 → 俯瞰で、点群の中心へ向き直す', () => {
  const unit = (v: Vector3) => v.clone().normalize();
  /** 位置 [0,0,2] から +X を向く（中心 [0,0,0] は真横の −Z 側で、90° ずれている）。 */
  const lookAway = (rig: CameraRig) => rig.setView({ pos: [0, 0, 2], look: [5, 0, 2] });
  const toCenter = (camera: PerspectiveCamera) => unit(new Vector3(0, 0, 0).sub(camera.position));
  const step = (rig: CameraRig, seconds: number, dt = 0.05) => {
    for (let t = 0; t < seconds - 1e-9; t += dt) rig.update(dt);
  };

  it('切り替えた瞬間は跳ばず、向き直しの最中は位置が変わらない。0.5 秒で終わり、終わったとき視線が中心を向く', () => {
    const { camera, rig } = createRig();
    lookAway(rig);
    const pos = camera.position.clone();
    const dir0 = forward(camera).clone();
    expect(rig.getState().reorienting).toBe(false);
    rig.setMode('overview');
    expect(forward(camera).distanceTo(dir0)).toBeLessThan(1e-12);
    expect(rig.getState().reorienting).toBe(true);
    expect(rig.getState().homing).toBe(false);
    for (let i = 0; i < 9; i++) {
      rig.update(0.05); // 0.45 秒まで
      expect(camera.position.toArray()).toEqual(pos.toArray());
      expect(rig.getState().reorienting).toBe(true);
    }
    expect(forward(camera).distanceTo(toCenter(camera))).toBeGreaterThan(1e-3);
    step(rig, 0.1);
    expect(rig.getState().reorienting).toBe(false);
    expect(camera.position.toArray()).toEqual(pos.toArray());
    expect(forward(camera).distanceTo(toCenter(camera))).toBeLessThan(1e-9);
    expect(rig.getState().mode).toBe('overview');
    expect(rig.getState().pivot).toEqual([0, 0, 0]);
  });

  it('進み方は f(t) = 1 − (1−t)³(1+3t)（水平のずれなら、回った角度が f(t) × 90°）', () => {
    const { camera, rig } = createRig();
    lookAway(rig);
    const dir0 = forward(camera).clone();
    rig.setMode('overview');
    let t = 0;
    for (let i = 0; i < 10; i++) {
      rig.update(0.05);
      t += 0.05;
      const f = 1 - (1 - t / 0.5) ** 3 * (1 + (3 * t) / 0.5);
      if (t < 0.5 - 1e-9) expect(forward(camera).angleTo(dir0)).toBeCloseTo(f * (Math.PI / 2), 6);
    }
  });

  it('始めと終わりが緩やか（最初と最後のフレームの回転量が、中ほどより小さい）', () => {
    const { camera, rig } = createRig();
    lookAway(rig);
    rig.setMode('overview');
    const turns: number[] = [];
    let prev = forward(camera).clone();
    for (let i = 0; i < 10; i++) {
      rig.update(0.05);
      turns.push(forward(camera).angleTo(prev));
      prev = forward(camera).clone();
    }
    // 1 フレーム 0.05 秒の刻みでは、最初と最後のフレームも少し進む（最も速いのは 0.2〜0.25 秒の間）
    expect(turns[0]).toBeLessThan((turns[4] as number) * 0.5);
    expect(turns[9]).toBeLessThan((turns[4] as number) * 0.5);
    expect(turns[0]).toBeLessThan((turns[3] as number) * 0.5);
    expect(turns[9]).toBeLessThan((turns[5] as number) * 0.5);
  });

  it('途中の姿勢は横傾き（roll）を持たず、視線の仰角は ±89° に収まる', () => {
    const { camera, rig } = createRig({ center: new Vector3(0.3, 2, 0.1) });
    rig.setView({ pos: [0.3, -1, 0.1], look: [4, -1, 0.1] }); // 中心はほぼ真上
    rig.setMode('overview');
    for (let i = 0; i < 12; i++) {
      rig.update(0.05);
      expect(new Vector3(1, 0, 0).applyQuaternion(camera.quaternion).y).toBeCloseTo(0, 9);
      expect(Math.abs(pitchOf(camera))).toBeLessThanOrEqual(MAX_VIEW_PITCH + 1e-9);
    }
  });

  it('向きのずれが 3° 未満なら何もしない。3° 以上なら向き直す', () => {
    const lookTilted = (deg: number) => {
      const yaw = (deg * Math.PI) / 180; // 中心 [0,0,0] を向く向き（−Z）から、左へ deg だけずらす
      return { pos: [0, 0, 2] as [number, number, number], look: [-Math.sin(yaw), 0, 2 - Math.cos(yaw)] as [number, number, number] };
    };
    {
      const { camera, rig } = createRig();
      rig.setView(lookTilted(2.9));
      const dir = forward(camera).clone();
      rig.setMode('overview');
      expect(rig.getState().reorienting).toBe(false);
      step(rig, 1);
      expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-12);
    }
    {
      const { camera, rig } = createRig();
      rig.setView(lookTilted(3.1));
      rig.setMode('overview');
      expect(rig.getState().reorienting).toBe(true);
      step(rig, 0.6);
      expect(forward(camera).distanceTo(toCenter(camera))).toBeLessThan(1e-9);
    }
  });

  it('ドラッグ（左ボタンの pointerdown）で中断し、その場の向きに留まる。回転の中心は点群の中心のまま', () => {
    const { camera, el, rig } = createRig();
    lookAway(rig);
    rig.setMode('overview');
    step(rig, 0.2);
    expect(rig.getState().reorienting).toBe(true);
    el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10, timeStamp: 100 });
    expect(rig.getState().reorienting).toBe(false);
    const dir = forward(camera).clone();
    expect(dir.distanceTo(toCenter(camera))).toBeGreaterThan(1e-3);
    step(rig, 0.6);
    expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-12);
    expect(rig.getState().pivot).toEqual([0, 0, 0]);
    // そのままドラッグすれば、点群の中心のまわりを回る（中心までの距離が保たれる）
    const r0 = camera.position.length();
    el.emit('pointermove', { pointerId: 1, clientX: 60, clientY: 10, timeStamp: 400 });
    expect(camera.position.length()).toBeCloseTo(r0, 9);
    expect(camera.position.distanceTo(new Vector3(0, 0, 2))).toBeGreaterThan(0.05);
  });

  it('右ボタンの押下では中断しない', () => {
    const { el, rig } = createRig();
    lookAway(rig);
    rig.setMode('overview');
    el.emit('pointerdown', { button: 2, pointerId: 1, clientX: 10, clientY: 10, timeStamp: 100 });
    expect(rig.getState().reorienting).toBe(true);
  });

  it('ホイールとピンチ（ctrlKey）で中断し、寄る・離れる操作として働く。横スクロール（deltaY 0）では中断しない', () => {
    for (const ctrlKey of [false, true]) {
      const { camera, el, rig } = createRig();
      lookAway(rig);
      rig.setMode('overview');
      step(rig, 0.1);
      el.emit('wheel', { deltaY: 0, deltaMode: 0, ctrlKey });
      expect(rig.getState().reorienting).toBe(true);
      const d0 = rig.getState().overview!.distance;
      el.emit('wheel', { deltaY: ctrlKey ? -30 : 100, deltaMode: 0, ctrlKey, timeStamp: 100 });
      expect(rig.getState().reorienting).toBe(false);
      // 距離の目標が動く（ホイールは 1.15 倍離れ、ピンチは exp(−0.3) 倍に寄る）
      const want = ctrlKey ? d0 * Math.exp(-0.3) : d0 * 1.15;
      expect(rig.getState().overview!.targetDistance).toBeCloseTo(want, 9);
      const dir = forward(camera).clone();
      step(rig, 1.5);
      expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-12);
      expect(rig.getState().overview!.distance).toBeCloseTo(want, 9);
      expect(rig.getState().pivot).toEqual([0, 0, 0]);
    }
  });

  it('向き直しの最中に O で飛行モードへ戻すと、向き直しをやめ、その時点の姿勢から飛行を続ける', () => {
    const { camera, win, rig } = createRig();
    lookAway(rig);
    rig.setMode('overview');
    step(rig, 0.2);
    const pos = camera.position.clone();
    const dir = forward(camera).clone();
    rig.setMode('fly');
    expect(rig.getState().reorienting).toBe(false);
    expect(rig.getState().mode).toBe('fly');
    step(rig, 0.6);
    expect(camera.position.distanceTo(pos)).toBeLessThan(1e-12);
    expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-9);
    // 飛行の操作がその姿勢から使える（W は、その時点の視線の向きへ進む）
    win.emit('keydown', { code: 'KeyW', target: null });
    for (let i = 0; i < 10; i++) rig.update(0.05);
    const moved = camera.position.clone().sub(pos);
    expect(moved.length()).toBeGreaterThan(0.01);
    expect(unit(moved).distanceTo(dir)).toBeLessThan(1e-6);
  });

  it('setView・goHome・flyTo で中断する', () => {
    for (const action of ['setView', 'goHome', 'flyTo'] as const) {
      const { rig } = createRig();
      lookAway(rig);
      rig.setMode('overview');
      expect(rig.getState().reorienting).toBe(true);
      if (action === 'setView') rig.setView({ pos: [0, 0, 1], look: [0, 0, 0] });
      else if (action === 'goHome') rig.goHome(HOME);
      else rig.flyTo(new Vector3(0, 0, -3), { durationMs: 500 });
      expect(rig.getState().reorienting).toBe(false);
    }
  });

  it('ホームへ移動中に O で切り替えても、向き直しはせず、移動を続ける', () => {
    const { rig } = createRig();
    lookAway(rig);
    rig.goHome(HOME);
    rig.setMode('overview');
    expect(rig.getState().reorienting).toBe(false);
    expect(rig.getState().homing).toBe(true);
  });

  it('中心と位置が重なっているときは何もしない', () => {
    const { camera, rig } = createRig();
    rig.setView({ pos: [0, 0, 0], look: [0, 0, -1] });
    const dir = forward(camera).clone();
    rig.setMode('overview');
    expect(rig.getState().reorienting).toBe(false);
    step(rig, 0.6);
    expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-12);
  });

  it('「動きを減らす」設定では、向き直さない（従来どおり、位置も向きも保ったまま、回転の中心だけを点群の中心にする）', () => {
    const { camera, rig } = createRig({ reducedMotion: true });
    lookAway(rig);
    const pos = camera.position.clone();
    const dir = forward(camera).clone();
    rig.setMode('overview');
    expect(rig.getState().reorienting).toBe(false);
    step(rig, 1);
    expect(camera.position.toArray()).toEqual(pos.toArray());
    expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-12);
    expect(rig.getState().pivot).toEqual([0, 0, 0]);
  });

  it('dispose で向き直しを捨てる', () => {
    const { rig } = createRig();
    lookAway(rig);
    rig.setMode('overview');
    rig.dispose();
    expect(rig.getState().reorienting).toBe(false);
  });

  it('向き直しが終わったあと、ドラッグで中心が画面の中央に留まったまま回る（中心の方向が視線から外れない）', () => {
    const { camera, el, rig } = createRig();
    lookAway(rig);
    rig.setMode('overview');
    step(rig, 0.6);
    el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: 1000 });
    for (let i = 1; i <= 10; i++) {
      el.emit('pointermove', { pointerId: 1, clientX: 100 + 12 * i, clientY: 100 + 3 * i, timeStamp: 1000 + 200 * i });
      expect(forward(camera).distanceTo(toCenter(camera))).toBeLessThan(1e-9);
    }
    el.emit('pointerup', { pointerId: 1, clientX: 220, clientY: 130, timeStamp: 3500 });
  });
});

describe('CameraRig: 切り替えた瞬間に残っている動きを、時定数 0.15 秒で減らして消す', () => {
  const TAU = 0.15;
  /** W を押し続けて、速度が定常（基準速度）になるまで進める。 */
  function cruise(rig: CameraRig, win: FakeTarget): void {
    win.emit('keydown', { code: 'KeyW', target: null });
    for (let i = 0; i < 40; i++) rig.update(0.1);
  }

  it('飛行 → 俯瞰: 移動の速度が、時定数 0.15 秒で減りながら進み、やがて止まる（総距離は v0 × τ）', () => {
    const { camera, win, rig } = createRig();
    rig.setView({ pos: [0, 0, 5], look: [0, 0, 4] });
    cruise(rig, win);
    const v0 = rig.getState().effectiveSpeed; // 定常の速度（W だけなので、視線の向きへ）
    const dir = forward(camera).clone();
    const at = camera.position.clone();
    rig.setMode('overview');
    const dt = 1 / 60;
    const steps: number[] = [];
    let prev = camera.position.clone();
    for (let i = 0; i < 300; i++) {
      rig.update(dt);
      steps.push(camera.position.distanceTo(prev));
      prev = camera.position.clone();
    }
    expect(steps[0]).toBeGreaterThan(0); // 急に止まらない
    // 毎フレームの移動量は、exp(−dt/τ) の比で減る
    for (let i = 1; i < 60; i++) expect((steps[i] as number) / (steps[i - 1] as number)).toBeCloseTo(Math.exp(-dt / TAU), 6);
    const total = camera.position.distanceTo(at);
    expect(total).toBeGreaterThan(v0 * TAU * 0.98);
    expect(total).toBeLessThan(v0 * TAU * 1.0001);
    // 進んだ向きは、切り替えの瞬間の視線（W の向き）
    expect(camera.position.clone().sub(at).normalize().distanceTo(dir)).toBeLessThan(1e-6);
    // 止まったあとは動かない
    const settled = camera.position.clone();
    for (let i = 0; i < 30; i++) rig.update(dt);
    expect(camera.position.distanceTo(settled)).toBe(0);
  });

  it('総距離は刻み幅によらない', () => {
    const run = (dt: number) => {
      const { camera, win, rig } = createRig();
      rig.setView({ pos: [0, 0, 5], look: [0, 0, 4] });
      cruise(rig, win);
      const at = camera.position.clone();
      rig.setMode('overview');
      for (let t = 0; t < 3; t += dt) rig.update(dt);
      return camera.position.distanceTo(at);
    };
    expect(run(1 / 120)).toBeCloseTo(run(0.05), 6);
  });

  it('飛行 → 俯瞰: 回転の慣性が、その場で時定数 0.15 秒で減りながら回り、やがて止まる（総回転は rate × τ）', () => {
    const { camera, el, rig } = createRig();
    rig.setView({ pos: [0, 0, 2], look: [0, 0, 0] });
    const flickFast = () => {
      let t = 1000;
      el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: t });
      for (let i = 1; i <= 6; i++) {
        t += 16;
        el.emit('pointermove', { pointerId: 1, clientX: 100 + 5 * i, clientY: 100, timeStamp: t });
      }
      el.emit('pointerup', { pointerId: 1, timeStamp: t });
    };
    flickFast();
    const rate = rig.fly.getResidualMotion().yawRate;
    expect(rate).toBeLessThan(0); // 右へ払った（ヨーは減る）
    const dir = forward(camera).clone();
    const pos = camera.position.clone();
    rig.setMode('overview');
    expect(rig.fly.isRotatingByInertia).toBe(false);
    expect(rig.getState().reorienting).toBe(false); // 向きのずれは 3° 未満
    const yaws: number[] = [];
    for (let i = 0; i < 300; i++) {
      rig.update(1 / 60);
      yaws.push(Math.atan2(-forward(camera).x, -forward(camera).z));
    }
    const yaw0 = Math.atan2(-dir.x, -dir.z);
    expect(yaws[0]).toBeLessThan(yaw0); // 切り替えてすぐ止まらず、同じ向きへ回り続ける
    // 総回転は rate × τ。角速度が stopSpeed（0.02 rad/s）を下回った時点で打ち切るので、その分（stopSpeed × τ）だけ少ない
    const total = yaw0 - (yaws[299] as number);
    expect(total).toBeLessThanOrEqual(-rate * TAU + 1e-9);
    expect(total).toBeGreaterThan(-rate * TAU - 0.02 * TAU);
    expect(camera.position.distanceTo(pos)).toBeLessThan(1e-12);
    expect(rig.isRotatingByInertia).toBe(false);
  });

  it('向き直しの最中でも、残った回転は急に止まらず、始まりの向きを引き継ぎ、終わりは中心を向く', () => {
    const { camera, el, rig } = createRig();
    rig.setView({ pos: [0, 0, 2], look: [5, 0, 2] }); // 中心は 90° ずれている
    let t = 1000;
    el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: t });
    for (let i = 1; i <= 8; i++) {
      t += 16;
      el.emit('pointermove', { pointerId: 1, clientX: 100 - 8 * i, clientY: 100, timeStamp: t }); // 左へ払う（中心の向きと同じ回り）
    }
    el.emit('pointerup', { pointerId: 1, timeStamp: t });
    rig.update(1 / 60);
    const before = forward(camera).clone();
    rig.update(1 / 60);
    const prevTurn = forward(camera).angleTo(before);
    const last = forward(camera).clone();
    expect(prevTurn).toBeGreaterThan(0.01);
    rig.setMode('overview');
    expect(rig.getState().reorienting).toBe(true);
    rig.update(1 / 60);
    const firstTurn = forward(camera).angleTo(last);
    expect(firstTurn).toBeGreaterThan(prevTurn * 0.5); // 回転が途切れない
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    expect(rig.getState().reorienting).toBe(false);
    expect(forward(camera).distanceTo(unit0(camera))).toBeLessThan(1e-9);
  });

  it('向き直しの最中に残った移動の速度でずれても、終わりは中心を向く', () => {
    const { camera, win, rig } = createRig();
    rig.setView({ pos: [0, 0, 5], look: [5, 0, 5] }); // +X へ進む（中心は 90° ずれている）
    cruise(rig, win);
    rig.setMode('overview');
    expect(rig.getState().reorienting).toBe(true);
    const pos = camera.position.clone();
    for (let i = 0; i < 40 && rig.getState().reorienting; i++) rig.update(1 / 60);
    expect(rig.getState().reorienting).toBe(false);
    expect(camera.position.distanceTo(pos)).toBeGreaterThan(0.01); // 残った速度で、位置は動いている
    expect(forward(camera).distanceTo(unit0(camera))).toBeLessThan(1e-9); // 終わった瞬間は、そのときの位置から中心を向く
  });

  it('俯瞰 → 飛行: 周回の慣性が、中心のまわりで時定数 0.15 秒で減りながら回り、やがて止まる。飛行の入力はすぐ使える', () => {
    const { camera, win, el, rig } = createRig();
    rig.setView({ pos: [1.4, 0.4, 1.5], look: [0, 0, 0] });
    rig.setMode('overview');
    for (let i = 0; i < 60; i++) rig.update(1 / 60); // 向き直しなし（中心を向いている）
    const r0 = camera.position.length();
    let t = 1000;
    el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: t });
    for (let i = 1; i <= 6; i++) {
      t += 16;
      el.emit('pointermove', { pointerId: 1, clientX: 100 + 8 * i, clientY: 100, timeStamp: t });
    }
    el.emit('pointerup', { pointerId: 1, timeStamp: t });
    const rate = rig.overview.getResidualRotation().yawRate;
    expect(rate).toBeLessThan(0);
    const azimuth = () => Math.atan2(camera.position.x, camera.position.z);
    const a0 = azimuth();
    rig.setMode('fly');
    expect(rig.overview.isRotatingByInertia).toBe(false);
    expect(rig.fly.isRotatingByInertia).toBe(false);
    for (let i = 0; i < 300; i++) {
      rig.update(1 / 60);
      expect(camera.position.length()).toBeCloseTo(r0, 6); // 中心までの距離は保たれる
    }
    const turned = azimuth() - a0; // 総回転は rate × τ（角速度が stopSpeed を下回った時点で打ち切るので、その分だけ少ない）
    expect(turned).toBeGreaterThanOrEqual(rate * TAU - 1e-9);
    expect(turned).toBeLessThan(rate * TAU + 0.02 * TAU);
    const settled = camera.position.clone();
    for (let i = 0; i < 20; i++) rig.update(1 / 60);
    expect(camera.position.distanceTo(settled)).toBe(0);
    // 飛行の入力がすぐ使える
    win.emit('keydown', { code: 'KeyW', target: null });
    for (let i = 0; i < 10; i++) rig.update(0.05);
    expect(camera.position.distanceTo(settled)).toBeGreaterThan(0.01);
  });

  it('飛行モードで残った周回の最中に W を押しても、移動は止まらない（残りが、飛行操作の速度を消さない）', () => {
    const { camera, win, el, rig } = createRig();
    rig.setView({ pos: [1.4, 0.4, 1.5], look: [0, 0, 0] });
    rig.setMode('overview');
    let t = 1000;
    el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: t });
    for (let i = 1; i <= 6; i++) {
      t += 16;
      el.emit('pointermove', { pointerId: 1, clientX: 100 + 8 * i, clientY: 100, timeStamp: t });
    }
    el.emit('pointerup', { pointerId: 1, timeStamp: t });
    rig.setMode('fly');
    win.emit('keydown', { code: 'KeyW', target: null });
    const p0 = camera.position.clone();
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    expect(rig.fly.getResidualMotion().velocity.length()).toBeGreaterThan(0.2); // 速度が積み上がっている（毎フレーム捨てられない）
    expect(camera.position.distanceTo(p0)).toBeGreaterThan(0.1);
  });

  it('ポインタを押すと、残った回転は止まる', () => {
    const { camera, el, rig } = createRig();
    rig.setView({ pos: [1.4, 0.4, 1.5], look: [0, 0, 0] });
    rig.setMode('overview');
    let t = 1000;
    el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: t });
    for (let i = 1; i <= 6; i++) {
      t += 16;
      el.emit('pointermove', { pointerId: 1, clientX: 100 + 8 * i, clientY: 100, timeStamp: t });
    }
    el.emit('pointerup', { pointerId: 1, timeStamp: t });
    rig.setMode('fly');
    rig.update(1 / 60);
    el.emit('pointerdown', { button: 0, pointerId: 2, clientX: 5, clientY: 5, timeStamp: 3000 });
    const at = camera.position.clone();
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    expect(camera.position.distanceTo(at)).toBeLessThan(1e-12);
  });

  it('ホームへの移動・視点の設定・flyTo は、残った動きを捨てる', () => {
    for (const action of ['setView', 'goHome', 'flyTo'] as const) {
      const { camera, win, rig } = createRig();
      rig.setView({ pos: [0, 0, 5], look: [0, 0, 4] });
      cruise(rig, win);
      rig.setMode('overview');
      if (action === 'setView') {
        rig.setView({ pos: [0, 0, 1], look: [0, 0, 0] });
        const at = camera.position.clone();
        for (let i = 0; i < 30; i++) rig.update(1 / 60);
        expect(camera.position.distanceTo(at)).toBe(0);
      } else if (action === 'goHome') {
        rig.goHome(HOME);
        runFlight(rig, 1.2);
        for (let i = 0; i < 30; i++) rig.update(1 / 60);
        expect(camera.position.toArray()).toEqual(HOME.pos);
      } else {
        rig.flyTo(new Vector3(0, 0, -3), { durationMs: 500 });
        expect(rig.getState().mode).toBe('fly');
        expect(rig.getState().reorienting).toBe(false);
      }
    }
  });

  it('「動きを減らす」設定では、残った動きはすぐに捨てる', () => {
    const { camera, win, rig } = createRig({ reducedMotion: true });
    rig.setView({ pos: [0, 0, 5], look: [0, 0, 4] });
    cruise(rig, win);
    const at = camera.position.clone();
    rig.setMode('overview');
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    expect(camera.position.distanceTo(at)).toBe(0);
  });

  it('ホームへ移動中の切り替えでは、残った動きを持ち越さない', () => {
    const { camera, win, rig } = createRig();
    rig.setView({ pos: [0, 0, 5], look: [0, 0, 4] });
    cruise(rig, win);
    rig.goHome(HOME);
    rig.setMode('overview');
    runFlight(rig, 1.2);
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    expect(camera.position.toArray()).toEqual(HOME.pos);
  });
});

/** 中心 [0,0,0] を向く単位ベクトル。 */
function unit0(camera: PerspectiveCamera): Vector3 {
  return new Vector3(0, 0, 0).sub(camera.position).normalize();
}

describe('CameraRig: 滑走・寄り・モードの切り替えの組み合わせ', () => {
  const TAU = 0.15;
  const dt = 1 / 60;
  /** W を押し続けて定常の速さにし、離して数フレーム滑走させる。 */
  function glide(rig: CameraRig, win: FakeTarget): void {
    win.emit('keydown', { code: 'KeyW', target: null });
    for (let i = 0; i < 40; i++) rig.update(0.1);
    win.emit('keyup', { code: 'KeyW', target: null });
    for (let i = 0; i < 3; i++) rig.update(dt);
  }
  /** カメラが止まったと状態が言うまで進める（上限つき）。進めたフレーム数を返す。 */
  function untilStill(rig: CameraRig, max = 600): number {
    let n = 0;
    for (; n < max; n++) {
      const s = rig.getState();
      if (!s.reorienting && !s.settling && !s.rotating && !s.moveInertia.gliding && !s.homing && !s.overview?.zooming) break;
      rig.update(dt);
    }
    return n;
  }

  it('滑走中に飛行 → 俯瞰: 残った速度は時定数 0.15 秒で消え、滑走（0.5 秒）は引き継がない', () => {
    const { camera, win, rig } = createRig();
    rig.setView({ pos: [0, 0, 5], look: [0, 0, 4] });
    glide(rig, win);
    expect(rig.getState().moveInertia.gliding).toBe(true);
    const v = rig.fly.getResidualMotion().velocity.length();
    expect(v).toBeGreaterThan(0.1);
    const at = camera.position.clone();
    rig.setMode('overview');
    const s0 = rig.getState();
    expect(s0.moveInertia.gliding).toBe(false);
    expect(s0.settling).toBe(true);
    const steps: number[] = [];
    let prev = camera.position.clone();
    for (let i = 0; i < 300; i++) {
      rig.update(dt);
      steps.push(camera.position.distanceTo(prev));
      prev = camera.position.clone();
    }
    // 毎フレームの移動量の比は exp(−dt/0.15)（滑走なら exp(−dt/0.5)）
    for (let i = 1; i < 60; i++) expect((steps[i] as number) / (steps[i - 1] as number)).toBeCloseTo(Math.exp(-dt / TAU), 6);
    const total = camera.position.distanceTo(at);
    expect(total).toBeGreaterThan(v * TAU * 0.98);
    expect(total).toBeLessThan(v * TAU * 1.0001); // 滑走を引き継いでいれば v × 0.5 に近づく
    expect(rig.getState().settling).toBe(false);
  });

  it('滑走中に飛行 → 俯瞰 → すぐ飛行: 飛行は速度 0 から始まり、滑走も残った速度も残らない', () => {
    const { camera, win, rig } = createRig();
    rig.setView({ pos: [0, 0, 5], look: [0, 0, 4] });
    glide(rig, win);
    rig.setMode('overview');
    rig.update(dt);
    expect(rig.getState().settling).toBe(true);
    rig.setMode('fly');
    const s = rig.getState();
    expect(s.settling).toBe(false);
    expect(s.moveInertia.gliding).toBe(false);
    expect(rig.fly.getResidualMotion().velocity.length()).toBe(0);
    const at = camera.position.clone();
    for (let i = 0; i < 60; i++) rig.update(dt);
    expect(camera.position.distanceTo(at)).toBe(0);
    expect(rig.getState().moveInertia.gliding).toBe(false);
  });

  it('寄っている途中に飛行へ切り替えると、寄りは止まり、俯瞰へ戻しても再開しない', () => {
    const { camera, el, rig } = createRig();
    rig.setMode('overview');
    rig.setView({ pos: [0, 0, 2], look: [0, 0, 0] });
    el.emit('wheel', { deltaY: -100, deltaMode: 0, timeStamp: 0 });
    rig.update(dt);
    expect(rig.getState().overview?.zooming).toBe(true);
    rig.setMode('fly');
    const at = camera.position.clone();
    for (let i = 0; i < 60; i++) rig.update(dt);
    expect(camera.position.distanceTo(at)).toBe(0);
    rig.setMode('overview');
    const z = rig.getState().overview!;
    expect(z.zooming).toBe(false);
    expect(z.targetDistance).toBe(z.distance);
    for (let i = 0; i < 60; i++) rig.update(dt);
    expect(camera.position.distanceTo(at)).toBe(0);
  });

  it('向き直しの最中と、残った動きが消えるまでは、状態でカメラが動いていると分かる。止まったと言ったあとは動かない', () => {
    const { camera, win, rig } = createRig();
    rig.setView({ pos: [0, 0, 5], look: [5, 0, 5] }); // 中心は 90° ずれている
    glide(rig, win);
    rig.setMode('overview');
    expect(rig.getState().reorienting).toBe(true);
    expect(rig.getState().settling).toBe(true);
    // 状態が「動いている」と言う間は、カメラの行列がフレームごとに変わる
    let moving = 0;
    for (let i = 0; i < 600; i++) {
      const s = rig.getState();
      if (!s.reorienting && !s.settling) break;
      const before = camera.matrixWorld.clone();
      rig.update(dt);
      expect(camera.matrixWorld.equals(before)).toBe(false);
      moving++;
    }
    expect(moving).toBeGreaterThan(30); // 向き直しの 0.5 秒以上
    expect(untilStill(rig)).toBe(0);
    const still = camera.matrixWorld.clone();
    for (let i = 0; i < 60; i++) rig.update(dt);
    expect(camera.matrixWorld.equals(still)).toBe(true);
  });

  it('「動きを減らす」設定では、滑走・滑らかな寄り・切り替えの移り変わりがどれも無効', () => {
    const { camera, win, el, rig } = createRig({ reducedMotion: true });
    expect(rig.fly.glideTimeConstant).toBe(0.12);
    expect(rig.zoomTimeConstant).toBe(0);
    rig.setView({ pos: [0, 0, 5], look: [5, 0, 5] });
    win.emit('keydown', { code: 'KeyW', target: null });
    for (let i = 0; i < 40; i++) rig.update(0.1);
    const dir = forward(camera).clone();
    rig.setMode('overview'); // キーを押したまま切り替える
    const s = rig.getState();
    expect(s.reorienting).toBe(false);
    expect(s.settling).toBe(false);
    const at = camera.position.clone();
    for (let i = 0; i < 60; i++) rig.update(dt);
    expect(camera.position.distanceTo(at)).toBe(0); // 残った速度で進まない
    expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-12); // 向き直さない
    const d0 = rig.getState().overview!.distance;
    el.emit('wheel', { deltaY: 100, deltaMode: 0, timeStamp: 0 });
    expect(rig.getState().overview!.zooming).toBe(false);
    expect(rig.getState().overview!.distance).toBeCloseTo(d0 * 1.15, 9); // 1 度に動く
  });
});

describe('CameraRig: 自動移動の所要時間（getState().flight）', () => {
  const DEFAULT_START = { pos: [0, 0, 0] as [number, number, number], look: [0, 0, -1] as [number, number, number] };

  it('goHome: 基準 1 秒を距離で伸縮した所要時間と、進みが読める。着くと null', () => {
    const { rig } = createRig({ cloudRadius: 1 });
    rig.setView(DEFAULT_START);
    expect(rig.getState().flight).toBeNull();
    rig.goHome(HOME); // 距離 ≈ 2.62
    const f = rig.getState().flight;
    const d = Math.hypot(...HOME.pos);
    expect(f?.kind).toBe('home');
    expect(f?.durationMs).toBeCloseTo(1000 * Math.min(1.8, 0.8 + 0.25 * Math.log2(1 + d / 0.25)), 6);
    expect(f?.progress).toBe(0);
    rig.update(0.1);
    expect(rig.getState().flight?.progress).toBeCloseTo(0.1 / ((f?.durationMs ?? 1) / 1000), 9);
    runFlight(rig, 2.5);
    expect(rig.getState().flight).toBeNull();
    expect(rig.getState().position).toEqual(HOME.pos);
  });

  it('goHome: 基準（ミニマップは 0.6 秒）・近い移動は短く、半径がなければ基準のまま', () => {
    const near = createRig({ cloudRadius: 1 });
    near.rig.setView(DEFAULT_START);
    near.rig.goHome({ pos: [0, 0, 0.1], look: [0, 0, -1] }, 0.6);
    expect(near.rig.getState().flight?.durationMs).toBeLessThan(600);
    expect(near.rig.getState().flight?.durationMs).toBeGreaterThanOrEqual(600 * 0.8 - 1e-9);
    const plain = createRig();
    plain.rig.setView(DEFAULT_START);
    plain.rig.goHome(HOME, 0.6);
    expect(plain.rig.getState().flight?.durationMs).toBeCloseTo(600, 9);
  });

  it('goHome: 動きを減らす設定なら 0.5 倍', () => {
    const a = createRig({ cloudRadius: 1, reducedMotion: false });
    const b = createRig({ cloudRadius: 1, reducedMotion: true });
    for (const r of [a, b]) {
      r.rig.setView(DEFAULT_START);
      r.rig.goHome(HOME);
    }
    expect(b.rig.getState().flight?.durationMs).toBeCloseTo((a.rig.getState().flight?.durationMs ?? 0) * 0.5, 9);
    runFlight(b.rig, 1.0);
    expect(b.rig.getState().homing).toBe(false);
  });

  it('flyTo: 基準を距離で伸縮した所要時間。動きを減らす設定なら 0.5 倍。着くと null', () => {
    const a = createRig({ cloudRadius: 1, reducedMotion: false });
    const b = createRig({ cloudRadius: 1, reducedMotion: true });
    for (const r of [a, b]) {
      r.rig.setView({ pos: [0, 0, 1.5], look: [0, 0, 0] });
      r.rig.flyTo(new Vector3(0, 0, -0.5), { distance: 0.05, durationMs: 800 });
    }
    const fa = a.rig.getState().flight;
    const d = 1.5 + 0.5 - 0.05;
    expect(fa?.kind).toBe('fly');
    expect(fa?.durationMs).toBeCloseTo(800 * Math.min(1.8, 0.8 + 0.25 * Math.log2(1 + d / 0.25)), 6);
    expect(b.rig.getState().flight?.durationMs).toBeCloseTo((fa?.durationMs ?? 0) * 0.5, 9);
    for (let i = 0; i < 30; i++) a.rig.update(0.1);
    expect(a.rig.getState().flight).toBeNull();
    expect(a.rig.getState().position[2]).toBeCloseTo(-0.45, 9);
  });
});
