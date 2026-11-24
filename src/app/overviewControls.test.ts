import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { dollyPosition, orbitPose, OverviewControls, overviewGestureLimitNotches, OVERVIEW_MAX_PITCH } from './overviewControls';

function lookingAt(position: Vector3, target: Vector3): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(position, target, new Vector3(0, 1, 0)));
}
const forwardOf = (q: Quaternion) => new Vector3(0, 0, -1).applyQuaternion(q);

describe('orbitPose', () => {
  const pivot = new Vector3(0.1, -0.2, 0.3);

  it('中心までの距離を保ち、中心の画面上の位置（カメラ座標）も変えない', () => {
    const position = new Vector3(1.2, 0.7, 2.0);
    const quaternion = lookingAt(position, new Vector3(0.5, 0.1, 0)); // 中心を向いていない
    const before = pivot.clone().applyMatrix4(new Matrix4().compose(position, quaternion, new Vector3(1, 1, 1)).invert());
    const next = orbitPose({ position, quaternion }, pivot, 0.7, -0.3);
    const after = pivot.clone().applyMatrix4(new Matrix4().compose(next.position, next.quaternion, new Vector3(1, 1, 1)).invert());
    expect(next.position.distanceTo(pivot)).toBeCloseTo(position.distanceTo(pivot), 9);
    expect(after.distanceTo(before)).toBeLessThan(1e-9);
  });

  it('入力の姿勢を書き換えない', () => {
    const position = new Vector3(0, 0, 2);
    const quaternion = lookingAt(position, new Vector3());
    orbitPose({ position, quaternion }, new Vector3(), 1, 1);
    expect(position.toArray()).toEqual([0, 0, 2]);
  });

  it('横傾き（roll）を生まない: 右軸は常に水平', () => {
    const position = new Vector3(1, 0.5, 1.5);
    let pose = { position, quaternion: lookingAt(position, new Vector3(0.4, 0.2, 0)) };
    for (const [dy, dp] of [[0.4, 0.2], [-1.1, 0.5], [2.0, -0.9]] as const) {
      pose = orbitPose(pose, pivot, dy, dp);
      expect(new Vector3(1, 0, 0).applyQuaternion(pose.quaternion).y).toBeCloseTo(0, 9);
    }
  });

  it('dYaw が負（右へドラッグ）のとき、カメラは中心の左側へ回り込む', () => {
    const position = new Vector3(0, 0, 2);
    const quaternion = lookingAt(position, new Vector3());
    const next = orbitPose({ position, quaternion }, new Vector3(), -0.3, 0);
    expect(next.position.x).toBeLessThan(0);
    expect(forwardOf(next.quaternion).x).toBeGreaterThan(0); // 中心の方（右）へ向き直る
  });

  it('dPitch が負（下へドラッグ）のとき、カメラは上がって見下ろす', () => {
    const position = new Vector3(0, 0, 2);
    const quaternion = lookingAt(position, new Vector3());
    const next = orbitPose({ position, quaternion }, new Vector3(), 0, -0.3);
    expect(next.position.y).toBeGreaterThan(0);
    expect(forwardOf(next.quaternion).y).toBeLessThan(0);
  });

  it('仰角は ±89° を超えない', () => {
    const position = new Vector3(0, 0, 2);
    let pose = { position, quaternion: lookingAt(position, new Vector3()) };
    pose = orbitPose(pose, new Vector3(), 0, 10);
    expect(Math.asin(forwardOf(pose.quaternion).y)).toBeCloseTo(OVERVIEW_MAX_PITCH, 9);
    pose = orbitPose(pose, new Vector3(), 0, -20);
    expect(Math.asin(forwardOf(pose.quaternion).y)).toBeCloseTo(-OVERVIEW_MAX_PITCH, 9);
  });
});

describe('dollyPosition', () => {
  const pivot = new Vector3(0, 0, 0);
  const q = new Quaternion();

  it('距離を倍率で変え、中心から見た向きは変えない', () => {
    const p = dollyPosition(new Vector3(0, 0, 2), q, pivot, 0.5);
    expect(p.toArray()).toEqual([0, 0, 1]);
  });

  it('距離は最小・最大の範囲に収める', () => {
    expect(dollyPosition(new Vector3(0, 0, 2), q, pivot, 1e-9).length()).toBeCloseTo(0.002, 9);
    expect(dollyPosition(new Vector3(0, 0, 2), q, pivot, 1e9).length()).toBeCloseTo(8, 9);
  });

  it('中心と重なっていても、視線の反対側へ離れられる', () => {
    const p = dollyPosition(new Vector3(0, 0, 0), q, pivot, 1.15);
    expect(p.z).toBeGreaterThan(0);
  });
});

/** DOM を使わずにホイールのリスナーを呼べる最小の EventTarget。 */
class FakeTarget {
  private readonly listeners = new Map<string, Set<(e: never) => void>>();
  addEventListener(type: string, fn: (e: never) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: (e: never) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit<T extends object>(type: string, props: T) {
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

describe('OverviewControls: ホイールの払い', () => {
  function createRig() {
    const camera = new PerspectiveCamera(60, 1, 0.001, 10);
    camera.position.set(0, 0, 1);
    const el = new FakeTarget();
    const controls = new OverviewControls(camera, el as unknown as HTMLElement);
    controls.enabled = true;
    const distance = () => camera.position.distanceTo(controls.pivot);
    const send = (deltaY: number, timeStamp: number, extra: object = {}) =>
      el.emit('wheel', { deltaY, deltaX: 0, deltaMode: 0, timeStamp, ...extra });
    return { camera, el, controls, distance, send };
  }

  /** タッチパッドの 2 本指スクロールを模した列（小さな値から立ち上がり、慣性で減衰する）。 */
  function touchpadFlick(total: number, count = 100, decay = 0.97, ramp = 10) {
    const raw = Array.from({ length: count }, (_, i) => decay ** i * Math.min(1, (i + 1) / ramp));
    const scale = total / raw.reduce((a, v) => a + v, 0);
    return raw.map((v, i) => ({ deltaY: v * scale, timeStamp: i * 16 }));
  }

  it('マウスのノッチ 1 つ（deltaY=100）で、距離が 1.15 倍（離れる）/ 1/1.15 倍（近づく）になる', () => {
    const a = createRig();
    a.send(100, 0);
    expect(a.distance()).toBeCloseTo(1.15, 9);
    const b = createRig();
    b.send(-100, 0);
    expect(b.distance()).toBeCloseTo(1 / 1.15, 9);
  });

  it('マウスのノッチだけを 50 ミリ秒間隔で続けても、制限されず 1.15^n 倍になる', () => {
    const r = createRig();
    for (let i = 0; i < 10; i++) r.send(-100, i * 50);
    expect(r.distance()).toBeCloseTo(1.15 ** -10, 9);
  });

  it('タッチパッド: 合計約 2000 ピクセルの払いでも、距離の変化は約 2 倍以内（離れる・近づく両方）', () => {
    const flick = touchpadFlick(2000);
    expect(flick.reduce((a, e) => a + e.deltaY, 0)).toBeCloseTo(2000, 9);
    const out = createRig();
    for (const e of flick) out.send(e.deltaY, e.timeStamp);
    expect(out.distance()).toBeLessThanOrEqual(2);
    expect(out.distance()).toBeGreaterThan(1.8); // 払いはちゃんと効く
    const inn = createRig();
    for (const e of flick) inn.send(-e.deltaY, e.timeStamp);
    expect(1 / inn.distance()).toBeLessThanOrEqual(2);
    expect(1 / inn.distance()).toBeGreaterThan(1.8);
  });

  it('タッチパッド: 50 ピクセル以上のイベントで始まる払いも、払い全体で約 2 倍以内', () => {
    const r = createRig();
    for (let i = 0; i < 3; i++) r.send(150, i * 16);
    for (let i = 0; i < 150; i++) r.send(20, 48 + i * 16);
    expect(r.distance()).toBeLessThanOrEqual(2);
  });

  it('タッチパッド: 間をあけた別の払いは、それぞれ別に約 2 倍以内で効く', () => {
    const r = createRig();
    for (const e of touchpadFlick(2000)) r.send(e.deltaY, e.timeStamp);
    const first = r.distance();
    for (const e of touchpadFlick(2000)) r.send(e.deltaY, e.timeStamp + 5000);
    expect(r.distance() / first).toBeLessThanOrEqual(2);
    expect(r.distance() / first).toBeGreaterThan(1.8);
  });

  it('払いの上限は、飛行モードの速度と同じ倍率（1.1^7）になる。wheelFactor を変えても倍率は同じ', () => {
    expect(1.15 ** overviewGestureLimitNotches(1.15)).toBeCloseTo(1.1 ** 7, 9);
    expect(1.3 ** overviewGestureLimitNotches(1.3)).toBeCloseTo(1.1 ** 7, 9);
    expect(overviewGestureLimitNotches(1)).toBe(7);
    expect(overviewGestureLimitNotches(NaN)).toBe(7);
  });

  it('ピンチ（ctrlKey つき）は距離を変えず、払いの累積にも数えず、ページのズームは止める', () => {
    const r = createRig();
    const ev = r.send(-100, 0, { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    for (const e of touchpadFlick(2000)) r.send(-e.deltaY, e.timeStamp + 1000, { ctrlKey: true });
    expect(r.distance()).toBe(1);
    r.send(100, 1000 + 100 * 16 + 20);
    expect(r.distance()).toBeCloseTo(1.15, 9);
  });

  it('横方向だけのスクロール（deltaY=0）は距離を変えず、ページのスクロールは止める', () => {
    const r = createRig();
    for (let i = 0; i < 20; i++) {
      const ev = r.send(0, i * 16, { deltaX: 80 });
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(r.distance()).toBe(1);
  });

  it('横方向のスクロールは、続いている払いを延ばさない', () => {
    const r = createRig();
    for (let i = 0; i < 100; i++) r.send(20, i * 16); // 上限（約 1.95 倍）まで使い切る
    const saturated = r.distance();
    expect(saturated).toBeCloseTo(1.1 ** 7, 6);
    r.send(0, 99 * 16 + 100, { deltaX: 80 });
    r.send(0, 99 * 16 + 200, { deltaX: 80 });
    // 最後の縦スクロールから 260 ミリ秒あいているので、新しい払いとして効く。
    r.send(100, 99 * 16 + 260);
    expect(r.distance() / saturated).toBeCloseTo(1.15, 9);
  });

  it('無効のときは何もしない（ページのスクロールも止めない）', () => {
    const r = createRig();
    r.controls.enabled = false;
    const ev = r.send(100, 0);
    expect(ev.defaultPrevented).toBe(false);
    expect(r.distance()).toBe(1);
  });
});

describe('OverviewControls: 回転の慣性', () => {
  function createInertiaRig(options: ConstructorParameters<typeof OverviewControls>[2] = {}) {
    const camera = new PerspectiveCamera(60, 1, 0.001, 20);
    camera.position.set(0.3, 0.4, 2);
    camera.quaternion.copy(lookingAt(camera.position, new Vector3(0, 0, 0)));
    camera.updateMatrixWorld();
    const el = new FakeTarget();
    const win = new FakeTarget();
    (el as unknown as { ownerDocument: unknown }).ownerDocument = { defaultView: win };
    const controls = new OverviewControls(camera, el as unknown as HTMLElement, options);
    controls.pivot.set(0.1, -0.1, 0.05);
    controls.enabled = true;
    let clock = 1000;
    const emit = (type: string, extra: object) => el.emit(type, { pointerId: 1, timeStamp: clock, ...extra });
    /** 16 ミリ秒ごとに (dx, dy) ピクセル動かして、`frameCount` フレーム分ドラッグする（離さない）。 */
    const drag = (dx: number, dy = 0, frameCount = 12) => {
      emit('pointerdown', { button: 0, clientX: 100, clientY: 100 });
      for (let i = 1; i <= frameCount; i++) {
        clock += 16;
        emit('pointermove', { clientX: 100 + dx * i, clientY: 100 + dy * i });
      }
    };
    const up = () => emit('pointerup', {});
    const distance = () => camera.position.distanceTo(controls.pivot);
    const pitch = () => Math.asin(new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).y);
    /** 中心から見たカメラの水平方向の角度。 */
    const azimuth = () => Math.atan2(camera.position.x - controls.pivot.x, camera.position.z - controls.pivot.z);
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    return { camera, el, win, controls, emit, drag, up, distance, pitch, azimuth, wrap, advance: (ms: number) => (clock += ms) };
  }

  it('動かしながら離すと、離したあとも中心のまわりを同じ向きへ回り続け、中心までの距離は変わらず、やがて止まる', () => {
    const r = createInertiaRig();
    r.drag(8); // 500 px/s × 0.005 = 2.5 rad/s
    r.up();
    expect(r.controls.isRotatingByInertia).toBe(true);
    const d0 = r.distance();
    const a0 = r.azimuth();
    let prev = a0;
    let steps = 0;
    let moved = 0;
    while (r.controls.update(1 / 60) && steps < 1000) {
      const a = r.azimuth();
      expect(r.wrap(a - prev)).toBeLessThan(1e-9); // 右ドラッグ: カメラは中心のまわりを同じ向き（負）へ回る
      prev = a;
      steps++;
      moved++;
      expect(Math.abs(r.distance() - d0)).toBeLessThan(1e-9);
    }
    expect(moved).toBeGreaterThan(30);
    expect(r.controls.isRotatingByInertia).toBe(false);
    expect(Math.abs(r.wrap(r.azimuth() - a0))).toBeGreaterThan(0.5); // 総回転量は約 2.5 × 0.45 rad
    expect(r.controls.update(1 / 60)).toBe(false);
  });

  it('総回転量は、フレームレート（1/60 秒刻みと 1/30 秒刻み）によらず同じ', () => {
    const run = (dt: number) => {
      const r = createInertiaRig();
      r.drag(6, 3);
      r.up();
      for (let i = 0; i < Math.round(1.5 / dt); i++) r.controls.update(dt);
      return { position: r.camera.position.clone(), quaternion: r.camera.quaternion.clone() };
    };
    const a = run(1 / 60);
    const b = run(1 / 30);
    expect(a.position.distanceTo(b.position)).toBeLessThan(1e-9);
    expect(a.quaternion.angleTo(b.quaternion)).toBeLessThan(1e-9);
  });

  it('慣性を止めた押下を答える。回っていなければ、止めた押下ではない', () => {
    const r = createInertiaRig();
    r.drag(8);
    r.up();
    expect(r.controls.isRotatingByInertia).toBe(true);
    const stopping = r.el.emit('pointerdown', { button: 0, pointerId: 2, clientX: 0, clientY: 0, timeStamp: 5000 });
    expect(r.controls.isRotatingByInertia).toBe(false);
    expect(r.controls.pressStopsInertia(stopping as unknown as Event)).toBe(true);
    const next = r.el.emit('pointerdown', { button: 0, pointerId: 3, clientX: 0, clientY: 0, timeStamp: 5100 });
    expect(r.controls.pressStopsInertia(next as unknown as Event)).toBe(false);
    r.controls.enabled = false;
    expect(r.controls.pressStopsInertia(stopping as unknown as Event)).toBe(false);
  });

  it('離した位置が最後の pointermove と違っても、その動きが慣性の速さに入る', () => {
    const run = (releaseX: number) => {
      const r = createInertiaRig();
      r.emit('pointerdown', { button: 0, clientX: 100, clientY: 100 });
      r.advance(100);
      r.emit('pointermove', { clientX: 110, clientY: 100 });
      r.advance(16);
      r.emit('pointerup', { clientX: releaseX, clientY: 100 });
      expect(r.controls.isRotatingByInertia).toBe(true);
      const a0 = r.azimuth();
      for (let i = 0; i < 20; i++) r.controls.update(1 / 60);
      return Math.abs(r.wrap(r.azimuth() - a0));
    };
    expect(run(190)).toBeGreaterThan(run(110) * 3);
  });

  it('ポインタを止めてから離すと、慣性は付かない。クリックでも付かない', () => {
    const r = createInertiaRig();
    r.drag(8);
    r.advance(200);
    r.up();
    expect(r.controls.isRotatingByInertia).toBe(false);
    const p = r.camera.position.clone();
    expect(r.controls.update(1 / 60)).toBe(false);
    expect(r.camera.position.distanceTo(p)).toBe(0);

    r.emit('pointerdown', { button: 0, clientX: 5, clientY: 5 });
    r.advance(30);
    r.up();
    expect(r.controls.isRotatingByInertia).toBe(false);
  });

  it('ドラッグ中は、ポインタの動きにそのまま追従する（慣性の遅れを入れない）', () => {
    const r = createInertiaRig();
    const a0 = r.azimuth();
    r.emit('pointerdown', { button: 0, clientX: 100, clientY: 100 });
    r.advance(16);
    r.emit('pointermove', { clientX: 120, clientY: 100 });
    expect(r.wrap(r.azimuth() - a0)).toBeCloseTo(-20 * 0.005, 9);
    expect(r.controls.isRotatingByInertia).toBe(false);
  });

  it('最初の角速度に上限がある（極端な速さで払っても、回りすぎない）', () => {
    const r = createInertiaRig();
    r.drag(300, 0, 5);
    r.up();
    const a0 = r.azimuth();
    for (let i = 0; i < 600; i++) r.controls.update(1 / 60);
    const turned = Math.abs(r.wrap(r.azimuth() - a0));
    expect(turned).toBeLessThan(4 * 0.45 + 1e-6);
    expect(turned).toBeGreaterThan(4 * 0.45 * 0.95);
  });

  it('仰角は慣性の間も ±89° に収まり、端で回り続けない', () => {
    const r = createInertiaRig();
    for (const dy of [-40, 40]) {
      r.drag(0, dy);
      r.up();
      for (let i = 0; i < 600; i++) {
        r.controls.update(1 / 60);
        expect(Math.abs(r.pitch())).toBeLessThanOrEqual(OVERVIEW_MAX_PITCH + 1e-9);
      }
      expect(r.pitch()).toBeCloseTo(Math.sign(-dy) * OVERVIEW_MAX_PITCH, 6); // 上へドラッグで見上げ、下へドラッグで見下ろす端に着く
      expect(r.controls.isRotatingByInertia).toBe(false);
      expect(r.controls.update(1 / 60)).toBe(false);
    }
  });

  it('ポインタを押す・無効にする・フォーカスを失う・stopRotationInertia で止まる', () => {
    const r = createInertiaRig();
    const start = () => {
      r.drag(8);
      r.up();
      r.controls.update(1 / 60);
      expect(r.controls.isRotatingByInertia).toBe(true);
    };
    start();
    r.emit('pointerdown', { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    expect(r.controls.isRotatingByInertia).toBe(false);
    r.emit('pointerup', { pointerId: 2 });

    start();
    r.emit('pointerdown', { button: 2, pointerId: 3, clientX: 0, clientY: 0 });
    expect(r.controls.isRotatingByInertia).toBe(false);

    start();
    r.win.emit('blur', {});
    expect(r.controls.isRotatingByInertia).toBe(false);

    start();
    r.controls.stopRotationInertia();
    expect(r.controls.isRotatingByInertia).toBe(false);

    start();
    r.controls.enabled = false;
    expect(r.controls.isRotatingByInertia).toBe(false);
    r.controls.enabled = true;
    const p = r.camera.position.clone();
    expect(r.controls.update(1 / 60)).toBe(false);
    expect(r.camera.position.distanceTo(p)).toBe(0);
  });

  it('慣性の間のホイールは、回転を止めずに距離を変える', () => {
    const r = createInertiaRig();
    r.drag(8);
    r.up();
    r.controls.update(1 / 60);
    r.el.emit('wheel', { deltaY: 100, deltaMode: 0, timeStamp: 5000 });
    expect(r.controls.isRotatingByInertia).toBe(true);
  });

  it('時定数 0 で無効（オプションでも代入でも）。既定は 0.45 秒で、null で既定へ戻る', () => {
    expect(createInertiaRig().controls.rotationTimeConstant).toBe(0.45);
    const c = createInertiaRig();
    c.controls.rotationTimeConstant = 0.9;
    expect(c.controls.rotationTimeConstant).toBe(0.9);
    c.controls.rotationTimeConstant = null;
    expect(c.controls.rotationTimeConstant).toBe(0.45);
    const a = createInertiaRig({ rotationInertia: { timeConstant: 0 } });
    a.drag(16);
    a.up();
    expect(a.controls.isRotatingByInertia).toBe(false);
    const b = createInertiaRig();
    b.controls.rotationTimeConstant = 0;
    b.drag(16);
    b.up();
    expect(b.controls.isRotatingByInertia).toBe(false);
  });

  it('getResidualRotation: 慣性で回っている間の角速度（右へ払うと、ヨーは負）。止まれば 0', () => {
    const r = createInertiaRig();
    expect(r.controls.getResidualRotation()).toEqual({ yawRate: 0, pitchRate: 0 });
    r.drag(8);
    r.up();
    expect(r.controls.isRotatingByInertia).toBe(true);
    const rot = r.controls.getResidualRotation();
    expect(rot.yawRate).toBeLessThan(-0.5);
    expect(rot.pitchRate).toBeCloseTo(0, 9);
    r.controls.stopRotationInertia();
    expect(r.controls.getResidualRotation()).toEqual({ yawRate: 0, pitchRate: 0 });
  });

  it('「動きを減らす」設定のときは、既定で慣性が無効', () => {
    const camera = new PerspectiveCamera();
    const win = new FakeTarget() as FakeTarget & { matchMedia?: (q: string) => { matches: boolean } };
    win.matchMedia = (q: string) => ({ matches: q.includes('prefers-reduced-motion: reduce') });
    const el = new FakeTarget();
    (el as unknown as { ownerDocument: unknown }).ownerDocument = { defaultView: win };
    const controls = new OverviewControls(camera, el as unknown as HTMLElement);
    expect(controls.rotationTimeConstant).toBe(0);
  });

  it('dispose のあと update は何もしない', () => {
    const r = createInertiaRig();
    r.drag(8);
    r.up();
    r.controls.dispose();
    expect(r.controls.update(1 / 60)).toBe(false);
  });
});
