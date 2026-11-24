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

function createRig(options: { cloudRadius?: number; reducedMotion?: boolean } = {}) {
  const camera = new PerspectiveCamera(60, 1.6, 0.0005, 12);
  const win = new FakeTarget() as FakeTarget & { matchMedia?: (q: string) => { matches: boolean } };
  if (options.reducedMotion !== undefined) {
    const reduced = options.reducedMotion;
    win.matchMedia = (q: string) => ({ matches: reduced && q.includes('prefers-reduced-motion: reduce') });
  }
  const el = new FakeTarget();
  el.ownerDocument = { defaultView: win };
  const rig = new CameraRig(camera, el as unknown as HTMLElement, new Vector3(), { cloudRadius: options.cloudRadius });
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

  it('モードを切り替えると、回っていた慣性は止まり、切り替えで向きが跳ばない', () => {
    const { camera, el, rig } = createRig();
    rig.setView({ pos: [0.2, 0.1, 1.5], look: [0, 0, 0] });
    flick(el, 12);
    rig.update(1 / 60);
    const dir = forward(camera).clone();
    rig.setMode('overview');
    expect(rig.fly.isRotatingByInertia).toBe(false);
    expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-9);
    for (let i = 0; i < 20; i++) rig.update(1 / 60);
    expect(forward(camera).distanceTo(dir)).toBeLessThan(1e-9);

    flick(el, 12, 12, 5000);
    rig.update(1 / 60);
    expect(rig.overview.isRotatingByInertia).toBe(true);
    rig.setMode('fly');
    expect(rig.overview.isRotatingByInertia).toBe(false);
    const dir2 = forward(camera).clone();
    for (let i = 0; i < 20; i++) rig.update(1 / 60);
    expect(forward(camera).distanceTo(dir2)).toBeLessThan(1e-9);
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
