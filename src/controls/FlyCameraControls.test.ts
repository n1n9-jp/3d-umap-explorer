import { beforeEach, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { FlyCameraControls } from './FlyCameraControls';

type Handler = (e: never) => void;

/** DOM を使わずにリスナーの登録・解除を数える最小の EventTarget。 */
class FakeTarget {
  private readonly listeners = new Map<string, Set<Handler>>();
  readonly style: { touchAction: string } = { touchAction: 'auto' };
  readonly capturedPointers = new Set<number>();
  ownerDocument?: { defaultView: FakeTarget };

  addEventListener(type: string, fn: Handler): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(type: string, fn: Handler): void {
    this.listeners.get(type)?.delete(fn);
  }

  setPointerCapture(id: number): void {
    this.capturedPointers.add(id);
  }

  releasePointerCapture(id: number): void {
    this.capturedPointers.delete(id);
  }

  get listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  emit<T extends object>(type: string, props: T = {} as T): T & { defaultPrevented: boolean } {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...props,
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event as never);
    return event;
  }
}

interface Rig {
  camera: PerspectiveCamera;
  el: FakeTarget;
  win: FakeTarget;
  controls: FlyCameraControls;
}

function createRig(): Rig {
  const camera = new PerspectiveCamera(60, 1, 0.001, 10);
  const win = new FakeTarget();
  const el = new FakeTarget();
  el.ownerDocument = { defaultView: win };
  const controls = new FlyCameraControls(camera, el as unknown as HTMLElement);
  return { camera, el, win, controls };
}

const keydown = (r: Rig, code: string, extra: object = {}) => r.win.emit('keydown', { code, target: null, ...extra });
const keyup = (r: Rig, code: string, extra: object = {}) => r.win.emit('keyup', { code, target: null, ...extra });

function frames(c: FlyCameraControls, seconds: number, dt = 1 / 60): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) c.update(dt);
}

function viewDirection(camera: PerspectiveCamera): Vector3 {
  return camera.getWorldDirection(new Vector3());
}

describe('FlyCameraControls: キー入力', () => {
  let r: Rig;
  beforeEach(() => {
    r = createRig();
  });

  it('W で前進し、離すと慣性で止まる', () => {
    keydown(r, 'KeyW');
    frames(r.controls, 0.5);
    expect(r.camera.position.z).toBeLessThan(-0.01);
    keyup(r, 'KeyW');
    frames(r.controls, 3);
    const z = r.camera.position.z;
    expect(r.controls.update(1 / 60)).toBe(false);
    expect(r.camera.position.z).toBe(z);
  });

  it('矢印キーは WASD と同じ動きをする', () => {
    const pairs: [string, string][] = [
      ['KeyW', 'ArrowUp'],
      ['KeyS', 'ArrowDown'],
      ['KeyA', 'ArrowLeft'],
      ['KeyD', 'ArrowRight'],
    ];
    for (const [wasd, arrow] of pairs) {
      const a = createRig();
      const b = createRig();
      keydown(a, wasd);
      keydown(b, arrow);
      frames(a.controls, 0.5);
      frames(b.controls, 0.5);
      expect(a.camera.position.distanceTo(b.camera.position), `${wasd}/${arrow}`).toBe(0);
      expect(a.camera.position.length()).toBeGreaterThan(0.01);
    }
  });

  it('E で上、Q で下（ワールド）', () => {
    keydown(r, 'KeyE');
    frames(r.controls, 0.5);
    keyup(r, 'KeyE');
    expect(r.camera.position.y).toBeGreaterThan(0.01);
    const up = r.camera.position.y;
    keydown(r, 'KeyQ');
    frames(r.controls, 1.5);
    expect(r.camera.position.y).toBeLessThan(up);
  });

  it('Shift を押している間は 3 倍速', () => {
    const a = createRig();
    const b = createRig();
    a.controls.timeConstant = 0;
    b.controls.timeConstant = 0;
    keydown(a, 'KeyW');
    keydown(b, 'ShiftLeft', { shiftKey: true });
    keydown(b, 'KeyW', { shiftKey: true });
    frames(a.controls, 1);
    frames(b.controls, 1);
    expect(b.camera.position.length() / a.camera.position.length()).toBeCloseTo(3, 9);
    // Shift を離したら通常速度へ戻る
    keyup(b, 'ShiftLeft', { shiftKey: false });
    const before = b.camera.position.clone();
    frames(b.controls, 1);
    expect(b.camera.position.distanceTo(before)).toBeCloseTo(a.camera.position.length(), 9);
  });

  it('移動キーの keydown は既定動作を止める（矢印キーでページがスクロールしない）', () => {
    expect(keydown(r, 'ArrowDown').defaultPrevented).toBe(true);
    expect(keydown(r, 'KeyH').defaultPrevented).toBe(false);
  });

  it('Ctrl / Meta / Alt との組み合わせは反応せず、既定動作も止めない', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
      const rig = createRig();
      const ev = keydown(rig, 'KeyW', { [mod]: true });
      expect(ev.defaultPrevented).toBe(false);
      frames(rig.controls, 0.2);
      expect(rig.camera.position.length()).toBe(0);
    }
  });

  it('input / textarea / contenteditable にフォーカスがある間は反応しない', () => {
    const targets = [
      { tagName: 'INPUT' },
      { tagName: 'TEXTAREA' },
      { tagName: 'DIV', isContentEditable: true },
      { tagName: 'DIV', getAttribute: (n: string) => (n === 'contenteditable' ? '' : null) },
    ];
    for (const target of targets) {
      const rig = createRig();
      const ev = keydown(rig, 'KeyW', { target });
      expect(ev.defaultPrevented).toBe(false);
      frames(rig.controls, 0.2);
      expect(rig.camera.position.length(), JSON.stringify(target)).toBe(0);
    }
    // 通常の要素なら反応する
    keydown(r, 'KeyW', { target: { tagName: 'CANVAS' } });
    frames(r.controls, 0.2);
    expect(r.camera.position.length()).toBeGreaterThan(0);
  });

  it('入力欄へフォーカスが移ったあとに離したキーも解除される', () => {
    keydown(r, 'KeyW');
    keyup(r, 'KeyW', { target: { tagName: 'INPUT' } });
    frames(r.controls, 3);
    const p = r.camera.position.clone();
    frames(r.controls, 1);
    expect(r.camera.position.distanceTo(p)).toBe(0);
  });

  it('ウィンドウがフォーカスを失ったらキーの押下状態を消す', () => {
    keydown(r, 'KeyW');
    keydown(r, 'ShiftLeft', { shiftKey: true });
    frames(r.controls, 0.2);
    r.win.emit('blur');
    frames(r.controls, 3); // 慣性が収まる
    const p = r.camera.position.clone();
    frames(r.controls, 1);
    expect(r.camera.position.distanceTo(p)).toBe(0);
  });
});

describe('FlyCameraControls: 視点', () => {
  let r: Rig;
  beforeEach(() => {
    r = createRig();
  });

  const down = (button = 0, pointerId = 1) => r.el.emit('pointerdown', { button, pointerId, clientX: 100, clientY: 100 });
  const move = (x: number, y: number, pointerId = 1) => r.el.emit('pointermove', { pointerId, clientX: x, clientY: y });

  it('左ボタンのドラッグで回転する（右へドラッグで右を向く）', () => {
    down();
    move(200, 100);
    expect(r.controls.update(1 / 60)).toBe(true);
    const dir = viewDirection(r.camera);
    expect(dir.x).toBeGreaterThan(0.1);
    expect(Math.abs(dir.y)).toBeLessThan(1e-9);
  });

  it('下へドラッグで下を向く', () => {
    down();
    move(100, 160);
    r.controls.update(1 / 60);
    expect(viewDirection(r.camera).y).toBeLessThan(-0.1);
  });

  it('左ボタン以外・ポインタを押していない移動は無視する', () => {
    down(2);
    move(300, 100);
    expect(r.controls.update(1 / 60)).toBe(false);
    r.el.emit('pointerup', { pointerId: 1 });
    move(300, 100);
    expect(r.controls.update(1 / 60)).toBe(false);
  });

  it('ボタンを離したら回転は止まる', () => {
    down();
    move(150, 100);
    r.el.emit('pointerup', { pointerId: 1 });
    expect(r.el.capturedPointers.size).toBe(0);
    r.controls.update(1 / 60);
    const dir = viewDirection(r.camera);
    move(250, 100);
    expect(r.controls.update(1 / 60)).toBe(false);
    expect(viewDirection(r.camera).distanceTo(dir)).toBe(0);
  });

  it('ピッチは ±89° で止まり、ロールは入らない', () => {
    down();
    move(100, -100000); // 大きく上へ
    r.controls.update(1 / 60);
    const up = viewDirection(r.camera);
    expect(Math.asin(up.y)).toBeCloseTo((89 * Math.PI) / 180, 9);
    move(100, 100000);
    r.controls.update(1 / 60);
    expect(Math.asin(viewDirection(r.camera).y)).toBeCloseTo((-89 * Math.PI) / 180, 9);
    // カメラの右方向（ローカル +X）は常に水平
    const right = new Vector3(1, 0, 0).applyQuaternion(r.camera.quaternion);
    expect(Math.abs(right.y)).toBeLessThan(1e-9);
  });

  it('回したあとの前進は新しい視線方向へ進む', () => {
    r.controls.setPose(new Vector3(0, 0, 0), new Vector3(1, 0, 0)); // +X を向く
    keydown(r, 'KeyW');
    frames(r.controls, 0.5);
    expect(r.camera.position.x).toBeGreaterThan(0.01);
    expect(Math.abs(r.camera.position.z)).toBeLessThan(1e-9);
  });
});

describe('FlyCameraControls: 速度とイベント', () => {
  let r: Rig;
  beforeEach(() => {
    r = createRig();
  });

  const wheel = (deltaY: number, deltaMode = 0) => r.el.emit('wheel', { deltaY, deltaMode });

  it('既定値は speed 0.15 / minSpeed 0.005 / maxSpeed 2', () => {
    expect(r.controls.speed).toBe(0.15);
    expect(r.controls.minSpeed).toBe(0.005);
    expect(r.controls.maxSpeed).toBe(2);
  });

  it('ホイール 1 ノッチで約 1.1 倍になり、speedchange が発火し、既定のスクロールを止める', () => {
    const speeds: number[] = [];
    r.controls.addEventListener('speedchange', (e) => speeds.push(e.speed));
    const ev = wheel(-100);
    expect(ev.defaultPrevented).toBe(true);
    expect(r.controls.speed).toBeCloseTo(0.165, 12);
    wheel(100);
    expect(r.controls.speed).toBeCloseTo(0.15, 12);
    expect(speeds).toHaveLength(2);
    expect(speeds[0]).toBeCloseTo(0.165, 12);
  });

  it('deltaMode が行・ページのときも 1 ノッチ相当で換算する', () => {
    wheel(-3, 1);
    expect(r.controls.speed).toBeCloseTo(0.165, 12);
    wheel(-1, 2);
    expect(r.controls.speed).toBeCloseTo(0.15 * 1.1 * 1.1, 12);
  });

  it('上下限で止まり、変化がなければ speedchange を出さない', () => {
    let count = 0;
    r.controls.addEventListener('speedchange', () => count++);
    for (let i = 0; i < 300; i++) wheel(-100);
    expect(r.controls.speed).toBe(2);
    const reached = count;
    wheel(-100);
    expect(count).toBe(reached);
    for (let i = 0; i < 600; i++) wheel(100);
    expect(r.controls.speed).toBe(0.005);
  });

  it('speed の代入は丸められ、変われば speedchange を出す', () => {
    let last = -1;
    r.controls.addEventListener('speedchange', (e) => (last = e.speed));
    r.controls.speed = 50;
    expect(r.controls.speed).toBe(2);
    expect(last).toBe(2);
    r.controls.maxSpeed = 1;
    expect(r.controls.speed).toBe(1);
    expect(last).toBe(1);
  });

  it('change は動いたときだけ発火する', () => {
    let count = 0;
    r.controls.addEventListener('change', () => count++);
    r.controls.update(1 / 60);
    expect(count).toBe(0);
    keydown(r, 'KeyW');
    r.controls.update(1 / 60);
    expect(count).toBe(1);
    r.controls.setPose(new Vector3(), new Vector3(0, 0, -1));
    expect(count).toBe(2);
  });
});

describe('FlyCameraControls: flyTo / 姿勢', () => {
  let r: Rig;
  beforeEach(() => {
    r = createRig();
    r.controls.setPose(new Vector3(0.6, 0.3, 0.7), new Vector3(0, 0, 0));
  });

  it('終了位置は対象から distance だけ手前で、対象を注視している', () => {
    const target = new Vector3(-0.2, 0.1, -0.4);
    const start = r.camera.position.clone();
    r.controls.flyTo(target, { distance: 0.04 });
    expect(r.controls.isFlying).toBe(true);
    frames(r.controls, 0.7);
    expect(r.controls.isFlying).toBe(false);

    expect(r.camera.position.distanceTo(target)).toBeCloseTo(0.04, 9);
    const expectedDir = start.clone().sub(target).normalize();
    expect(r.camera.position.clone().sub(target).normalize().distanceTo(expectedDir)).toBeLessThan(1e-9);
    const view = viewDirection(r.camera);
    expect(view.distanceTo(target.clone().sub(r.camera.position).normalize())).toBeLessThan(1e-9);
  });

  it('飛行中に camera を更新する（change が出る）', () => {
    let count = 0;
    r.controls.addEventListener('change', () => count++);
    r.controls.flyTo(new Vector3(0, 0, 0), { distance: 0.1 });
    const start = r.camera.position.clone();
    expect(r.controls.update(1 / 60)).toBe(true);
    expect(r.camera.position.distanceTo(start)).toBeGreaterThan(0);
    expect(count).toBe(1);
  });

  it('キー操作で中断する', () => {
    r.controls.flyTo(new Vector3(0, 0, 0), { distance: 0.1 });
    frames(r.controls, 0.1);
    keydown(r, 'KeyD');
    r.controls.update(1 / 60);
    expect(r.controls.isFlying).toBe(false);
    const p = r.camera.position.clone();
    frames(r.controls, 1);
    // 飛行は再開せず、対象から 0.1 の位置には着いていない
    expect(r.camera.position.distanceTo(new Vector3(0, 0, 0))).toBeGreaterThan(0.11);
    expect(r.camera.position.distanceTo(p)).toBeGreaterThan(0.01);
  });

  it('ドラッグによる視点操作で中断する。押しただけでは中断しない', () => {
    r.controls.flyTo(new Vector3(0, 0, 0), { distance: 0.1 });
    r.el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    expect(r.controls.isFlying).toBe(true);
    r.el.emit('pointermove', { pointerId: 1, clientX: 10, clientY: 0 });
    expect(r.controls.isFlying).toBe(false);
  });

  it('ホイールでは中断しない', () => {
    r.controls.flyTo(new Vector3(0, 0, 0), { distance: 0.1 });
    r.el.emit('wheel', { deltaY: -100, deltaMode: 0 });
    expect(r.controls.isFlying).toBe(true);
  });

  it('setPose / getPose は camera に反映され、往復できる', () => {
    r.controls.setPose(new Vector3(0.1, 0.2, 0.3), new Vector3(0.5, 0.2, 0.3));
    expect(r.camera.position.distanceTo(new Vector3(0.1, 0.2, 0.3))).toBeLessThan(1e-12);
    expect(viewDirection(r.camera).distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
    const pose = r.controls.getPose();
    expect(pose.position.distanceTo(new Vector3(0.1, 0.2, 0.3))).toBeLessThan(1e-12);
    expect(pose.lookAt.distanceTo(new Vector3(1.1, 0.2, 0.3))).toBeLessThan(1e-9);
  });

  it('構築時に camera の姿勢を引き継ぐ', () => {
    const camera = new PerspectiveCamera();
    camera.position.set(0.3, 0.1, 0.5);
    camera.lookAt(new Vector3(0.3, 0.1, -1));
    const win = new FakeTarget();
    const el = new FakeTarget();
    el.ownerDocument = { defaultView: win };
    const c = new FlyCameraControls(camera, el as unknown as HTMLElement);
    const pose = c.getPose();
    expect(pose.position.distanceTo(new Vector3(0.3, 0.1, 0.5))).toBeLessThan(1e-12);
    expect(pose.lookAt.distanceTo(new Vector3(0.3, 0.1, -0.5))).toBeLessThan(1e-9);
    expect(c.update(1 / 60)).toBe(false);
  });
});

describe('FlyCameraControls: enabled と dispose', () => {
  it('enabled = false の間は入力を受けず、update は何もしない', () => {
    const r = createRig();
    r.controls.enabled = false;
    keydown(r, 'KeyW');
    r.el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    r.el.emit('pointermove', { pointerId: 1, clientX: 50, clientY: 0 });
    expect(r.el.emit('wheel', { deltaY: -100, deltaMode: 0 }).defaultPrevented).toBe(false);
    expect(r.controls.speed).toBe(0.15);
    expect(r.controls.update(1 / 60)).toBe(false);
    r.controls.flyTo(new Vector3(0, 0, -1));
    expect(r.controls.isFlying).toBe(false);
    expect(r.camera.position.length()).toBe(0);
  });

  it('無効化するとキー状態を捨てる（再有効化しても動き出さない）', () => {
    const r = createRig();
    keydown(r, 'KeyW');
    r.controls.enabled = false;
    r.controls.enabled = true;
    frames(r.controls, 0.5);
    expect(r.camera.position.length()).toBe(0);
  });

  it('dispose 後にリスナーが残っていない', () => {
    const r = createRig();
    expect(r.el.listenerCount).toBeGreaterThan(0);
    expect(r.win.listenerCount).toBeGreaterThan(0);
    expect(r.el.style.touchAction).toBe('none');
    r.controls.dispose();
    expect(r.el.listenerCount).toBe(0);
    expect(r.win.listenerCount).toBe(0);
    expect(r.el.style.touchAction).toBe('auto');
    // 二重 dispose は安全で、dispose 後の update は何もしない
    r.controls.dispose();
    keydown(r, 'KeyW');
    expect(r.controls.update(1 / 60)).toBe(false);
    expect(r.camera.position.length()).toBe(0);
  });

  it('dispose はドラッグ中のポインタキャプチャを解放する', () => {
    const r = createRig();
    r.el.emit('pointerdown', { button: 0, pointerId: 7, clientX: 0, clientY: 0 });
    expect(r.el.capturedPointers.has(7)).toBe(true);
    r.controls.dispose();
    expect(r.el.capturedPointers.size).toBe(0);
  });
});
