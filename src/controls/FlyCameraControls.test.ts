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

  it('Shift を押しても速さは変わらない', () => {
    const a = createRig();
    const b = createRig();
    a.controls.timeConstant = 0;
    b.controls.timeConstant = 0;
    keydown(a, 'KeyW');
    keydown(b, 'ShiftLeft', { shiftKey: true });
    keydown(b, 'KeyW', { shiftKey: true });
    frames(a.controls, 1);
    frames(b.controls, 1);
    // 既定の speed 0.45 で、Shift の有無によらず 1 秒に 0.45 進む
    expect(a.camera.position.length()).toBeCloseTo(0.45, 9);
    expect(b.camera.position.length()).toBeCloseTo(a.camera.position.length(), 9);
    // Shift を離しても同じ
    keyup(b, 'ShiftLeft', { shiftKey: false });
    const before = b.camera.position.clone();
    frames(b.controls, 1);
    expect(b.camera.position.distanceTo(before)).toBeCloseTo(a.camera.position.length(), 9);
  });

  it('Shift を押しながらの移動キーは、Shift なしと同じに動く（全方向）', () => {
    for (const code of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyE', 'KeyQ', 'ArrowUp', 'ArrowLeft']) {
      const a = createRig();
      const b = createRig();
      a.controls.timeConstant = 0;
      b.controls.timeConstant = 0;
      keydown(a, code);
      const ev = keydown(b, code, { shiftKey: true });
      expect(ev.defaultPrevented, code).toBe(true);
      frames(a.controls, 1);
      frames(b.controls, 1);
      expect(a.camera.position.length(), code).toBeGreaterThan(0.4);
      expect(b.camera.position.distanceTo(a.camera.position), code).toBeLessThan(1e-9);
      keyup(b, code, { shiftKey: true });
      keyup(a, code);
    }
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

  it('ボタンを離したら、ポインタの動きに回転は追従しない（慣性を無効にして確かめる）', () => {
    r.controls.rotationTimeConstant = 0;
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
  let clock: number;
  beforeEach(() => {
    r = createRig();
    clock = 0;
  });

  // 1 回の呼び出しを 1 回の独立したホイール操作（マウスホイールの 1 ノッチ）として扱うため、
  // 呼び出しごとに 500 ミリ秒進める。ホイールの「払い」の判定は連続したイベントの間隔で決まり、
  // 時刻を渡さないと全イベントが 1 つの払いにまとまって上限（約 2 倍）に当たるため。
  const wheel = (deltaY: number, deltaMode = 0) => {
    clock += 500;
    return r.el.emit('wheel', { deltaY, deltaMode, timeStamp: clock });
  };

  it('既定値は speed 0.45 / minSpeed 0.005 / maxSpeed 2', () => {
    expect(r.controls.speed).toBe(0.45);
    expect(r.controls.minSpeed).toBe(0.005);
    expect(r.controls.maxSpeed).toBe(2);
  });

  it('ホイール 1 ノッチで約 1.1 倍になり、speedchange が発火し、既定のスクロールを止める', () => {
    const speeds: number[] = [];
    r.controls.addEventListener('speedchange', (e) => speeds.push(e.speed));
    const ev = wheel(-100);
    expect(ev.defaultPrevented).toBe(true);
    expect(r.controls.speed).toBeCloseTo(0.495, 12);
    wheel(100);
    expect(r.controls.speed).toBeCloseTo(0.45, 12);
    expect(speeds).toHaveLength(2);
    expect(speeds[0]).toBeCloseTo(0.495, 12);
  });

  it('deltaMode が行・ページのときも 1 ノッチ相当で換算する', () => {
    wheel(-3, 1);
    expect(r.controls.speed).toBeCloseTo(0.495, 12);
    wheel(-1, 2);
    expect(r.controls.speed).toBeCloseTo(0.45 * 1.1 * 1.1, 12);
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
    expect(r.controls.speed).toBe(0.45);
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

describe('FlyCameraControls: speedScale', () => {
  it('既定は 1。速度の係数で、speed・speedchange には影響しない', () => {
    const r = createRig();
    expect(r.controls.speedScale).toBe(1);
    const speeds: number[] = [];
    r.controls.addEventListener('speedchange', (e) => speeds.push(e.speed));
    r.controls.speedScale = 0.2;
    r.controls.speedScale = 5;
    expect(r.controls.speedScale).toBe(5);
    expect(r.controls.speed).toBe(0.45);
    expect(speeds).toHaveLength(0);
  });

  it('実際の移動量にだけ掛かる', () => {
    const a = createRig();
    const b = createRig();
    a.controls.timeConstant = 0;
    b.controls.timeConstant = 0;
    b.controls.speedScale = 0.5;
    keydown(a, 'KeyW');
    keydown(b, 'KeyW');
    frames(a.controls, 1);
    frames(b.controls, 1);
    expect(b.camera.position.length() / a.camera.position.length()).toBeCloseTo(0.5, 9);
    expect(b.controls.speed).toBe(0.45);
  });

  it('ユーザーのホイール操作で決めた speed は、係数を変えても上書きされない', () => {
    const r = createRig();
    r.el.emit('wheel', { deltaY: -100, deltaMode: 0, timeStamp: 0 });
    const userSpeed = r.controls.speed;
    expect(userSpeed).toBeCloseTo(0.495, 12);
    r.controls.speedScale = 0.3;
    r.controls.speedScale = 3;
    r.controls.speedScale = 1;
    expect(r.controls.speed).toBe(userSpeed);
  });

  it('maxSpeed を越える係数も効く（制限は speed にだけ働く）', () => {
    const r = createRig();
    r.controls.timeConstant = 0;
    r.controls.speed = 2;
    r.controls.speedScale = 2;
    expect(r.controls.speed).toBe(2);
    keydown(r, 'KeyW');
    frames(r.controls, 1);
    expect(r.camera.position.length()).toBeCloseTo(4, 9);
  });

  it('正の有限値以外は無視する。コンストラクタのオプションでも指定できる', () => {
    const r = createRig();
    for (const bad of [0, -2, NaN, Infinity]) {
      r.controls.speedScale = bad;
      expect(r.controls.speedScale).toBe(1);
    }
    const camera = new PerspectiveCamera();
    const win = new FakeTarget();
    const el = new FakeTarget();
    el.ownerDocument = { defaultView: win };
    const c = new FlyCameraControls(camera, el as unknown as HTMLElement, { speedScale: 0.25 });
    expect(c.speedScale).toBe(0.25);
  });
});

describe('FlyCameraControls: ホイールの払い（マウスとタッチパッド）', () => {
  let r: Rig;
  beforeEach(() => {
    r = createRig();
  });

  const send = (deltaY: number, timeStamp: number, extra: object = {}) =>
    r.el.emit('wheel', { deltaY, deltaMode: 0, timeStamp, ...extra });

  /**
   * タッチパッドの 2 本指スクロールを模した列。小さな移動量から立ち上がり（先頭の `ramp` 個）、
   * その後は一定の比率で減衰しながら続き（慣性つき）、合計が `total` ピクセルになる。
   * 実機のタッチパッドは小さな値から始まるので、先頭から大きな値は出さない。
   * 立ち上がりのあとの最速部分は 50 ピクセルを越えうる（マウスのノッチ相当の大きさになる）。
   */
  function touchpadFlick(total: number, startMs = 0, count = 100, decay = 0.97, intervalMs = 16, ramp = 10) {
    const raw = Array.from({ length: count }, (_, i) => decay ** i * Math.min(1, (i + 1) / ramp));
    const scale = total / raw.reduce((a, v) => a + v, 0);
    return raw.map((v, i) => ({ deltaY: v * scale, timeStamp: startMs + i * intervalMs }));
  }

  it('マウスホイール: deltaY=100 を 1 回で約 1.1 倍に減速し、-100 で約 1.1 倍に加速する', () => {
    send(100, 0);
    expect(r.controls.speed / 0.45).toBeCloseTo(1 / 1.1, 12);
    const r2 = createRig();
    r2.el.emit('wheel', { deltaY: -100, deltaMode: 0, timeStamp: 0 });
    expect(r2.controls.speed / 0.45).toBeCloseTo(1.1, 12);
  });

  it('マウスホイール: 間をあけた 1 ノッチずつは、毎回 1.1 倍ずつ効く', () => {
    for (let i = 0; i < 10; i++) send(-100, i * 400);
    expect(r.controls.speed / 0.45).toBeCloseTo(1.1 ** 10, 9);
  });

  it('マウスホイール: 素早く回した数ノッチ（上限以内）は、そのまま 1.1^n 倍', () => {
    for (let i = 0; i < 4; i++) send(-100, i * 30);
    expect(r.controls.speed / 0.45).toBeCloseTo(1.1 ** 4, 9);
  });

  it('タッチパッド: 合計 2000 ピクセルの 1 回の払いで、速度の変化が 2 倍以内（加速・減速とも）', () => {
    const flick = touchpadFlick(2000);
    expect(flick.reduce((a, e) => a + e.deltaY, 0)).toBeCloseTo(2000, 9);
    expect(Math.max(...flick.map((e) => e.deltaY))).toBeLessThan(100); // 1 イベントは小さい

    // 減速（下へ払う）
    for (const e of flick) send(e.deltaY, e.timeStamp);
    const slowRatio = r.controls.speed / 0.45;
    expect(slowRatio).toBeLessThanOrEqual(1);
    expect(1 / slowRatio).toBeLessThanOrEqual(2);
    expect(1 / slowRatio).toBeGreaterThan(1.5); // 払いはちゃんと効く

    // 加速（上へ払う）
    const up = createRig();
    for (const e of flick) up.el.emit('wheel', { deltaY: -e.deltaY, deltaMode: 0, timeStamp: e.timeStamp });
    const fastRatio = up.controls.speed / 0.45;
    expect(fastRatio).toBeLessThanOrEqual(2);
    expect(fastRatio).toBeGreaterThan(1.5);
  });

  it('タッチパッド: 合計 1000〜3000 ピクセルの払いはどれも 2 倍以内', () => {
    for (const total of [1000, 1500, 2000, 2500, 3000]) {
      const rig = createRig();
      for (const e of touchpadFlick(total)) rig.el.emit('wheel', { deltaY: -e.deltaY, deltaMode: 0, timeStamp: e.timeStamp });
      const ratio = rig.controls.speed / 0.45;
      expect(ratio, `${total}px`).toBeLessThanOrEqual(2);
      expect(ratio, `${total}px`).toBeGreaterThan(1.4);
    }
  });

  it('タッチパッド: 慣性が長く続いても、払いの途中で変化が 2 倍を越えない', () => {
    // 5 秒続く慣性（間隔 16 ミリ秒）。
    const rig = createRig();
    let max = 0;
    for (let i = 0; i < 312; i++) {
      rig.el.emit('wheel', { deltaY: -12, deltaMode: 0, timeStamp: i * 16 });
      max = Math.max(max, rig.controls.speed / 0.45);
    }
    expect(max).toBeLessThanOrEqual(2);
  });

  it('タッチパッド: 間をあけた別の払いは、それぞれ別に 2 倍以内で効く', () => {
    for (const e of touchpadFlick(2000, 0)) send(-e.deltaY, e.timeStamp);
    const afterFirst = r.controls.speed;
    for (const e of touchpadFlick(2000, 5000)) send(-e.deltaY, e.timeStamp);
    const secondRatio = r.controls.speed / afterFirst;
    expect(secondRatio).toBeLessThanOrEqual(2);
    expect(secondRatio).toBeGreaterThan(1.5);
  });

  it('払いが上限に達したあとの逆向きの入力は、すぐ反映される', () => {
    for (const e of touchpadFlick(2000)) send(-e.deltaY, e.timeStamp);
    const saturated = r.controls.speed;
    send(100, 100 * 16 + 20);
    expect(r.controls.speed / saturated).toBeCloseTo(1 / 1.1, 12);
  });

  it('ピンチ（ctrlKey つき）は速度を変えず、speedchange も出さず、ページのズームは止める', () => {
    let count = 0;
    r.controls.addEventListener('speedchange', () => count++);
    const ev = send(-100, 0, { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    for (const e of touchpadFlick(2000)) send(-e.deltaY, e.timeStamp + 1000, { ctrlKey: true });
    expect(r.controls.speed).toBe(0.45);
    expect(count).toBe(0);
    // ピンチは払いの累積にも数えない
    send(-100, 5000);
    expect(r.controls.speed / 0.45).toBeCloseTo(1.1, 12);
  });

  it('マウスホイール: ピクセル単位の ±100 を 50 ミリ秒間隔で 10 回続けても、制限されず 1.1^10 倍になる', () => {
    for (let i = 0; i < 10; i++) send(-100, i * 50);
    expect(r.controls.speed / 0.45).toBeCloseTo(1.1 ** 10, 9);

    const down = createRig();
    for (let i = 0; i < 10; i++) down.el.emit('wheel', { deltaY: 100, deltaMode: 0, timeStamp: i * 50 });
    expect(down.controls.speed / 0.45).toBeCloseTo(1 / 1.1 ** 10, 9);
  });

  it('マウスホイール: 行単位（deltaMode=1）の ±3 を連続で 10 回送っても、制限されず 1.1^10 倍になる', () => {
    for (let i = 0; i < 10; i++) r.el.emit('wheel', { deltaY: -3, deltaMode: 1, timeStamp: i * 50 });
    expect(r.controls.speed / 0.45).toBeCloseTo(1.1 ** 10, 9);

    const down = createRig();
    for (let i = 0; i < 10; i++) down.el.emit('wheel', { deltaY: 3, deltaMode: 1, timeStamp: i * 50 });
    expect(down.controls.speed / 0.45).toBeCloseTo(1 / 1.1 ** 10, 9);
  });

  it('マウスホイール: ページ単位（deltaMode=2）の ±1 も、連続で送って制限されない', () => {
    for (let i = 0; i < 10; i++) r.el.emit('wheel', { deltaY: -1, deltaMode: 2, timeStamp: i * 50 });
    expect(r.controls.speed / 0.45).toBeCloseTo(1.1 ** 10, 9);
  });

  it('マウスホイール: 1 イベントあたり 3 ノッチの上限は、ノッチ扱いのイベントにも掛かる', () => {
    send(-1000, 0);
    expect(r.controls.speed / 0.45).toBeCloseTo(1.1 ** 3, 12);
    const rig = createRig();
    rig.el.emit('wheel', { deltaY: -30, deltaMode: 1, timeStamp: 0 });
    expect(rig.controls.speed / 0.45).toBeCloseTo(1.1 ** 3, 12);
  });

  it('タッチパッド: 50 ピクセル未満の小さな移動量だけの列（合計約 2000 ピクセル）は、これまでどおり 2 倍以内', () => {
    const flick = touchpadFlick(2000, 0, 200, 0.985);
    expect(flick.reduce((a, e) => a + e.deltaY, 0)).toBeCloseTo(2000, 9);
    expect(Math.max(...flick.map((e) => e.deltaY))).toBeLessThan(50);

    for (const e of flick) send(-e.deltaY, e.timeStamp);
    const fast = r.controls.speed / 0.45;
    expect(fast).toBeLessThanOrEqual(2);
    expect(fast).toBeGreaterThan(1.9); // 上限（1.1^7）まで効く

    const down = createRig();
    for (const e of flick) down.el.emit('wheel', { deltaY: e.deltaY, deltaMode: 0, timeStamp: e.timeStamp });
    expect(0.45 / down.controls.speed).toBeLessThanOrEqual(2);
  });

  it('タッチパッド: 立ち上がりのあとの最速部分が 50 ピクセルを越えても、払い全体は 2 倍以内', () => {
    const flick = touchpadFlick(3000);
    expect(Math.max(...flick.map((e) => e.deltaY))).toBeGreaterThan(50);
    for (const e of flick) send(-e.deltaY, e.timeStamp);
    expect(r.controls.speed / 0.45).toBeLessThanOrEqual(2);
  });

  it('マウスのノッチと小さな移動量のイベントが混在すると、払い全体（先に反映したノッチを含む）で 7 ノッチに収まる', () => {
    // 払いの頭にあるノッチ 3 つは、小さな移動量がまだ来ていないので、そのまま 3 ノッチ反映される。
    for (let i = 0; i < 3; i++) send(-100, i * 50);
    expect(r.controls.speed / 0.45).toBeCloseTo(1.1 ** 3, 9);
    // そのあと小さな移動量が続くと払いはタッチパッドと判明し、先に反映した 3 ノッチも数えて、全体で 7 ノッチで止まる。
    // （以前は先に反映した分を数えず、3 + 7 = 10 ノッチまで効いていた。）
    for (let i = 0; i < 100; i++) send(i % 5 === 4 ? -100 : -20, 116 + i * 16);
    expect(r.controls.speed / 0.45).toBeCloseTo(1.1 ** 7, 9);
    // 間をあけて払いが変われば、ノッチはまた制限なく効く。
    for (let i = 0; i < 5; i++) send(-100, 5000 + i * 50);
    expect(r.controls.speed / 0.45).toBeCloseTo(1.1 ** (7 + 5), 9);
  });

  it('タッチパッド: 50 ピクセル以上のイベント数個で始まり、小さなイベントが続く払いは、速度の変化が 2 倍以内（加速・減速とも）', () => {
    for (const lead of [1, 2, 3, 4]) {
      for (const dir of [-1, 1]) {
        const rig = createRig();
        let t = 0;
        // 立ち上がりに 150 ピクセル（1.5 ノッチ）のイベントが lead 個。ここまでは小さなイベントが来ていないので、そのまま反映される。
        for (let i = 0; i < lead; i++, t += 16) rig.el.emit('wheel', { deltaY: dir * 150, deltaMode: 0, timeStamp: t });
        const afterLead = rig.controls.speed;
        expect(afterLead / 0.45, `lead=${lead}`).toBeCloseTo(dir < 0 ? 1.1 ** (1.5 * lead) : 1.1 ** (-1.5 * lead), 9);
        // 小さなイベント（合計 2000 ピクセル）が慣性つきで続く。払い全体で 7 ノッチ（1.1^7 ≈ 1.95 倍）に収まる。
        for (let i = 0; i < 150; i++, t += 16) rig.el.emit('wheel', { deltaY: dir * 20, deltaMode: 0, timeStamp: t });
        const ratio = dir < 0 ? rig.controls.speed / 0.45 : 0.45 / rig.controls.speed;
        expect(ratio, `lead=${lead} dir=${dir}`).toBeCloseTo(1.1 ** 7, 9);
        expect(ratio, `lead=${lead} dir=${dir}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('タッチパッド: 先頭の大きなイベントだけで上限を越えた払いは、越えた分を戻さず、そのあとの小さなイベントを反映しない', () => {
    // 300 ピクセル（3 ノッチ）を 3 個 = 9 ノッチ。タッチパッドと判明する前なのでそのまま反映される。
    for (let i = 0; i < 3; i++) send(-300, i * 16);
    const afterLead = r.controls.speed;
    expect(afterLead / 0.45).toBeCloseTo(1.1 ** 9, 9);
    // 小さなイベントが続いても、同じ向きには反映しない。
    for (let i = 0; i < 100; i++) send(-20, 48 + i * 16);
    expect(r.controls.speed).toBe(afterLead);
    // 逆向きの入力はすぐ反映される。
    send(100, 48 + 100 * 16);
    expect(r.controls.speed / afterLead).toBeCloseTo(1 / 1.1, 12);
  });

  it('マウスのノッチと小さな移動量が交互に届いても、小さな移動量の側だけで 7 ノッチを越えない', () => {
    // 小さな移動量（0.2 ノッチ）だけで 7 ノッチ分を使い切ったあとは、ノッチを混ぜても増えない。
    for (let i = 0; i < 100; i++) send(-20, i * 16);
    const saturated = r.controls.speed;
    expect(saturated / 0.45).toBeCloseTo(1.1 ** 7, 9);
    send(-100, 100 * 16);
    send(-20, 101 * 16);
    expect(r.controls.speed).toBe(saturated);
  });

  it('横方向だけのスクロール（deltaY=0）は、速度を変えず、払いの区切りにも影響しない', () => {
    // 小さな移動量で上限（7 ノッチ）まで使い切る。最後のイベントは 99 * 16 = 1584 ミリ秒。
    for (let i = 0; i < 100; i++) send(-20, i * 16);
    const saturated = r.controls.speed;
    expect(saturated / 0.45).toBeCloseTo(1.1 ** 7, 9);

    // 150 ミリ秒未満の間隔で横スクロールが続く。払いが続いているなら、最後の縦スクロールから 150 ミリ秒を越える。
    let count = 0;
    r.controls.addEventListener('speedchange', () => count++);
    const sideways = [1584 + 100, 1584 + 200];
    for (const t of sideways) {
      const ev = r.el.emit('wheel', { deltaY: 0, deltaX: 80, deltaMode: 0, timeStamp: t });
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(r.controls.speed).toBe(saturated);
    expect(count).toBe(0);

    // 最後の縦スクロールから 260 ミリ秒あいている。横スクロールが払いを延ばしていなければ、新しい払いとして効く。
    send(-20, 1584 + 260);
    expect(r.controls.speed / saturated).toBeCloseTo(1.1 ** 0.2, 9);
  });

  it('横方向のスクロールが間に挟まっても、続いている払いは切れず、累積も保たれる', () => {
    for (let i = 0; i < 100; i++) {
      send(-20, i * 16);
      r.el.emit('wheel', { deltaY: 0, deltaX: 40, deltaMode: 0, timeStamp: i * 16 + 8 });
    }
    expect(r.controls.speed / 0.45).toBeCloseTo(1.1 ** 7, 9);
  });

  it('ホイール操作は飛行を中断しない（払いの制限を入れても変わらない）', () => {
    r.controls.flyTo(new Vector3(0, 0, -1), { distance: 0.1 });
    for (const e of touchpadFlick(2000)) send(-e.deltaY, e.timeStamp);
    expect(r.controls.isFlying).toBe(true);
  });
});

describe('FlyCameraControls: 不正な dt', () => {
  it('NaN・負・無限大の dt は、カメラも状態も変えずに false を返す', () => {
    for (const bad of [NaN, -1 / 60, Infinity, -Infinity]) {
      const r = createRig();
      keydown(r, 'KeyW');
      frames(r.controls, 0.3);
      const pos = r.camera.position.clone();
      const dir = viewDirection(r.camera);
      let changes = 0;
      r.controls.addEventListener('change', () => changes++);
      expect(r.controls.update(bad), String(bad)).toBe(false);
      expect(changes).toBe(0);
      expect(r.camera.position.distanceTo(pos)).toBe(0);
      expect(viewDirection(r.camera).distanceTo(dir)).toBe(0);
      expect(Number.isFinite(r.camera.position.length())).toBe(true);
    }
  });

  it('不正な dt のあとも通常どおり動く', () => {
    const a = createRig();
    const b = createRig();
    keydown(a, 'KeyW');
    keydown(b, 'KeyW');
    frames(a.controls, 0.5);
    frames(b.controls, 0.25);
    b.controls.update(NaN);
    b.controls.update(-1);
    frames(b.controls, 0.25);
    expect(b.camera.position.distanceTo(a.camera.position)).toBeLessThan(1e-12);
  });

  it('ドラッグによる未反映の回転は、不正な dt では消えず、次の有効な update で反映される', () => {
    const r = createRig();
    r.el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    r.el.emit('pointermove', { pointerId: 1, clientX: 100, clientY: 0 });
    expect(r.controls.update(NaN)).toBe(false);
    expect(viewDirection(r.camera).x).toBeCloseTo(0, 12);
    expect(r.controls.update(1 / 60)).toBe(true);
    expect(viewDirection(r.camera).x).toBeGreaterThan(0.1);
  });

  it('dt = 0 は有効', () => {
    const r = createRig();
    r.el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    r.el.emit('pointermove', { pointerId: 1, clientX: 100, clientY: 0 });
    expect(r.controls.update(0)).toBe(true);
  });
});

describe('FlyCameraControls: Meta キー', () => {
  /** 慣性が収まってから、位置がもう動かないことを確かめる。 */
  function expectStopped(r: Rig): void {
    frames(r.controls, 3);
    const p = r.camera.position.clone();
    frames(r.controls, 1);
    expect(r.camera.position.distanceTo(p)).toBe(0);
  }

  it('移動キーを押したまま Meta の keydown が来たら、押下状態をすべて消す', () => {
    const r = createRig();
    keydown(r, 'KeyW');
    keydown(r, 'KeyD');
    keydown(r, 'KeyE');
    keydown(r, 'ShiftLeft', { shiftKey: true });
    frames(r.controls, 0.2);
    keydown(r, 'MetaLeft', { metaKey: true });
    // Cmd を押している間に離したキーの keyup は届かない
    expectStopped(r);
  });

  it('Meta の keyup でも消す（Meta の keydown を取り逃がしていた場合）', () => {
    for (const code of ['MetaLeft', 'MetaRight']) {
      const r = createRig();
      keydown(r, 'KeyW');
      keydown(r, 'KeyA');
      frames(r.controls, 0.2);
      keyup(r, code);
      expectStopped(r);
    }
  });

  it('code が空でも key が "Meta" なら Meta として扱う', () => {
    const r = createRig();
    keydown(r, 'KeyW');
    r.win.emit('keydown', { code: '', key: 'Meta', target: null, metaKey: true });
    expectStopped(r);
  });

  it('Meta を離したあと、移動キーを押し直せばまた動く', () => {
    const r = createRig();
    keydown(r, 'KeyW');
    keydown(r, 'MetaLeft', { metaKey: true });
    keyup(r, 'MetaLeft');
    expectStopped(r);
    const p = r.camera.position.clone();
    keydown(r, 'KeyW');
    frames(r.controls, 0.5);
    expect(r.camera.position.distanceTo(p)).toBeGreaterThan(0.01);
  });

  it('Meta 以外の修飾キー（Ctrl・Alt）の keyup では消さない', () => {
    const r = createRig();
    keydown(r, 'KeyW');
    keyup(r, 'ControlLeft');
    keyup(r, 'AltLeft');
    frames(r.controls, 0.5);
    expect(r.camera.position.z).toBeLessThan(-0.01);
  });
});

describe('FlyCameraControls: シャドウDOM内の入力欄', () => {
  const host = { tagName: 'MY-FORM' };
  const shadowRoot = {};

  /** シャドウDOM 内で発生したキーイベント: target はホストに付け替えられ、composedPath() の先頭が実際の発生元。 */
  const inShadow = (inner: object) => ({ target: host, composedPath: () => [inner, shadowRoot, host] });

  it('シャドウDOM内の input・textarea・contenteditable では反応しない', () => {
    const inners = [
      { tagName: 'INPUT' },
      { tagName: 'TEXTAREA' },
      { tagName: 'DIV', isContentEditable: true },
      { tagName: 'DIV', getAttribute: (n: string) => (n === 'contenteditable' ? 'true' : null) },
    ];
    for (const inner of inners) {
      const r = createRig();
      const ev = keydown(r, 'KeyW', inShadow(inner));
      expect(ev.defaultPrevented, JSON.stringify(inner)).toBe(false);
      frames(r.controls, 0.2);
      expect(r.camera.position.length(), JSON.stringify(inner)).toBe(0);
    }
  });

  it('シャドウDOM内の入力欄以外（canvas など）では反応する', () => {
    const r = createRig();
    const ev = keydown(r, 'KeyW', inShadow({ tagName: 'CANVAS' }));
    expect(ev.defaultPrevented).toBe(true);
    frames(r.controls, 0.2);
    expect(r.camera.position.z).toBeLessThan(0);
  });

  it('composedPath() の先頭を判定に使う（target がホストでも入力欄を見つける）', () => {
    const r = createRig();
    expect(keydown(r, 'KeyW', { target: { tagName: 'DIV' }, composedPath: () => [{ tagName: 'INPUT' }] }).defaultPrevented).toBe(false);
    expect(r.camera.position.length()).toBe(0);
  });

  it('composedPath が空・無いときは target で判定する', () => {
    const r = createRig();
    expect(keydown(r, 'KeyW', { target: { tagName: 'INPUT' }, composedPath: () => [] }).defaultPrevented).toBe(false);
    expect(keydown(r, 'KeyW', { target: { tagName: 'INPUT' } }).defaultPrevented).toBe(false);
    frames(r.controls, 0.2);
    expect(r.camera.position.length()).toBe(0);
  });
});

describe('FlyCameraControls: 回転の慣性', () => {
  let r: Rig;
  let clock = 0;
  beforeEach(() => {
    r = createRig();
    clock = 1000;
  });

  const down = (x = 100, y = 100, extra: object = {}) =>
    r.el.emit('pointerdown', { button: 0, pointerId: 1, clientX: x, clientY: y, timeStamp: clock, ...extra });
  const move = (x: number, y: number) => r.el.emit('pointermove', { pointerId: 1, clientX: x, clientY: y, timeStamp: clock });
  const up = () => r.el.emit('pointerup', { pointerId: 1, timeStamp: clock });

  /** 16 ミリ秒ごとに `dxPerFrame` ピクセル（x）・`dyPerFrame`（y）動かして、`frameCount` フレーム分ドラッグする。 */
  function drag(dxPerFrame: number, frameCount = 12, dyPerFrame = 0, startX = 100, startY = 100) {
    down(startX, startY);
    let x = startX;
    let y = startY;
    for (let i = 0; i < frameCount; i++) {
      clock += 16;
      x += dxPerFrame;
      y += dyPerFrame;
      move(x, y);
    }
  }

  const yawOf = (camera: PerspectiveCamera) => {
    const d = viewDirection(camera);
    return Math.atan2(-d.x, -d.z);
  };
  const pitchOf = (camera: PerspectiveCamera) => Math.asin(viewDirection(camera).y);

  it('動かしながら離すと、離したあとも同じ向きへ回り続け、やがて止まる', () => {
    drag(16); // 1000 px/s
    r.controls.update(1 / 60);
    const atRelease = yawOf(r.camera);
    up();
    expect(r.controls.isRotatingByInertia).toBe(true);
    let prev = atRelease;
    let steps = 0;
    while (r.controls.update(1 / 60) && steps < 1000) {
      const yaw = yawOf(r.camera);
      expect(yaw).toBeLessThan(prev + 1e-12); // 右へ回し続ける（ヨーは減る）
      prev = yaw;
      steps++;
    }
    expect(steps).toBeGreaterThan(30);
    expect(r.controls.isRotatingByInertia).toBe(false);
    // 離す前の速さ 2.5 rad/s（= 1000 px/s × 0.0025）→ 総回転量は約 2.5 × 0.3 = 0.75 rad
    expect(atRelease - yawOf(r.camera)).toBeGreaterThan(0.6);
    expect(atRelease - yawOf(r.camera)).toBeLessThan(0.8);
    expect(r.controls.update(1 / 60)).toBe(false);
  });

  it('総回転量は、フレームレート（1/60 秒刻みと 1/30 秒刻み）によらず同じ', () => {
    const run = (dt: number) => {
      const rig = createRig();
      let t = 1000;
      const emit = (type: string, extra: object) => rig.el.emit(type, { pointerId: 1, timeStamp: t, ...extra });
      emit('pointerdown', { button: 0, clientX: 100, clientY: 100 });
      for (let i = 0; i < 12; i++) {
        t += 16;
        emit('pointermove', { clientX: 100 + 12 * (i + 1), clientY: 100 + 6 * (i + 1) });
      }
      emit('pointerup', {});
      const before = viewDirection(rig.camera).clone();
      for (let i = 0; i < Math.round(1.5 / dt); i++) rig.controls.update(dt);
      return { before, after: viewDirection(rig.camera).clone() };
    };
    const a = run(1 / 60);
    const b = run(1 / 30);
    expect(a.after.distanceTo(a.before)).toBeGreaterThan(0.1);
    expect(b.after.distanceTo(a.after)).toBeLessThan(1e-9);
  });

  it('ポインタを止めてから離すと、慣性は付かない', () => {
    drag(16);
    r.controls.update(1 / 60);
    clock += 200; // 動きを止めたまま
    up();
    expect(r.controls.isRotatingByInertia).toBe(false);
    const dir = viewDirection(r.camera).clone();
    expect(r.controls.update(1 / 60)).toBe(false);
    expect(viewDirection(r.camera).distanceTo(dir)).toBe(0);
  });

  it('動かさずに離したクリックでも、数ピクセルの揺れだけでも、慣性は付かない', () => {
    down();
    clock += 30;
    up();
    expect(r.controls.isRotatingByInertia).toBe(false);
    down();
    clock += 8;
    move(102, 101);
    clock += 8;
    move(103, 101);
    up();
    expect(r.controls.isRotatingByInertia).toBe(false);
    r.controls.update(1 / 60); // ドラッグ中の回転（わずかな揺れ）を反映する
    expect(r.controls.update(1 / 60)).toBe(false);
  });

  it('ドラッグ中は、ポインタの動きにそのまま追従する（慣性の遅れを入れない）', () => {
    drag(16, 1);
    expect(r.controls.isRotatingByInertia).toBe(false);
    r.controls.update(1 / 60);
    expect(yawOf(r.camera)).toBeCloseTo(-16 * 0.0025, 9);
  });

  it('慣性の間は update が true を返し、change が発火する。止まったあとは発火しない', () => {
    drag(16);
    r.controls.update(1 / 60);
    up();
    let changes = 0;
    r.controls.addEventListener('change', () => changes++);
    for (let i = 0; i < 20; i++) expect(r.controls.update(1 / 60)).toBe(true);
    expect(changes).toBe(20);
    for (let i = 0; i < 200; i++) r.controls.update(1 / 60);
    const after = changes;
    expect(r.controls.update(1 / 60)).toBe(false);
    expect(changes).toBe(after);
  });

  it('最初の角速度に上限がある（極端な速さで払っても、回りすぎない）', () => {
    drag(400, 6); // 25000 px/s
    r.controls.update(1 / 60);
    const atRelease = yawOf(r.camera);
    up();
    for (let i = 0; i < 600; i++) r.controls.update(1 / 60);
    const turned = Math.abs(yawOf(r.camera) - atRelease);
    expect(turned).toBeLessThan(4 * 0.3 + 1e-6);
    expect(turned).toBeGreaterThan(4 * 0.3 * 0.95);
  });

  it('ピッチは慣性の間も ±89° で止まり、止まったあとは回り続けない', () => {
    drag(0, 12, -40); // 上へ払う（上を向く）
    r.controls.update(1 / 60);
    up();
    for (let i = 0; i < 600; i++) r.controls.update(1 / 60);
    expect(pitchOf(r.camera)).toBeCloseTo((89 * Math.PI) / 180, 6);
    expect(r.controls.isRotatingByInertia).toBe(false);
    expect(r.controls.update(1 / 60)).toBe(false);
    // 下へ払う
    drag(0, 12, 40, 100, 100);
    up();
    for (let i = 0; i < 600; i++) r.controls.update(1 / 60);
    expect(pitchOf(r.camera)).toBeGreaterThanOrEqual(-(89 * Math.PI) / 180 - 1e-9);
  });

  it('ポインタを押すと慣性が止まる', () => {
    drag(16);
    up();
    for (let i = 0; i < 5; i++) r.controls.update(1 / 60);
    expect(r.controls.isRotatingByInertia).toBe(true);
    r.el.emit('pointerdown', { button: 0, pointerId: 2, clientX: 5, clientY: 5, timeStamp: clock });
    expect(r.controls.isRotatingByInertia).toBe(false);
    const dir = viewDirection(r.camera).clone();
    expect(r.controls.update(1 / 60)).toBe(false);
    expect(viewDirection(r.camera).distanceTo(dir)).toBe(0);
  });

  it('回っているときの押下は、慣性を止めた押下として答える（押下のリスナーの前でも後でも）', () => {
    // コントロールより先に登録したリスナー（止める前に聞く）と、後に登録したリスナー（止めたあとに聞く）
    const seenBefore: boolean[] = [];
    const camera = new PerspectiveCamera(60, 1, 0.001, 10);
    const win = new FakeTarget();
    const el = new FakeTarget();
    el.ownerDocument = { defaultView: win };
    let controls!: FlyCameraControls;
    el.addEventListener('pointerdown', ((e: object) => { seenBefore.push(controls.pressStopsInertia(e as Event)); }) as Handler);
    controls = new FlyCameraControls(camera, el as unknown as HTMLElement);
    const seenAfter: boolean[] = [];
    el.addEventListener('pointerdown', ((e: object) => { seenAfter.push(controls.pressStopsInertia(e as Event)); }) as Handler);

    const flick = () => {
      let t = 1000;
      el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: t });
      for (let i = 1; i <= 12; i++) {
        t += 16;
        el.emit('pointermove', { pointerId: 1, clientX: 100 + 16 * i, clientY: 100, timeStamp: t });
      }
      el.emit('pointerup', { pointerId: 1, timeStamp: t });
    };
    flick();
    seenBefore.length = 0;
    seenAfter.length = 0;
    expect(controls.isRotatingByInertia).toBe(true);
    const press = { button: 0, pointerId: 2, clientX: 5, clientY: 5, timeStamp: 3000 };
    const ev = el.emit('pointerdown', press);
    expect(controls.isRotatingByInertia).toBe(false);
    expect(seenBefore).toEqual([true]);
    expect(seenAfter).toEqual([true]);
    expect(controls.pressStopsInertia(ev as unknown as Event)).toBe(true);

    // 回っていないときの押下は、止めた押下ではない
    seenBefore.length = 0;
    seenAfter.length = 0;
    const ev2 = el.emit('pointerdown', { button: 0, pointerId: 3, clientX: 5, clientY: 5, timeStamp: 3100 });
    expect(seenBefore).toEqual([false]);
    expect(seenAfter).toEqual([false]);
    expect(controls.pressStopsInertia(ev2 as unknown as Event)).toBe(false);
    expect(controls.pressStopsInertia(ev as unknown as Event)).toBe(false); // 前の押下の記憶は、次の押下で入れ替わる
  });

  it('無効のときは、押下が来ても止めた押下にならない', () => {
    drag(16);
    up();
    r.controls.enabled = false;
    const ev = r.el.emit('pointerdown', { button: 0, pointerId: 4, clientX: 0, clientY: 0, timeStamp: clock });
    expect(r.controls.pressStopsInertia(ev as unknown as Event)).toBe(false);
  });

  it('離した位置が最後の pointermove と違っても、その動きが慣性の速さに入る', () => {
    const slowThenFling = () => {
      const rr = createRig();
      let t = 1000;
      rr.el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: t });
      t += 100;
      rr.el.emit('pointermove', { pointerId: 1, clientX: 110, clientY: 100, timeStamp: t });
      return { rr, t };
    };
    const a = slowThenFling();
    a.rr.el.emit('pointerup', { pointerId: 1, clientX: 110, clientY: 100, timeStamp: a.t + 16 });
    const b = slowThenFling();
    b.rr.el.emit('pointerup', { pointerId: 1, clientX: 190, clientY: 100, timeStamp: b.t + 16 });
    expect(a.rr.controls.isRotatingByInertia).toBe(true);
    expect(b.rr.controls.isRotatingByInertia).toBe(true);
    const yawAfter = (c: Rig) => {
      const before = yawOf(c.camera);
      frames(c.controls, 3);
      return before - yawOf(c.camera);
    };
    expect(yawAfter(b.rr)).toBeGreaterThan(yawAfter(a.rr) * 3);
  });

  it('左以外のボタンの押下でも止まる', () => {
    drag(16);
    up();
    r.el.emit('pointerdown', { button: 2, pointerId: 3, clientX: 0, clientY: 0, timeStamp: clock });
    expect(r.controls.isRotatingByInertia).toBe(false);
  });

  it('flyTo・setPose・無効化・フォーカスの喪失で止まる', () => {
    const start = () => {
      drag(16);
      up();
      r.controls.update(1 / 60);
      expect(r.controls.isRotatingByInertia).toBe(true);
    };
    start();
    r.controls.flyTo(new Vector3(0, 0, -5));
    expect(r.controls.isRotatingByInertia).toBe(false);
    r.controls.cancelFlyTo();

    start();
    r.controls.setPose(new Vector3(1, 0, 0), new Vector3(1, 0, -1));
    expect(r.controls.isRotatingByInertia).toBe(false);

    start();
    r.win.emit('blur');
    expect(r.controls.isRotatingByInertia).toBe(false);

    start();
    r.controls.enabled = false;
    expect(r.controls.isRotatingByInertia).toBe(false);
    r.controls.enabled = true;
    expect(r.controls.update(1 / 60)).toBe(false); // 再有効化しても回り出さない
  });

  it('stopRotationInertia で止まる', () => {
    drag(16);
    up();
    r.controls.stopRotationInertia();
    expect(r.controls.isRotatingByInertia).toBe(false);
  });

  it('移動キー（W）では止まらず、回りながら進む', () => {
    drag(16);
    r.controls.update(1 / 60);
    up();
    const yaw0 = yawOf(r.camera);
    keydown(r, 'KeyW');
    for (let i = 0; i < 10; i++) r.controls.update(1 / 60);
    expect(r.controls.isRotatingByInertia).toBe(true);
    expect(yawOf(r.camera)).toBeLessThan(yaw0 - 0.05); // 回り続けている
    expect(r.camera.position.length()).toBeGreaterThan(0.01); // 進んでいる
    // 進む向きは、回った新しい視線の向き（横へ曲がる）
    expect(Math.abs(r.camera.position.x)).toBeGreaterThan(0.001);
    keyup(r, 'KeyW');
  });

  it('時定数 0 で無効（速く払って離しても慣性が付かない）。オプションでも指定できる', () => {
    r.controls.rotationTimeConstant = 0;
    drag(16);
    up();
    expect(r.controls.isRotatingByInertia).toBe(false);

    const off = new FlyCameraControls(new PerspectiveCamera(), r.el as unknown as HTMLElement, { rotationInertia: { timeConstant: 0 } });
    expect(off.rotationTimeConstant).toBe(0);
    off.dispose();
  });

  it('時定数は既定 0.3 秒で、調整できる', () => {
    expect(r.controls.rotationTimeConstant).toBe(0.3);
    const total = (tau: number) => {
      const rig = createRig();
      rig.controls.rotationTimeConstant = tau;
      let t = 1000;
      rig.el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: t });
      for (let i = 0; i < 12; i++) {
        t += 16;
        rig.el.emit('pointermove', { pointerId: 1, clientX: 100 + 8 * (i + 1), clientY: 100, timeStamp: t });
      }
      rig.el.emit('pointerup', { pointerId: 1, timeStamp: t });
      const before = yawOf(rig.camera);
      for (let i = 0; i < 600; i++) rig.controls.update(1 / 60);
      return Math.abs(before - yawOf(rig.camera));
    };
    expect(total(0.6)).toBeGreaterThan(total(0.3) * 1.5);
  });

  it('「動きを減らす」設定のときは、既定で慣性が無効。時定数を指定すれば使える', () => {
    const win = new FakeTarget() as FakeTarget & { matchMedia?: (q: string) => { matches: boolean } };
    win.matchMedia = (q: string) => ({ matches: q.includes('prefers-reduced-motion: reduce') });
    const el = new FakeTarget();
    el.ownerDocument = { defaultView: win };
    const controls = new FlyCameraControls(new PerspectiveCamera(), el as unknown as HTMLElement);
    expect(controls.rotationTimeConstant).toBe(0);
    let t = 1000;
    el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0, timeStamp: t });
    for (let i = 0; i < 12; i++) {
      t += 16;
      el.emit('pointermove', { pointerId: 1, clientX: 16 * (i + 1), clientY: 0, timeStamp: t });
    }
    el.emit('pointerup', { pointerId: 1, timeStamp: t });
    expect(controls.isRotatingByInertia).toBe(false);
    controls.rotationTimeConstant = 0.3;
    expect(controls.rotationTimeConstant).toBe(0.3);
    controls.rotationTimeConstant = null;
    expect(controls.rotationTimeConstant).toBe(0);
    controls.dispose();
  });

  it('pointercancel・lostpointercapture では慣性を付けない', () => {
    for (const type of ['pointercancel', 'lostpointercapture']) {
      drag(16);
      r.el.emit(type, { pointerId: 1, timeStamp: clock });
      expect(r.controls.isRotatingByInertia).toBe(false);
      // 続けて pointerup が来ても付かない
      up();
      expect(r.controls.isRotatingByInertia).toBe(false);
    }
  });

  it('dispose のあと update は何もせず、慣性も残らない', () => {
    drag(16);
    up();
    r.controls.dispose();
    expect(r.controls.isRotatingByInertia).toBe(false);
    expect(r.controls.update(1 / 60)).toBe(false);
  });
});
