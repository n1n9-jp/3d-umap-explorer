import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { CameraRig } from './cameraRig';
import { MAX_VIEW_PITCH, viewAngles } from '../render/view';

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

function createRig() {
  const camera = new PerspectiveCamera(60, 1.6, 0.0005, 12);
  const win = new FakeTarget();
  const el = new FakeTarget();
  el.ownerDocument = { defaultView: win };
  const rig = new CameraRig(camera, el as unknown as HTMLElement, new Vector3(), {});
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
