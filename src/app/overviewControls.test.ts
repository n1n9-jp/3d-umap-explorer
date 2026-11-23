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
