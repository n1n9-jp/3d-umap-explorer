import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import {
  approachLogDistance,
  dollyPosition,
  orbitPose,
  OverviewControls,
  overviewGestureLimitNotches,
  OVERVIEW_MAX_DISTANCE,
  OVERVIEW_MAX_PITCH,
  OVERVIEW_MIN_DISTANCE,
  OVERVIEW_PINCH_MAX_FACTOR,
  OVERVIEW_ZOOM_TIME_CONSTANT,
} from './overviewControls';

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

  /** 払いの上限の確認は、距離が追従するまでの時間を挟まずに読めるよう、時定数 0（1 度に動く）で行う。 */
  function createJumpRig() {
    const r = createRig();
    r.controls.zoomTimeConstant = 0;
    return r;
  }

  /** タッチパッドの 2 本指スクロールを模した列（小さな値から立ち上がり、慣性で減衰する）。 */
  function touchpadFlick(total: number, count = 100, decay = 0.97, ramp = 10) {
    const raw = Array.from({ length: count }, (_, i) => decay ** i * Math.min(1, (i + 1) / ramp));
    const scale = total / raw.reduce((a, v) => a + v, 0);
    return raw.map((v, i) => ({ deltaY: v * scale, timeStamp: i * 16 }));
  }

  it('マウスのノッチ 1 つ（deltaY=100）で、距離が 1.15 倍（離れる）/ 1/1.15 倍（近づく）になる', () => {
    const a = createJumpRig();
    a.send(100, 0);
    expect(a.distance()).toBeCloseTo(1.15, 9);
    const b = createJumpRig();
    b.send(-100, 0);
    expect(b.distance()).toBeCloseTo(1 / 1.15, 9);
  });

  it('マウスのノッチだけを 50 ミリ秒間隔で続けても、制限されず 1.15^n 倍になる', () => {
    const r = createJumpRig();
    for (let i = 0; i < 10; i++) r.send(-100, i * 50);
    expect(r.distance()).toBeCloseTo(1.15 ** -10, 9);
  });

  it('タッチパッド: 合計約 2000 ピクセルの払いでも、距離の変化は約 2 倍以内（離れる・近づく両方）', () => {
    const flick = touchpadFlick(2000);
    expect(flick.reduce((a, e) => a + e.deltaY, 0)).toBeCloseTo(2000, 9);
    const out = createJumpRig();
    for (const e of flick) out.send(e.deltaY, e.timeStamp);
    expect(out.distance()).toBeLessThanOrEqual(2);
    expect(out.distance()).toBeGreaterThan(1.8); // 払いはちゃんと効く
    const inn = createJumpRig();
    for (const e of flick) inn.send(-e.deltaY, e.timeStamp);
    expect(1 / inn.distance()).toBeLessThanOrEqual(2);
    expect(1 / inn.distance()).toBeGreaterThan(1.8);
  });

  it('タッチパッド: 50 ピクセル以上のイベントで始まる払いも、払い全体で約 2 倍以内', () => {
    const r = createJumpRig();
    for (let i = 0; i < 3; i++) r.send(150, i * 16);
    for (let i = 0; i < 150; i++) r.send(20, 48 + i * 16);
    expect(r.distance()).toBeLessThanOrEqual(2);
  });

  it('タッチパッド: 間をあけた別の払いは、それぞれ別に約 2 倍以内で効く', () => {
    const r = createJumpRig();
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

  it('ピンチ（ctrlKey つき）はページのズームを止め、払いの累積に数えない', () => {
    const r = createJumpRig();
    const ev = r.send(-100, 0, { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    for (let i = 0; i < 100; i++) r.send(20, 1000 + i * 16, { ctrlKey: true, deltaY: 0.01 * (i % 2 ? 1 : -1) });
    const pinched = r.distance();
    // ピンチのあとのホイール 1 ノッチは、払いの上限に当たらず、そのまま 1.15 倍になる
    r.send(100, 5000);
    expect(r.distance() / pinched).toBeCloseTo(1.15, 9);
  });

  it('横方向だけのスクロール（deltaY=0）は距離を変えず、ページのスクロールは止める', () => {
    const r = createJumpRig();
    for (let i = 0; i < 20; i++) {
      const ev = r.send(0, i * 16, { deltaX: 80 });
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(r.distance()).toBe(1);
  });

  it('横方向のスクロールは、続いている払いを延ばさない', () => {
    const r = createJumpRig();
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
    const r = createJumpRig();
    r.controls.enabled = false;
    const ev = r.send(100, 0);
    expect(ev.defaultPrevented).toBe(false);
    expect(r.distance()).toBe(1);
  });
});

describe('approachLogDistance', () => {
  it('差が (1 − exp(−dt/τ)) の割合だけ縮む。刻みを分けても結果は同じ', () => {
    const one = approachLogDistance(0, 1, 0.15, 0.15);
    expect(one.value).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(one.done).toBe(false);
    let v = 0;
    for (let i = 0; i < 3; i++) v = approachLogDistance(v, 1, 0.05, 0.15).value;
    expect(v).toBeCloseTo(one.value, 12);
  });

  it('差が停止の閾値を下回ったら目標に一致させて done。τ ≤ 0 なら 1 度に目標へ', () => {
    expect(approachLogDistance(0, 1, 100, 0.15)).toEqual({ value: 1, done: true });
    expect(approachLogDistance(0.9995, 1, 0.001, 0.15)).toEqual({ value: 1, done: true });
    expect(approachLogDistance(0, 1, 0.001, 0)).toEqual({ value: 1, done: true });
    expect(approachLogDistance(0, 1, 0.001, -1)).toEqual({ value: 1, done: true });
  });

  it('dt が 0・負・有限でないときは動かさない', () => {
    for (const dt of [0, -1, NaN, Infinity]) {
      expect(approachLogDistance(0, 1, dt, 0.15)).toEqual({ value: 0, done: false });
    }
  });
});

describe('OverviewControls: 目標の距離への追従', () => {
  const STEPS = [1 / 120, 1 / 60, 1 / 30, 0.1];

  function createZoomRig(options: ConstructorParameters<typeof OverviewControls>[2] = {}, win?: object) {
    const camera = new PerspectiveCamera(60, 1, 0.001, 20);
    camera.position.set(0, 0, 1);
    const el = new FakeTarget();
    if (win) (el as unknown as { ownerDocument: unknown }).ownerDocument = { defaultView: win };
    const controls = new OverviewControls(camera, el as unknown as HTMLElement, options);
    controls.enabled = true;
    let clock = 0;
    const wheel = (deltaY: number, extra: object = {}) => {
      clock += 1000; // 払いを区切る
      return el.emit('wheel', { deltaY, deltaX: 0, deltaMode: 0, timeStamp: clock, ...extra });
    };
    /** 経過時間 `seconds` を、刻み `dt` で進める。 */
    const run = (seconds: number, dt: number) => {
      const n = Math.round(seconds / dt);
      for (let i = 0; i < n; i++) controls.update(dt);
    };
    return { camera, el, controls, wheel, run, distance: () => controls.distance };
  }

  it('ホイールは目標の距離だけを動かし、実際の距離は動かさない（既定の時定数は 0.15 秒）', () => {
    const r = createZoomRig();
    expect(r.controls.zoomTimeConstant).toBe(OVERVIEW_ZOOM_TIME_CONSTANT);
    expect(r.controls.zoomTimeConstant).toBe(0.15);
    r.wheel(100);
    expect(r.distance()).toBe(1);
    expect(r.controls.targetDistance).toBeCloseTo(1.15, 12);
    expect(r.controls.isZooming).toBe(true);
    expect(r.controls.zoomState()).toEqual({ distance: 1, targetDistance: r.controls.targetDistance, zooming: true });
  });

  it('ln d が (1 − exp(−t/τ)) の割合で目標へ近づく。刻み幅（1/120・1/60・1/30・0.1 秒）によらず同じ', () => {
    const lnTarget = Math.log(1.15);
    const results = STEPS.map((dt) => {
      const r = createZoomRig();
      r.wheel(100);
      r.run(0.3, dt);
      return Math.log(r.distance());
    });
    for (const ln of results) {
      expect(ln).toBeCloseTo(lnTarget * (1 - Math.exp(-0.3 / 0.15)), 9);
      expect(ln).toBeCloseTo(results[0] as number, 9);
    }
  });

  it('近づく間、距離は単調に変わり（離れる・近づく両方）、やがて目標に一致して止まる', () => {
    for (const sign of [1, -1]) {
      const r = createZoomRig();
      r.wheel(100 * sign);
      const target = r.controls.targetDistance;
      let prev = r.distance();
      let frames = 0;
      while (r.controls.update(1 / 60)) {
        const d = r.distance();
        expect((d - prev) * sign).toBeGreaterThan(0);
        expect((d - target) * sign).toBeLessThanOrEqual(1e-12);
        prev = d;
        frames++;
        expect(frames).toBeLessThan(600);
      }
      expect(frames).toBeGreaterThan(20);
      expect(r.distance()).toBe(target);
      expect(r.controls.isZooming).toBe(false);
      expect(r.controls.targetDistance).toBe(r.distance());
      expect(r.controls.update(1 / 60)).toBe(false); // 止まったら、カメラは動かない
    }
  });

  it('寄っている途中のホイールは、目標へ重ねて掛かる（現在の距離ではなく目標が基準）', () => {
    const r = createZoomRig();
    r.wheel(-100);
    r.run(0.1, 1 / 60);
    r.wheel(-100);
    r.wheel(-100);
    expect(r.controls.targetDistance).toBeCloseTo(1.15 ** -3, 12);
    r.run(3, 1 / 60);
    expect(r.distance()).toBeCloseTo(1.15 ** -3, 12);
  });

  it('寄る向きは中心から見たカメラの向きと視線を変えない', () => {
    const r = createZoomRig();
    r.camera.position.set(0.3, 0.4, 1.2);
    r.camera.quaternion.copy(lookingAt(r.camera.position, new Vector3(0.1, 0, 0)));
    const dir = r.camera.position.clone().sub(r.controls.pivot).normalize();
    const q = r.camera.quaternion.clone();
    r.wheel(100);
    r.run(0.4, 1 / 60);
    expect(r.camera.position.clone().sub(r.controls.pivot).normalize().distanceTo(dir)).toBeLessThan(1e-9);
    expect(r.camera.quaternion.angleTo(q)).toBeLessThan(1e-6);
  });

  it('払いの上限と距離の範囲は保たれる', () => {
    // 払いの上限: 約 2000 ピクセルの払いでも、目標は 1.95 倍（1.1^7）まで
    const r = createZoomRig();
    for (let i = 0; i < 100; i++) r.el.emit('wheel', { deltaY: 20, deltaX: 0, deltaMode: 0, timeStamp: i * 16 });
    expect(r.controls.targetDistance).toBeCloseTo(1.1 ** 7, 6);
    r.run(5, 1 / 60);
    expect(r.distance()).toBeCloseTo(1.1 ** 7, 6);
    // 距離の範囲: 目標も実際の距離も範囲の外へ出ない
    const far = createZoomRig();
    const near = createZoomRig();
    for (let i = 0; i < 60; i++) {
      far.wheel(100);
      near.wheel(-100);
      far.run(0.05, 1 / 60);
      near.run(0.05, 1 / 60);
      expect(far.distance()).toBeLessThanOrEqual(OVERVIEW_MAX_DISTANCE + 1e-12);
      expect(near.distance()).toBeGreaterThanOrEqual(OVERVIEW_MIN_DISTANCE - 1e-12);
    }
    far.run(5, 1 / 60);
    near.run(5, 1 / 60);
    expect(far.distance()).toBeCloseTo(OVERVIEW_MAX_DISTANCE, 9);
    expect(near.distance()).toBeCloseTo(OVERVIEW_MIN_DISTANCE, 9);
    // 端で押し続けても、寄っている途中にはならない
    far.wheel(100);
    expect(far.controls.isZooming).toBe(false);
  });

  it('ピンチ（ctrlKey つき）で、factor = exp(deltaY × 0.01) だけ目標が動く（広げる = 近づく）。ページのズームは止める', () => {
    const r = createZoomRig();
    const ev = r.wheel(-30, { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(r.controls.targetDistance).toBeCloseTo(Math.exp(-0.3), 12);
    r.wheel(10, { ctrlKey: true });
    expect(r.controls.targetDistance).toBeCloseTo(Math.exp(-0.2), 12);
    r.run(0.15, 1 / 60);
    expect(Math.log(r.distance())).toBeCloseTo(-0.2 * (1 - Math.exp(-1)), 9);
    r.run(5, 1 / 60);
    expect(r.distance()).toBeCloseTo(Math.exp(-0.2), 12);
    // deltaY が 0 のピンチは何もしない
    const flat = createZoomRig();
    flat.wheel(0, { ctrlKey: true });
    expect(flat.controls.isZooming).toBe(false);
  });

  it('ピンチ 1 回のイベントの倍率は 1.15³ まで（マウスの Ctrl + ホイール 1 ノッチで約 2.7 倍にならない）。小さな deltaY の連続は上限に掛からない', () => {
    expect(OVERVIEW_PINCH_MAX_FACTOR).toBeCloseTo(1.15 ** 3, 12);
    const mouse = createZoomRig();
    mouse.wheel(100, { ctrlKey: true }); // exp(1.0) ≈ 2.7 倍のところを 1.15³ ≈ 1.52 倍に収める
    expect(mouse.controls.targetDistance).toBeCloseTo(1.15 ** 3, 12);
    mouse.wheel(-100, { ctrlKey: true });
    mouse.wheel(-100, { ctrlKey: true });
    expect(mouse.controls.targetDistance).toBeCloseTo(1.15 ** -3, 12);
    // ちょうど上限の大きさ（deltaY ≈ 41.9）までは exp(deltaY × 0.01) のまま
    const edge = createZoomRig();
    edge.wheel(40, { ctrlKey: true });
    expect(edge.controls.targetDistance).toBeCloseTo(Math.exp(0.4), 12);
    // トラックパッドのピンチ: 小さな deltaY が続けて届く。合計 deltaY 120 で exp(1.2) 倍（上限に掛からない）
    const pad = createZoomRig();
    for (let i = 0; i < 40; i++) pad.wheel(3, { ctrlKey: true });
    expect(pad.controls.targetDistance).toBeCloseTo(Math.exp(1.2), 9);
  });

  it('ピンチも払いの上限に掛からず、刻み幅によらず同じ結果になる', () => {
    const results = STEPS.map((dt) => {
      const r = createZoomRig();
      // 合わせて exp(0.8) ≈ 2.2 倍（払いの上限 1.95 倍を超える）。1 回あたりはピンチの上限 1.15³ に収まる大きさで 2 回
      r.wheel(40, { ctrlKey: true });
      r.wheel(40, { ctrlKey: true });
      r.run(0.2, dt);
      return Math.log(r.distance());
    });
    expect(results[0]).toBeCloseTo(0.8 * (1 - Math.exp(-0.2 / 0.15)), 9);
    for (const ln of results) expect(ln).toBeCloseTo(results[0] as number, 9);
  });

  it('ドラッグで回しながら寄っても、回転と距離の変化は両立する', () => {
    const camera = new PerspectiveCamera(60, 1, 0.001, 20);
    camera.position.set(0.3, 0.4, 2);
    camera.quaternion.copy(lookingAt(camera.position, new Vector3()));
    camera.updateMatrixWorld();
    const el = new FakeTarget();
    const controls = new OverviewControls(camera, el as unknown as HTMLElement);
    controls.enabled = true;
    const azimuth = () => Math.atan2(camera.position.x, camera.position.z);
    const a0 = azimuth();
    const d0 = controls.distance;
    el.emit('wheel', { deltaY: -100, deltaMode: 0, timeStamp: 0 });
    el.emit('wheel', { deltaY: -100, deltaMode: 0, timeStamp: 1000 });
    const target = controls.targetDistance;
    expect(target).toBeCloseTo(d0 / 1.15 ** 2, 12);
    el.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, timeStamp: 1000 });
    for (let i = 1; i <= 10; i++) {
      el.emit('pointermove', { pointerId: 1, clientX: 100 + 10 * i, clientY: 100, timeStamp: 1000 + 16 * i });
      controls.update(1 / 60);
      expect(controls.isZooming || controls.distance === target).toBe(true);
    }
    expect(Math.abs(azimuth() - a0)).toBeGreaterThan(0.3); // 回った（10 回 × 10px × 0.005 rad）
    expect(controls.distance).toBeLessThan(d0); // 寄ってもいる
    el.emit('pointerup', { pointerId: 1, clientX: 200, clientY: 100, timeStamp: 1000 + 16 * 10 + 300 });
    for (let i = 0; i < 300; i++) controls.update(1 / 60);
    expect(controls.distance).toBeCloseTo(target, 12);
    expect(controls.isZooming).toBe(false);
  });

  it('時定数 0 では、ホイールごとに距離が 1 度に動く（オプションでも代入でも）。null で既定へ戻る', () => {
    const a = createZoomRig({ zoomTimeConstant: 0 });
    expect(a.controls.zoomTimeConstant).toBe(0);
    a.wheel(100);
    expect(a.distance()).toBeCloseTo(1.15, 12);
    expect(a.controls.isZooming).toBe(false);
    a.wheel(-30, { ctrlKey: true });
    expect(a.distance()).toBeCloseTo(1.15 * Math.exp(-0.3), 12);
    expect(a.controls.update(1 / 60)).toBe(false);

    const b = createZoomRig();
    b.controls.zoomTimeConstant = 0;
    b.wheel(100);
    expect(b.distance()).toBeCloseTo(1.15, 12);
    b.controls.zoomTimeConstant = 0.5;
    expect(b.controls.zoomTimeConstant).toBe(0.5);
    b.controls.zoomTimeConstant = null;
    expect(b.controls.zoomTimeConstant).toBe(0.15);
    b.controls.zoomTimeConstant = NaN; // 無視する
    expect(b.controls.zoomTimeConstant).toBe(0.15);
  });

  it('時定数を変えると近づく速さが変わる', () => {
    const slow = createZoomRig({ zoomTimeConstant: 0.5 });
    slow.wheel(100);
    slow.run(0.5, 1 / 60);
    expect(Math.log(slow.distance())).toBeCloseTo(Math.log(1.15) * (1 - Math.exp(-1)), 9);
  });

  it('「動きを減らす」設定のときは、既定で 1 度に動く。時定数を明示すればそちらに従う', () => {
    const win = new FakeTarget() as FakeTarget & { matchMedia?: (q: string) => { matches: boolean } };
    win.matchMedia = (q: string) => ({ matches: q.includes('prefers-reduced-motion: reduce') });
    const r = createZoomRig({}, win);
    expect(r.controls.zoomTimeConstant).toBe(0);
    r.wheel(100);
    expect(r.distance()).toBeCloseTo(1.15, 12);
    expect(r.controls.isZooming).toBe(false);
    r.controls.zoomTimeConstant = 0.15;
    r.wheel(100);
    expect(r.controls.isZooming).toBe(true);
    r.controls.zoomTimeConstant = null;
    expect(r.controls.zoomTimeConstant).toBe(0);
  });

  it('無効にすると寄っている途中の距離は止まり、再び有効にしても続きを動かない', () => {
    const r = createZoomRig();
    r.wheel(100);
    r.run(0.1, 1 / 60);
    const d = r.distance();
    r.controls.enabled = false;
    expect(r.controls.isZooming).toBe(false);
    r.controls.enabled = true;
    expect(r.controls.update(1 / 60)).toBe(false);
    expect(r.distance()).toBe(d);
  });

  it('stopZoom で止まる（位置はそのまま、目標は今の距離になる）', () => {
    const r = createZoomRig();
    r.wheel(100);
    r.run(0.1, 1 / 60);
    const d = r.distance();
    r.controls.stopZoom();
    expect(r.controls.isZooming).toBe(false);
    expect(r.controls.targetDistance).toBe(d);
    r.run(1, 1 / 60);
    expect(r.distance()).toBe(d);
  });

  it('範囲の外から始まっても、目標へ向かって跳ばずに寄る', () => {
    const r = createZoomRig();
    r.camera.position.set(0, 0, 20); // 最大の 8 を超えている
    r.wheel(100); // 離れる向き: 目標は最大の 8
    expect(r.controls.targetDistance).toBeCloseTo(OVERVIEW_MAX_DISTANCE, 12);
    r.controls.update(1 / 60);
    expect(r.distance()).toBeLessThan(20);
    expect(r.distance()).toBeGreaterThan(OVERVIEW_MAX_DISTANCE + 0.1); // 1 フレームで 8 へ跳ばない
  });

  it('dt が 0 や負・有限でないフレームでは動かない', () => {
    const r = createZoomRig();
    r.wheel(100);
    for (const dt of [0, -1, NaN]) {
      expect(r.controls.update(dt)).toBe(false);
      expect(r.distance()).toBe(1);
    }
    expect(r.controls.isZooming).toBe(true);
  });

  it('dispose のあと update は何もしない', () => {
    const r = createZoomRig();
    r.wheel(100);
    r.controls.dispose();
    expect(r.controls.update(1 / 60)).toBe(false);
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

describe('OverviewControls: 「動きを減らす」設定の問い合わせ', () => {
  type ChangeListener = (e: { matches: boolean }) => void;
  it('自分で作った問い合わせは 1 回だけで、change で次のフレームから反映し（距離の時定数・回転の慣性）、dispose で外す', () => {
    const mql = {
      matches: false,
      listeners: new Set<ChangeListener>(),
      addEventListener(type: string, fn: ChangeListener) { if (type === 'change') this.listeners.add(fn); },
      removeEventListener(type: string, fn: ChangeListener) { if (type === 'change') this.listeners.delete(fn); },
      set(matches: boolean) { this.matches = matches; for (const fn of [...this.listeners]) fn({ matches }); },
    };
    let calls = 0;
    const win = new FakeTarget() as FakeTarget & { matchMedia?: () => typeof mql };
    win.matchMedia = () => { calls++; return mql; };
    const el = new FakeTarget();
    (el as unknown as { ownerDocument: unknown }).ownerDocument = { defaultView: win };
    const camera = new PerspectiveCamera(60, 1, 0.001, 20);
    camera.position.set(0, 0, 1);
    const controls = new OverviewControls(camera, el as unknown as HTMLElement);
    controls.enabled = true;
    expect(controls.zoomTimeConstant).toBe(0.15);
    expect(controls.rotationTimeConstant).toBe(0.45);
    el.emit('wheel', { deltaY: 100, deltaX: 0, deltaMode: 0, timeStamp: 1000 });
    expect(controls.isZooming).toBe(true);
    for (let i = 0; i < 30; i++) controls.update(1 / 60);
    mql.set(true);
    expect(controls.zoomTimeConstant).toBe(0);
    expect(controls.rotationTimeConstant).toBe(0);
    el.emit('wheel', { deltaY: 100, deltaX: 0, deltaMode: 0, timeStamp: 3000 });
    expect(controls.isZooming).toBe(false); // 1 度に動く
    for (let i = 0; i < 30; i++) controls.update(1 / 60);
    expect(calls).toBe(1);
    expect(mql.listeners.size).toBe(1);
    controls.dispose();
    expect(mql.listeners.size).toBe(0);
  });
});
