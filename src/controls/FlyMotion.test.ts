import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  DEFAULT_ACCEL_TIME_CONSTANT,
  DEFAULT_GLIDE_TIME_CONSTANT,
  FlyMotion,
  GLIDE_STOP_RATIO,
  MAX_PITCH,
  createMoveInput,
} from './FlyMotion';
import type { MoveInput } from './FlyMotion';
import { FLIGHT_CARRY_LIMIT, FLIGHT_EXCESS_LIMIT, flightCarry, flightEase, scaledFlightDuration } from './easing';

const deg = (d: number) => (d * Math.PI) / 180;

function input(patch: Partial<MoveInput>): MoveInput {
  return { ...createMoveInput(), ...patch };
}

/** `seconds` を `dt` 刻みで積分する。 */
function run(m: FlyMotion, seconds: number, dt: number, inp: MoveInput): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) m.step(dt, inp);
}

function wrapDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function expectClose(a: Vector3, b: Vector3, eps: number): void {
  expect(a.distanceTo(b)).toBeLessThan(eps);
}

describe('FlyMotion: 移動', () => {
  it('前進は視線方向（既定は -Z）へ進む', () => {
    const m = new FlyMotion();
    run(m, 1, 1 / 60, input({ forward: true }));
    expect(m.position.z).toBeLessThan(0);
    expect(Math.abs(m.position.x)).toBeLessThan(1e-12);
    expect(Math.abs(m.position.y)).toBeLessThan(1e-12);
  });

  it('後退・左右・上下の向きが正しい', () => {
    const cases: [Partial<MoveInput>, (p: Vector3) => boolean][] = [
      [{ backward: true }, (p) => p.z > 0],
      [{ right: true }, (p) => p.x > 0],
      [{ left: true }, (p) => p.x < 0],
      [{ up: true }, (p) => p.y > 0],
      [{ down: true }, (p) => p.y < 0],
    ];
    for (const [patch, ok] of cases) {
      const m = new FlyMotion();
      run(m, 0.5, 1 / 60, input(patch));
      expect(ok(m.position), JSON.stringify(patch)).toBe(true);
    }
  });

  it('前進は上を向けば上へ、E/Q と右移動はピッチの影響を受けない', () => {
    const m = new FlyMotion();
    m.rotateBy(0, deg(45));
    run(m, 1, 1 / 60, input({ forward: true }));
    expect(m.position.y).toBeGreaterThan(0);

    const r = new FlyMotion();
    r.rotateBy(0, deg(60));
    run(r, 1, 1 / 60, input({ right: true }));
    expect(Math.abs(r.position.y)).toBeLessThan(1e-12);
    expect(r.position.x).toBeGreaterThan(0);

    const u = new FlyMotion();
    u.rotateBy(0, deg(60));
    run(u, 1, 1 / 60, input({ up: true }));
    expect(Math.abs(u.position.x)).toBeLessThan(1e-12);
    expect(Math.abs(u.position.z)).toBeLessThan(1e-12);
  });

  it('ヨーを回すと右移動の向きも回る', () => {
    const m = new FlyMotion();
    m.rotateBy(deg(90), 0); // 左 90° = -X を向く。右は -Z
    run(m, 1, 1 / 60, input({ right: true }));
    expect(m.position.z).toBeLessThan(0);
    expect(Math.abs(m.position.x)).toBeLessThan(1e-9);
  });

  it('斜め移動は速くならない', () => {
    const a = new FlyMotion({ accelTimeConstant: 0, glideTimeConstant: 0 });
    const b = new FlyMotion({ accelTimeConstant: 0, glideTimeConstant: 0 });
    run(a, 1, 1 / 60, input({ forward: true }));
    run(b, 1, 1 / 60, input({ forward: true, right: true }));
    expect(b.position.length()).toBeCloseTo(a.position.length(), 9);
  });

  it('逆向きのキーは打ち消し合う', () => {
    const m = new FlyMotion();
    run(m, 1, 1 / 60, input({ forward: true, backward: true }));
    expect(m.position.length()).toBe(0);
  });

  it('定常速度は speed（既定 0.45）で、加速の入力や倍率オプションは持たない', () => {
    const m = new FlyMotion({ accelTimeConstant: 0, glideTimeConstant: 0 });
    run(m, 1, 1 / 60, input({ forward: true }));
    expect(m.position.length()).toBeCloseTo(0.45, 9);
    expect(Object.keys(createMoveInput()).sort()).toEqual(['backward', 'down', 'forward', 'left', 'right', 'up']);
    expect('boostFactor' in m).toBe(false);
  });

  it('速度は時定数 τ で目標へ指数的に近づく', () => {
    const m = new FlyMotion({ speed: 0.15, accelTimeConstant: 0.12, glideTimeConstant: 0.12 });
    run(m, 0.12, 0.01, input({ forward: true }));
    // 1τ 後は目標の 1 - 1/e ≈ 63.2%
    expect(m.velocity.length() / 0.15).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  it('入力をやめると十分な時間で完全に停止し、その後は動いたと報告しない', () => {
    const m = new FlyMotion();
    run(m, 1, 1 / 60, input({ forward: true }));
    run(m, 3, 1 / 60, createMoveInput());
    expect(m.velocity.length()).toBe(0);
    expect(m.step(1 / 60, createMoveInput())).toBe(false);
  });

  it('1 回の積分時間は maxDeltaTime で頭打ちになる', () => {
    const a = new FlyMotion();
    const b = new FlyMotion();
    a.step(10, input({ forward: true }));
    b.step(0.1, input({ forward: true }));
    expectClose(a.position, b.position, 1e-12);
  });
});

describe('FlyMotion: フレームレート非依存', () => {
  const scenarios: [string, (m: FlyMotion, dt: number) => void][] = [
    ['前進を 1 秒', (m, dt) => run(m, 1, dt, input({ forward: true }))],
    [
      '前進 0.5 秒 → 離して慣性で停止まで',
      (m, dt) => {
        run(m, 0.5, dt, input({ forward: true }));
        run(m, 1.5, dt, createMoveInput());
      },
    ],
    [
      '視点を回してから斜め移動',
      (m, dt) => {
        m.rotateBy(deg(37), deg(20));
        run(m, 1, dt, input({ forward: true, right: true, up: true }));
        run(m, 0.5, dt, createMoveInput());
      },
    ],
  ];

  for (const [name, scenario] of scenarios) {
    it(`1/60 秒刻みと 1/30 秒刻みで位置が一致する: ${name}`, () => {
      const a = new FlyMotion();
      const b = new FlyMotion();
      scenario(a, 1 / 60);
      scenario(b, 1 / 30);
      expect(a.position.length()).toBeGreaterThan(0.01);
      expectClose(a.position, b.position, 1e-6);
      expectClose(a.velocity, b.velocity, 1e-6);
    });
  }

  it('不揃いなフレーム間隔でも一致する', () => {
    const a = new FlyMotion();
    const b = new FlyMotion();
    run(a, 1, 1 / 60, input({ forward: true }));
    const dts = [1 / 144, 1 / 24, 1 / 60, 1 / 90, 1 / 45];
    let t = 0;
    for (let i = 0; t < 1 - 1e-12; i++) {
      const dt = Math.min(dts[i % dts.length]!, 1 - t);
      b.step(dt, input({ forward: true }));
      t += dt;
    }
    expectClose(a.position, b.position, 1e-6);
  });
});

describe('FlyMotion: 視点', () => {
  it('ピッチは ±89° で止まる', () => {
    const m = new FlyMotion();
    m.rotateBy(0, 10);
    expect(m.pitch).toBeCloseTo(deg(89), 12);
    expect(m.pitch).toBe(MAX_PITCH);
    m.rotateBy(0, -20);
    expect(m.pitch).toBeCloseTo(-deg(89), 12);
  });

  it('ヨーは制限なく回り、ロールは常に 0', () => {
    const m = new FlyMotion();
    for (let i = 0; i < 100; i++) m.rotateBy(0.5, 0);
    expect(Number.isFinite(m.yaw)).toBe(true);
    expect(Math.abs(m.yaw)).toBeLessThanOrEqual(Math.PI);
    // 右方向は常に水平
    const right = new Vector3(Math.cos(m.yaw), 0, -Math.sin(m.yaw));
    expect(right.y).toBe(0);
  });

  it('setPose / getPose は往復できる', () => {
    const m = new FlyMotion();
    m.setPose(new Vector3(0.1, 0.2, 0.3), new Vector3(0.5, -0.1, -0.4));
    const pose = m.getPose();
    expectClose(pose.position, new Vector3(0.1, 0.2, 0.3), 1e-12);
    const dir = pose.lookAt.clone().sub(pose.position);
    const want = new Vector3(0.4, -0.3, -0.7).normalize();
    expectClose(dir, want, 1e-9);

    const m2 = new FlyMotion();
    m2.setPose(pose.position, pose.lookAt);
    expectClose(m2.getPose().lookAt, pose.lookAt, 1e-9);
  });

  it('setPose は速度を 0 に戻し、真上を向く指定はピッチ上限に丸める', () => {
    const m = new FlyMotion();
    run(m, 1, 1 / 60, input({ forward: true }));
    m.setPose(new Vector3(0, 0, 0), new Vector3(0, 5, 0));
    expect(m.velocity.length()).toBe(0);
    expect(m.pitch).toBe(MAX_PITCH);
  });

  it('lookAt が position と一致するときは向きを変えない', () => {
    const m = new FlyMotion();
    m.rotateBy(0.3, 0.2);
    const yaw = m.yaw;
    const pitch = m.pitch;
    m.setPose(new Vector3(1, 1, 1), new Vector3(1, 1, 1));
    expect(m.yaw).toBe(yaw);
    expect(m.pitch).toBe(pitch);
  });
});

describe('FlyMotion: ホイールによる速度変更', () => {
  it('1 ノッチで約 1.1 倍（上へ回すと加速、下へ回すと減速）', () => {
    const m = new FlyMotion({ speed: 0.15 });
    expect(m.applyWheel(-1)).toBe(true);
    expect(m.speed).toBeCloseTo(0.165, 12);
    m.applyWheel(1);
    expect(m.speed).toBeCloseTo(0.15, 12);
  });

  it('乗算的に変わる（n ノッチで 1.1^n 倍）', () => {
    const m = new FlyMotion({ speed: 0.15 });
    for (let i = 0; i < 10; i++) m.applyWheel(-1);
    expect(m.speed).toBeCloseTo(0.15 * 1.1 ** 10, 9);
  });

  it('既定値は speed 0.45、minSpeed 0.005、maxSpeed 2', () => {
    const m = new FlyMotion();
    expect(m.speed).toBe(0.45);
    expect(m.minSpeed).toBe(0.005);
    expect(m.maxSpeed).toBe(2);
  });

  it('上下限で止まり、限界では変化なしと報告する', () => {
    const m = new FlyMotion();
    for (let i = 0; i < 200; i++) m.applyWheel(-1);
    expect(m.speed).toBe(2);
    expect(m.applyWheel(-1)).toBe(false);
    for (let i = 0; i < 400; i++) m.applyWheel(1);
    expect(m.speed).toBe(0.005);
    expect(m.applyWheel(1)).toBe(false);
  });

  it('speed の代入も上下限に丸められる', () => {
    const m = new FlyMotion();
    m.speed = 100;
    expect(m.speed).toBe(2);
    m.speed = 0;
    expect(m.speed).toBe(0.005);
  });

  it('1 回のイベントで反映するノッチ数は 3 までに抑える', () => {
    const m = new FlyMotion({ speed: 0.15 });
    m.applyWheel(-50);
    expect(m.speed).toBeCloseTo(0.15 * 1.1 ** 3, 12);
  });

  it('速度が変わると実際の移動量も変わる', () => {
    const a = new FlyMotion();
    const b = new FlyMotion();
    for (let i = 0; i < 5; i++) b.applyWheel(-1);
    run(a, 1, 1 / 60, input({ forward: true }));
    run(b, 1, 1 / 60, input({ forward: true }));
    expect(b.position.length() / a.position.length()).toBeCloseTo(1.1 ** 5, 6);
  });
});

describe('FlyMotion: flyTo', () => {
  /** 終了まで進める。 */
  function finish(m: FlyMotion, dt = 1 / 60): void {
    for (let i = 0; i < 600 && m.isFlying; i++) m.step(dt, createMoveInput());
  }

  it('対象とカメラを結ぶ線上で、対象から distance だけ手前に着く', () => {
    const m = new FlyMotion();
    m.setPose(new Vector3(0.5, 0.2, 0.8), new Vector3(0, 0, 0));
    const target = new Vector3(-0.3, 0.1, -0.2);
    const startPos = m.position.clone();
    m.flyTo(target, { distance: 0.05, durationMs: 600 });
    expect(m.isFlying).toBe(true);
    finish(m);
    expect(m.isFlying).toBe(false);

    expect(m.position.distanceTo(target)).toBeCloseTo(0.05, 9);
    // 線上: 開始位置 - target と終了位置 - target が同じ向き
    const a = startPos.clone().sub(target).normalize();
    const b = m.position.clone().sub(target).normalize();
    expectClose(a, b, 1e-9);
    // 対象を注視している
    const dir = m.getDirection(new Vector3());
    expectClose(dir, target.clone().sub(m.position).normalize(), 1e-9);
  });

  it('所要時間は durationMs（既定 600ms）で、その前は途中にいる', () => {
    const m = new FlyMotion();
    const target = new Vector3(0, 0, -1);
    m.flyTo(target, { distance: 0.1 });
    for (let i = 0; i < 35; i++) m.step(1 / 60, createMoveInput()); // 583ms
    expect(m.isFlying).toBe(true);
    m.step(1 / 60, createMoveInput());
    m.step(1 / 60, createMoveInput()); // 617ms（浮動小数の誤差に左右されない位置まで進める）
    expect(m.isFlying).toBe(false);
    expect(m.position.z).toBeCloseTo(-0.9, 9);
  });

  it('位置は緩急 f(t) = 1 − (1−t)³(1+3t) で進む（始めの 1 歩は小さい）', () => {
    const m = new FlyMotion();
    m.flyTo(new Vector3(0, 0, -1), { distance: 0, durationMs: 1000 });
    m.step(0.1, createMoveInput());
    expect(m.position.z).toBeCloseTo(-flightEase(0.1), 12);
    // 最初の 1/60 秒の移動量は、全体の距離（1）の 0.1% 未満（easeOutQuart では 6% を超えていた）
    const a = new FlyMotion();
    a.flyTo(new Vector3(0, 0, -1), { distance: 0, durationMs: 1000 });
    a.step(1 / 60, createMoveInput());
    expect(Math.abs(a.position.z)).toBeLessThan(0.002);
  });

  it('向きは進みの 70% で合い終え、位置はまだ着いていない', () => {
    const make = () => {
      const m = new FlyMotion();
      m.setPose(new Vector3(0.5, 0.3, 0.8), new Vector3(1.5, 0.3, 0.8)); // +X を向いて始める
      m.flyTo(new Vector3(-0.4, 0.2, -0.6), { distance: 0.05, durationMs: 1000 });
      return m;
    };
    const ref = make();
    finish(ref);
    const m = make();
    for (let i = 0; i < 3; i++) m.step(0.1, createMoveInput()); // 進み 0.3: まだ回っている途中
    expect(Math.abs(wrapDiff(m.yaw, ref.yaw))).toBeGreaterThan(0.05);
    for (let i = 0; i < 4; i++) m.step(0.1, createMoveInput());
    m.step(0.002, createMoveInput()); // 進み 0.702
    expect(m.isFlying).toBe(true);
    expect(Math.abs(wrapDiff(m.yaw, ref.yaw))).toBeLessThan(1e-12);
    expect(m.pitch).toBeCloseTo(ref.pitch, 12);
    expect(m.position.distanceTo(ref.position)).toBeGreaterThan(0.01);
  });

  it('始めのカメラの速度 v0 を引き継ぐ（t=0 の速度が v0）。終わりの位置は目標で、速度は 0', () => {
    const m = new FlyMotion({ speed: 0.5 });
    m.setPose(new Vector3(0, 0, 1), new Vector3(0, 0, 0));
    run(m, 1, 1 / 60, input({ right: true }));
    run(m, 0.2, 1 / 60, createMoveInput()); // 滑走の途中
    expect(m.isGliding).toBe(true);
    const v0 = m.velocity.clone();
    expect(v0.length()).toBeGreaterThan(0.05);
    const p0 = m.position.clone();
    const target = new Vector3(0, 0, -1);
    m.flyTo(target, { distance: 0.1, durationMs: 1000 });
    expect(m.velocity.length()).toBe(0);
    expect(m.flightInfo?.carriedSpeed).toBeCloseTo(v0.length(), 12);

    // 十分小さい刻みの 1 歩で、(位置の差) / dt が v0（二次の項は dt に比例して消える）
    const dt = 1e-4;
    m.step(dt, createMoveInput());
    const v = m.position.clone().sub(p0).divideScalar(dt);
    expect(v.distanceTo(v0)).toBeLessThan(v0.length() * 2e-3 + 1e-3);

    // 終わり: 位置は目標、速度は 0（終わりの直前の速さが 0 へ向かう）
    finish(m);
    expect(m.isFlying).toBe(false);
    expect(m.position.distanceTo(target)).toBeCloseTo(0.1, 9);
    expect(m.velocity.length()).toBe(0);
    const before = m.position.clone();
    m.step(1 / 60, createMoveInput());
    expect(m.position.distanceTo(before)).toBe(0);
  });

  it('引き継ぐ項は終わりへ向けて 0 になる（終わりの直前の速さが小さい）', () => {
    const m = new FlyMotion();
    m.setPose(new Vector3(0, 0, 1), new Vector3(0, 0, 0));
    run(m, 1, 1 / 60, input({ right: true }));
    m.flyTo(new Vector3(0, 0, -1), { distance: 0.1, durationMs: 1000 });
    let prev = m.position.clone();
    let lastSpeed = Infinity;
    for (let i = 0; i < 1000 && m.isFlying; i++) {
      prev = m.position.clone();
      m.step(0.001, createMoveInput());
      lastSpeed = m.position.distanceTo(prev) / 0.001;
    }
    expect(lastSpeed).toBeLessThan(0.01);
  });

  it('飛行の途中で flyTo し直すと、その瞬間の飛行の速度を引き継ぐ（速さが跳ばない）', () => {
    const m = new FlyMotion();
    m.flyTo(new Vector3(0, 0, -1), { distance: 0.1, durationMs: 1000 });
    for (let i = 0; i < 20; i++) m.step(0.01, createMoveInput()); // t = 0.2
    const before = m.position.clone();
    m.step(1e-4, createMoveInput());
    const vFlight = m.position.clone().sub(before).divideScalar(1e-4);
    expect(vFlight.length()).toBeGreaterThan(0.5);
    m.flyTo(new Vector3(1, 0, -1), { distance: 0.1, durationMs: 1000 });
    expect(m.flightInfo?.carriedSpeed).toBeGreaterThan(vFlight.length() * 0.95);
    expect(m.flightInfo?.carriedSpeed).toBeLessThan(vFlight.length() * 1.05);
  });

  it('所要時間は、基準 × 距離による倍率（0.8〜1.8 倍）。cloudRadius がなければ基準のまま', () => {
    const R = 1;
    const duration = (distanceToTarget: number, opts: { cloudRadius?: number; durationMs?: number } = {}) => {
      const m = new FlyMotion();
      m.setPose(new Vector3(0, 0, distanceToTarget), new Vector3(0, 0, 0));
      m.flyTo(new Vector3(0, 0, 0), { distance: 0, durationMs: 800, ...opts });
      return m.flightInfo?.durationMs ?? 0;
    };
    expect(duration(2, {})).toBe(800);
    expect(duration(0.1, { cloudRadius: R })).toBeCloseTo(scaledFlightDuration(800, 0.1, R), 9);
    expect(duration(1, { cloudRadius: R })).toBeCloseTo(800 * (0.8 + 0.25 * Math.log2(1 + 4)), 9);
    // 近い移動は基準より短く、遠い移動は長い。上下限に収まる
    expect(duration(0.01, { cloudRadius: R })).toBeLessThan(800);
    expect(duration(0.01, { cloudRadius: R })).toBeGreaterThanOrEqual(800 * 0.8 - 1e-9);
    expect(duration(3, { cloudRadius: R })).toBeGreaterThan(800 * 1.5);
    expect(duration(1e4, { cloudRadius: R })).toBeCloseTo(800 * 1.8, 9);
  });

  it('動きを減らす設定: 所要時間が 0.5 倍で、v0 を引き継がない', () => {
    const make = (reducedMotion: boolean) => {
      const m = new FlyMotion();
      m.setPose(new Vector3(0, 0, 1), new Vector3(0, 0, 0));
      run(m, 1, 1 / 60, input({ right: true }));
      m.flyTo(new Vector3(0, 0, -1), { distance: 0.1, durationMs: 800, cloudRadius: 1, reducedMotion });
      return m;
    };
    const normal = make(false);
    const reduced = make(true);
    expect(reduced.flightInfo?.durationMs).toBeCloseTo((normal.flightInfo?.durationMs ?? 0) * 0.5, 9);
    expect(reduced.flightInfo?.carriedSpeed).toBe(0);
    expect(normal.flightInfo?.carriedSpeed).toBeGreaterThan(0.1);
    // 引き継ぎがないので、最初の 1 歩の x の動きが、緩急だけの補間（目標は x=0 側）と一致する
    const start = reduced.position.clone();
    reduced.step(1e-3, createMoveInput());
    expect(Math.abs(reduced.position.x - start.x)).toBeLessThan(1e-3 * 0.01);
    // 動きを減らす設定で durationMs: 0 なら、そのまま即座に着く
    const z = new FlyMotion();
    z.flyTo(new Vector3(0, 0, -1), { distance: 0.1, durationMs: 0, reducedMotion: true });
    expect(z.isFlying).toBe(false);
  });

  it('刻み幅（1/240・1/60・1/30・0.1）を変えても、終わりの姿勢が一致する', () => {
    const run1 = (dt: number) => {
      const m = new FlyMotion();
      m.setPose(new Vector3(0.7, 0.3, 0.9), new Vector3(0, 0, 0));
      m.flyTo(new Vector3(-0.3, 0.2, -0.5), { distance: 0.04, durationMs: 800, cloudRadius: 1.1 });
      finish(m, dt);
      return m;
    };
    const ref = run1(1 / 240);
    for (const dt of [1 / 60, 1 / 30, 0.1]) {
      const m = run1(dt);
      expect(m.isFlying).toBe(false);
      expectClose(m.position, ref.position, 1e-9);
      expect(m.yaw).toBeCloseTo(ref.yaw, 9);
      expect(m.pitch).toBeCloseTo(ref.pitch, 9);
    }
  });

  it('flightInfo: 飛行中だけ値を持ち、進みが 0 → 1 に増える', () => {
    const m = new FlyMotion();
    expect(m.flightInfo).toBeNull();
    m.flyTo(new Vector3(0, 0, -1), { distance: 0.1, durationMs: 1000 });
    expect(m.flightInfo?.progress).toBe(0);
    m.step(0.1, createMoveInput());
    expect(m.flightInfo?.progress).toBeCloseTo(0.1, 12);
    expect(m.flightInfo?.durationMs).toBe(1000);
    finish(m);
    expect(m.flightInfo).toBeNull();
  });

  it('刻み幅によらず終了位置は同じ', () => {
    const a = new FlyMotion();
    const b = new FlyMotion();
    const t = new Vector3(0.4, -0.2, 0.3);
    a.flyTo(t, { distance: 0.02 });
    b.flyTo(t, { distance: 0.02 });
    finish(a, 1 / 60);
    finish(b, 1 / 30);
    expectClose(a.position, b.position, 1e-9);
  });

  it('durationMs が 0 なら次の入力を待たず即座に着く', () => {
    const m = new FlyMotion();
    m.flyTo(new Vector3(0, 0, -1), { distance: 0.1, durationMs: 0 });
    expect(m.isFlying).toBe(false);
    expect(m.position.z).toBeCloseTo(-0.9, 12);
  });

  it('ヨーは最短回りで回る', () => {
    const m = new FlyMotion();
    m.rotateBy(deg(170), 0);
    // 背後（+Z 側）から -Z 方向の対象を見る → 終端ヨーは約 -170° 側ではなく 0
    m.flyTo(new Vector3(0, 0, -1), { distance: 0.1, durationMs: 600 });
    m.step(0.1, createMoveInput());
    // 170° → 0° の最短は減る向き。-170° 側へ回り込んでいない
    expect(m.yaw).toBeLessThan(deg(170));
    expect(m.yaw).toBeGreaterThan(0);
  });

  it('カメラが対象と重なっていても有限の位置へ着く', () => {
    const m = new FlyMotion();
    m.flyTo(new Vector3(0, 0, 0), { distance: 0.1, durationMs: 0 });
    expect(m.position.distanceTo(new Vector3())).toBeCloseTo(0.1, 12);
    expect(Number.isFinite(m.yaw) && Number.isFinite(m.pitch)).toBe(true);
  });

  it('真上・真下から近づくときピッチは ±89° に丸まる', () => {
    const m = new FlyMotion();
    m.setPose(new Vector3(0, 1, 0), new Vector3(0, 0, -1));
    m.flyTo(new Vector3(0, 0, 0), { distance: 0.1, durationMs: 0 });
    expect(m.pitch).toBe(-MAX_PITCH);
  });

  it('キー入力で中断し、その場から通常の移動に戻る', () => {
    const m = new FlyMotion();
    m.flyTo(new Vector3(0, 0, -1), { distance: 0.1 });
    for (let i = 0; i < 10; i++) m.step(1 / 60, createMoveInput());
    const mid = m.position.clone();
    expect(m.isFlying).toBe(true);
    m.step(1 / 60, input({ right: true }));
    expect(m.isFlying).toBe(false);
    // 中断後は飛行の続きではなく、右へ動き始める
    for (let i = 0; i < 30; i++) m.step(1 / 60, input({ right: true }));
    expect(m.position.x).toBeGreaterThan(mid.x);
    expect(m.position.z).toBeGreaterThan(-0.9);
  });

  it('視点操作（rotateBy）・setPose でも中断する。0 の回転は中断しない', () => {
    const m = new FlyMotion();
    m.flyTo(new Vector3(0, 0, -1));
    m.rotateBy(0, 0);
    expect(m.isFlying).toBe(true);
    m.rotateBy(0.01, 0);
    expect(m.isFlying).toBe(false);

    m.flyTo(new Vector3(0, 0, -1));
    m.setPose(new Vector3(), new Vector3(1, 0, 0));
    expect(m.isFlying).toBe(false);
  });

  it('ホイール（速度変更）では中断しない', () => {
    const m = new FlyMotion();
    m.flyTo(new Vector3(0, 0, -1));
    m.applyWheel(-1);
    expect(m.isFlying).toBe(true);
  });

  it('飛行中の step は動いたと報告する', () => {
    const m = new FlyMotion();
    m.flyTo(new Vector3(0, 0, -1));
    expect(m.step(1 / 60, createMoveInput())).toBe(true);
  });
});

describe('FlyMotion: flyTo の速度の引き継ぎ（行き過ぎない・引き返さない）', () => {
  const STOP = 0.03;
  const R = 1.2;
  const U = new Vector3(0, 0, -1); // 進む方向（S → E）

  /** 原点から -Z へ距離 L の終点へ飛ぶ。v0 は進む方向から angle だけ傾けた、大きさ speed の速度。 */
  function start(L: number, speed: number, angle: number, opts: { reducedMotion?: boolean } = {}): { m: FlyMotion; v0: Vector3; E: Vector3 } {
    const m = new FlyMotion();
    m.setPose(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
    // 真横（90°）は、進む方向の成分を正確に 0 にする（cos の丸めで、わずかに近づく向きにならないように）
    const c = Math.abs(Math.cos(angle)) < 1e-12 ? 0 : Math.cos(angle);
    const v0 = new Vector3(speed * Math.sin(angle), 0, -speed * c);
    m.velocity.copy(v0);
    m.flyTo(new Vector3(0, 0, -(L + STOP)), { distance: STOP, durationMs: 600, cloudRadius: R, ...opts });
    return { m, v0, E: new Vector3(0, 0, -L) };
  }

  const Ls = [0.02, 0.05, 0.1, 0.3, 1, 3];
  const speeds = [0, 0.3, 0.8, 1.4, 2];
  const angles = [0, 30, 60, 85, 90, 95, 120, 150, 180].map(deg);

  it('L・v0 の大きさ・向きを振った格子のすべてで: 飛び始めの速度が v0（連続）、終点を越えず、引き返さず、終わりは目標で速度 0', () => {
    for (const L of Ls) {
      for (const speed of speeds) {
        for (const angle of angles) {
          const { m, v0, E } = start(L, speed, angle);
          const info = m.flightInfo!;
          const T = info.durationMs / 1000;
          // 引き継いだ速さ（飛び始めの速さ）は、上限を超えても v0 のまま（超えた分は指数で減らす項で引き継ぐ）
          expect(info.carriedSpeed).toBeCloseTo(speed, 12);
          // 飛び始めの速度: 位置の式の時間微分が v0 に一致し、ごく短い 1 歩の差分も v0 に一致する
          expect(m.currentVelocity(new Vector3()).distanceTo(v0)).toBeLessThan(1e-12);
          const p0 = m.position.clone();
          const h = 1e-8;
          m.step(h, createMoveInput());
          const vStart = m.position.clone().sub(p0).divideScalar(h);
          expect(vStart.distanceTo(v0)).toBeLessThan(1e-4 * speed + 1e-5 * (1 + L / T));

          let prevD = m.position.distanceTo(E);
          let approaching = false;
          let prevSpeed = 0;
          for (let i = 0; i < 2000 && m.isFlying; i++) {
            const before = m.position.clone();
            m.step(1 / 240, createMoveInput());
            // 進む方向の成分は、終点を越えない（止まる距離の手前で止まり、点を通り越さない）
            expect(m.position.dot(U)).toBeLessThanOrEqual(L + 1e-12);
            const d = m.position.distanceTo(E);
            // 引き返さない: 近づき始めたら、離れない
            if (approaching) expect(d).toBeLessThanOrEqual(prevD + 1e-12);
            if (d < prevD - 1e-12) approaching = true;
            prevD = d;
            prevSpeed = m.position.distanceTo(before) * 240;
          }
          expect(m.isFlying).toBe(false);
          expect(m.position.distanceTo(E)).toBeLessThan(1e-12);
          expect(m.yaw).toBeCloseTo(0, 9);
          expect(m.pitch).toBeCloseTo(0, 9);
          expect(m.velocity.length()).toBe(0);
          expect(prevSpeed).toBeLessThan(0.02 * (L / T) + 0.01 * speed + 1e-9); // 終わりの直前の速さは 0 へ向かう
        }
      }
    }
  });

  it('終点へ近づく向きの v0（進む方向となす角が 90° 未満）では、終点までの距離が始めから単調に縮む', () => {
    for (const L of Ls) {
      for (const speed of speeds) {
        for (const angle of angles.filter((a) => a < deg(90))) {
          const { m, E } = start(L, speed, angle);
          let prevD = m.position.distanceTo(E);
          while (m.isFlying) {
            m.step(1 / 240, createMoveInput());
            const d = m.position.distanceTo(E);
            expect(d).toBeLessThanOrEqual(prevD + 1e-12);
            prevD = d;
          }
        }
      }
    }
  });

  it('横向きの膨らみは、引き継ぎの項 c × max g ≈ 0.279 と、超えた分の項 0.4 を足した、移動の距離の 0.68 倍まで', () => {
    const carryBound = FLIGHT_CARRY_LIMIT * flightCarry(0.2);
    expect(carryBound).toBeCloseTo(3.4 * 0.08192, 9);
    const bound = carryBound + FLIGHT_EXCESS_LIMIT;
    let worst = 0;
    let worstCarryOnly = 0;
    for (const L of Ls) {
      for (const speed of speeds) {
        for (const angle of angles) {
          const { m } = start(L, speed, angle);
          const T = m.flightInfo!.durationMs / 1000;
          const carryOnly = T * speed <= FLIGHT_CARRY_LIMIT * L;
          while (m.isFlying) {
            m.step(1 / 240, createMoveInput());
            const bulge = Math.hypot(m.position.x, m.position.y) / L;
            worst = Math.max(worst, bulge);
            if (carryOnly) worstCarryOnly = Math.max(worstCarryOnly, bulge);
          }
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(bound + 1e-9);
    expect(worstCarryOnly).toBeLessThanOrEqual(carryBound + 1e-9); // 上限の範囲では、引き継ぎの項だけの膨らみ
    expect(worst).toBeGreaterThan(carryBound); // 速い横向きの v0 では、超えた分の項のぶん、さらに膨らむ
  });

  it('飛び始めの前後で速さが連続する: 速い滑走から近い点へ飛んでも、最初の 1 フレーム（1/60 秒）の平均の速さが急に落ちない', () => {
    // 1.8 単位/秒の滑走から距離 0.05 の前方の点へ（上限で切っていたときは、最初の 1 フレームで約 0.11〜0.14 倍に落ちた）
    for (const [L, speed, minRatio] of [[0.05, 1.8, 0.6], [0.1, 1.8, 0.8], [0.02, 2, 0.25], [0.3, 2, 0.9]] as const) {
      const { m } = start(L, speed, 0);
      const p0 = m.position.clone();
      m.step(1 / 60, createMoveInput());
      const ratio = (m.position.distanceTo(p0) * 60) / speed;
      expect(ratio).toBeGreaterThan(minRatio);
      expect(ratio).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('速い滑走（v0 1.8）から近い点（L 0.05）へ飛んでも、点の手前で止まり、通り越して戻らない', () => {
    const { m, E } = start(0.05, 1.8, 0);
    const target = new Vector3(0, 0, -(0.05 + STOP));
    let minToTarget = Infinity;
    while (m.isFlying) {
      m.step(1 / 60, createMoveInput());
      minToTarget = Math.min(minToTarget, m.position.distanceTo(target));
    }
    expect(minToTarget).toBeGreaterThanOrEqual(STOP - 1e-12);
    expect(m.position.distanceTo(E)).toBeLessThan(1e-12);
  });

  it('刻み幅（dt）を変えても、途中と終わりの姿勢が一致する', () => {
    for (const [L, speed, angle] of [[0.05, 1.8, 0], [0.02, 2, deg(30)], [0.3, 1, deg(90)], [0.05, 2, deg(120)], [1, 2, deg(150)]] as const) {
      const a = start(L, speed, angle).m;
      const b = start(L, speed, angle).m;
      run(a, 0.3, 1 / 30, createMoveInput());
      run(b, 0.3, 1 / 240, createMoveInput());
      expectClose(a.position, b.position, 1e-12);
      expect(a.yaw).toBeCloseTo(b.yaw, 12);
      run(a, 2, 1 / 30, createMoveInput());
      run(b, 2, 1 / 240, createMoveInput());
      expect(a.isFlying || b.isFlying).toBe(false);
      expectClose(a.position, b.position, 1e-12);
      expect(a.yaw).toBeCloseTo(b.yaw, 12);
      expect(a.pitch).toBeCloseTo(b.pitch, 12);
    }
  });
});

describe('FlyMotion: 自動移動の途中の操作（速度を引き継いで中断する）', () => {
  /** 原点から -Z へ 1 の移動を始め、速さの山（t ≈ 1/3）まで進める。そのときの移動の速度を返す。 */
  function midFlight(reducedMotion = false): { m: FlyMotion; v: Vector3 } {
    const m = new FlyMotion({ speed: 0.3 });
    m.setPose(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
    m.flyTo(new Vector3(0, 0, -1.03), { distance: 0.03, durationMs: 600, reducedMotion });
    const T = m.flightInfo!.durationMs / 1000;
    run(m, T / 3, T / 60, createMoveInput());
    expect(m.isFlying).toBe(true);
    return { m, v: m.currentVelocity(new Vector3()) };
  }

  /** 1 歩の平均の速さ（位置の差 / dt）。 */
  function stepSpeed(m: FlyMotion, dt: number, inp: MoveInput): number {
    const before = m.position.clone();
    m.step(dt, inp);
    return m.position.distanceTo(before) / dt;
  }

  it('移動キーを押すと中断し、その瞬間の速度から加速へつながる（速さが急に 0 にならない）', () => {
    const { m, v } = midFlight();
    const speed = v.length();
    expect(speed).toBeGreaterThan(2); // 山の速さ（平均の約 1.8 倍）
    const dt = 1 / 60;
    const s1 = stepSpeed(m, dt, input({ forward: true }));
    expect(m.isFlying).toBe(false);
    // 加速の時定数 0.15 秒で目標（0.3）へ向かう: 1 フレームでは e^(−dt/0.15) ≈ 0.89 しか減らない
    const decay = Math.exp(-dt / DEFAULT_ACCEL_TIME_CONSTANT);
    expect(s1).toBeGreaterThan(speed * decay * 0.95);
    expect(m.velocity.length()).toBeCloseTo(0.3 + (speed - 0.3) * decay, 6);
    // 速度の向きは、飛行の速度の向きのまま（前へ）
    expect(m.velocity.clone().normalize().dot(v.clone().normalize())).toBeGreaterThan(0.999);
    // その後は目標速度へ落ち着く
    run(m, 1.5, dt, input({ forward: true }));
    expect(m.velocity.length()).toBeCloseTo(0.3, 3);
  });

  it('ドラッグ（rotateBy）で中断すると、その瞬間の速度で滑走へつながる', () => {
    const { m, v } = midFlight();
    const speed = v.length();
    m.rotateBy(0.01, 0);
    expect(m.isFlying).toBe(false);
    expectClose(m.velocity, v, 1e-12);
    const dt = 1 / 60;
    const s1 = stepSpeed(m, dt, createMoveInput());
    expect(m.isGliding).toBe(true);
    expect(s1).toBeGreaterThan(speed * Math.exp(-dt / DEFAULT_GLIDE_TIME_CONSTANT));
    expect(m.velocity.length()).toBeCloseTo(speed * Math.exp(-dt / DEFAULT_GLIDE_TIME_CONSTANT), 9);
    // 滑走はやがて止まる
    run(m, 5, dt, createMoveInput());
    expect(m.velocity.length()).toBe(0);
    expect(m.isGliding).toBe(false);
  });

  it('動きを減らす設定で始めた移動は、中断するとその場で止まる', () => {
    {
      const { m } = midFlight(true);
      m.rotateBy(0.01, 0);
      expect(m.isFlying).toBe(false);
      expect(m.velocity.length()).toBe(0);
      const before = m.position.clone();
      m.step(1 / 60, createMoveInput());
      expect(m.position.distanceTo(before)).toBe(0);
    }
    {
      const { m } = midFlight(true);
      m.step(1 / 60, input({ forward: true }));
      expect(m.isFlying).toBe(false);
      // 速度 0 から加速する（1 フレームで目標 0.3 の 1 − e^(−dt/0.15) 程度）
      expect(m.velocity.length()).toBeCloseTo(0.3 * (1 - Math.exp(-1 / 60 / DEFAULT_ACCEL_TIME_CONSTANT)), 9);
    }
  });
});

describe('FlyMotion: step の戻り値', () => {
  it('入力も慣性も無ければ false、視点を回した次の step は true', () => {
    const m = new FlyMotion();
    expect(m.step(1 / 60, createMoveInput())).toBe(false);
    m.rotateBy(0.1, 0);
    expect(m.step(1 / 60, createMoveInput())).toBe(true);
    expect(m.step(1 / 60, createMoveInput())).toBe(false);
  });
});

describe('FlyMotion: speedScale', () => {
  const noInertia = (o: object = {}) => new FlyMotion({ accelTimeConstant: 0, glideTimeConstant: 0, ...o });

  it('既定は 1（係数なしと同じ動き）', () => {
    expect(new FlyMotion().speedScale).toBe(1);
    const a = noInertia();
    const b = noInertia({ speedScale: 1 });
    run(a, 1, 1 / 60, input({ forward: true }));
    run(b, 1, 1 / 60, input({ forward: true }));
    expect(b.position.distanceTo(a.position)).toBe(0);
  });

  it('実際の移動速度にだけ掛かり、speed は変わらない', () => {
    const base = noInertia();
    const m = noInertia();
    m.speedScale = 0.25;
    expect(m.speed).toBe(0.45);
    run(base, 1, 1 / 60, input({ forward: true }));
    run(m, 1, 1 / 60, input({ forward: true }));
    expect(m.position.length() / base.position.length()).toBeCloseTo(0.25, 9);
    expect(m.speed).toBe(0.45);
  });

  it('コンストラクタのオプションで指定できる', () => {
    const m = noInertia({ speedScale: 4 });
    expect(m.speedScale).toBe(4);
    run(m, 1, 1 / 60, input({ forward: true }));
    expect(m.position.length()).toBeCloseTo(0.45 * 4, 9);
  });

  it('minSpeed・maxSpeed の制限は speed にだけ働き、係数は制限を越えて効く', () => {
    const m = noInertia({ speed: 2, maxSpeed: 2, speedScale: 3 });
    expect(m.speed).toBe(2);
    run(m, 1, 1 / 60, input({ forward: true }));
    expect(m.position.length()).toBeCloseTo(6, 9); // maxSpeed 2 × 3
    const slow = noInertia({ speed: 0.005, speedScale: 0.1 });
    run(slow, 1, 1 / 60, input({ forward: true }));
    expect(slow.position.length()).toBeCloseTo(0.0005, 12); // minSpeed 0.005 × 0.1
  });

  it('ホイールによる速度変更は係数を変えず、係数は speed の変化に掛かり続ける', () => {
    const m = noInertia({ speedScale: 0.5 });
    m.applyWheel(-1);
    expect(m.speedScale).toBe(0.5);
    expect(m.speed).toBeCloseTo(0.495, 12);
    run(m, 1, 1 / 60, input({ forward: true }));
    expect(m.position.length()).toBeCloseTo(0.495 * 0.5, 9);
  });

  it('慣性ありのとき、係数の変更は速度へ指数的に反映される', () => {
    const m = new FlyMotion({ accelTimeConstant: 0.12, glideTimeConstant: 0.12 });
    run(m, 2, 1 / 60, input({ forward: true }));
    expect(m.velocity.length()).toBeCloseTo(0.45, 6);
    m.speedScale = 2;
    run(m, 2, 1 / 60, input({ forward: true }));
    expect(m.velocity.length()).toBeCloseTo(0.9, 6);
  });

  it('正の有限値以外は無視し、直前の値を保つ', () => {
    const m = new FlyMotion();
    m.speedScale = 2;
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      m.speedScale = bad;
      expect(m.speedScale, String(bad)).toBe(2);
    }
    expect(new FlyMotion({ speedScale: NaN }).speedScale).toBe(1);
    expect(new FlyMotion({ speedScale: 0 }).speedScale).toBe(1);
  });
});

describe('FlyMotion: 不正な dt', () => {
  it('NaN・負・無限大の dt は状態を変えずに false を返す', () => {
    for (const bad of [NaN, -1, -1e-9, Infinity, -Infinity]) {
      const m = new FlyMotion();
      run(m, 0.3, 1 / 60, input({ forward: true }));
      const pos = m.position.clone();
      const vel = m.velocity.clone();
      const yaw = m.yaw;
      expect(m.step(bad, input({ forward: true })), String(bad)).toBe(false);
      expect(m.position.distanceTo(pos), String(bad)).toBe(0);
      expect(m.velocity.distanceTo(vel), String(bad)).toBe(0);
      expect(m.yaw).toBe(yaw);
      expect(Number.isFinite(m.position.x + m.position.y + m.position.z)).toBe(true);
    }
  });

  it('不正な dt のあとも通常どおり動く（同じ入力なら呼ばなかった場合と同じ位置に着く）', () => {
    const a = new FlyMotion();
    const b = new FlyMotion();
    run(a, 0.5, 1 / 60, input({ forward: true }));
    run(b, 0.25, 1 / 60, input({ forward: true }));
    b.step(NaN, input({ forward: true }));
    b.step(-1, input({ forward: true }));
    run(b, 0.25, 1 / 60, input({ forward: true }));
    expect(b.position.distanceTo(a.position)).toBeLessThan(1e-12);
  });

  it('飛行は進まず、未報告の姿勢変化も失われない', () => {
    const m = new FlyMotion();
    m.flyTo(new Vector3(0, 0, -1), { distance: 0.1 });
    expect(m.step(NaN, createMoveInput())).toBe(false);
    expect(m.isFlying).toBe(true);
    expect(m.position.length()).toBe(0);
    m.cancelFlyTo();

    const r = new FlyMotion();
    r.rotateBy(0.2, 0);
    expect(r.step(-1, createMoveInput())).toBe(false);
    expect(r.step(1 / 60, createMoveInput())).toBe(true); // 回転は次の有効な step で報告される
  });

  it('dt が 0 は不正ではない', () => {
    const m = new FlyMotion();
    m.rotateBy(0.2, 0);
    expect(m.step(0, createMoveInput())).toBe(true);
  });
});

describe('FlyMotion: 滑走（加速と滑走の時定数）', () => {
  const S = 0.45;
  const TAU_A = DEFAULT_ACCEL_TIME_CONSTANT;
  const TAU_R = DEFAULT_GLIDE_TIME_CONSTANT;
  const DTS = [1 / 120, 1 / 60, 1 / 30, 0.1];

  /** 最高速（基準速度 × speedScale）に達してから離す。位置は離した点を原点とする。 */
  function cruising(options: ConstructorParameters<typeof FlyMotion>[0] = {}): FlyMotion {
    const m = new FlyMotion(options);
    run(m, 4, 1 / 60, input({ forward: true }));
    expect(m.velocity.length()).toBeCloseTo(m.speed * m.speedScale, 9);
    m.position.set(0, 0, 0);
    return m;
  }

  it('既定の時定数は、加速 0.15 秒・滑走 0.5 秒', () => {
    const m = new FlyMotion();
    expect(m.accelTimeConstant).toBe(0.15);
    expect(m.glideTimeConstant).toBe(0.5);
  });

  it('入力があるときは τa で目標速度へ近づく', () => {
    const m = new FlyMotion();
    run(m, TAU_A, 1 / 120, input({ forward: true }));
    expect(m.velocity.length() / S).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  it('キーを離すと τr で減り、滑る距離は解析解（v·τr·(1 − e^(−t/τr))）に一致する', () => {
    const m = cruising();
    run(m, TAU_R, 1 / 120, createMoveInput());
    expect(m.velocity.length() / S).toBeCloseTo(Math.exp(-1), 6);
    expect(-m.position.z).toBeCloseTo(S * TAU_R * (1 - Math.exp(-1)), 6);
    expect(m.isGliding).toBe(true);
  });

  it('止まるまでの総距離は v·τr から、止まる閾値の分（v·0.03·τr）を引いた値', () => {
    const m = cruising();
    run(m, 3, 1 / 60, createMoveInput());
    expect(m.velocity.length()).toBe(0);
    expect(-m.position.z).toBeCloseTo(S * TAU_R * (1 - GLIDE_STOP_RATIO), 9);
    // v·τr（滑り切ったときの距離）の 97%
    expect(-m.position.z / (S * TAU_R)).toBeGreaterThan(0.96);
    expect(-m.position.z / (S * TAU_R)).toBeLessThan(1);
  });

  it('刻み幅（1/120・1/60・1/30・0.1 秒）に依らず、滑る位置・停止の位置が同じ', () => {
    const midway = DTS.map((dt) => {
      const m = cruising();
      run(m, 0.5, dt, createMoveInput());
      return m.position.clone();
    });
    const final = DTS.map((dt) => {
      const m = cruising();
      run(m, 3, dt, createMoveInput());
      return m.position.clone();
    });
    for (const p of midway) expectClose(p, midway[0]!, 1e-9);
    for (const p of final) expectClose(p, final[0]!, 1e-9);
  });

  it('加速から滑走までを通しても、刻み幅に依らず同じ位置・同じ停止', () => {
    const run1 = (dt: number) => {
      const m = new FlyMotion();
      run(m, 0.6, dt, input({ forward: true }));
      run(m, 0.3, dt, createMoveInput());
      run(m, 0.4, dt, input({ right: true }));
      run(m, 3, dt, createMoveInput());
      return m;
    };
    const ref = run1(1 / 120);
    for (const dt of DTS) {
      const m = run1(dt);
      expectClose(m.position, ref.position, 1e-9);
      expect(m.velocity.length()).toBe(0);
    }
  });

  it('逆向きのキーでは τa で止まる（滑走より早い）', () => {
    const rev = cruising();
    // 前進（−Z）の最高速から後退へ。v_z(t) = S − 2S·e^(−t/τa)。τa のとき S·(1 − 2/e)
    run(rev, TAU_A, 1 / 120, input({ backward: true }));
    expect(rev.velocity.z / S).toBeCloseTo(1 - 2 / Math.E, 6);
    // 速度が 0 を横切る時刻は τa·ln2 ≈ 0.104 秒
    const m = cruising();
    let t = 0;
    while (m.velocity.z <= 0 && t < 1) {
      m.step(1 / 600, input({ backward: true }));
      t += 1 / 600;
    }
    expect(t).toBeCloseTo(TAU_A * Math.LN2, 2);
    // 同じ時間で、キーを離しただけの滑走はまだ最高速の 80% 以上で進んでいる
    const glide = cruising();
    run(glide, TAU_A * Math.LN2, 1 / 600, createMoveInput());
    expect(glide.velocity.length() / S).toBeGreaterThan(0.8);
  });

  it('滑走中に別のキーを押すと、そこから τa で新しい向きへ近づく', () => {
    const m = cruising();
    run(m, 0.2, 1 / 60, createMoveInput());
    const v0 = m.velocity.clone();
    m.step(1 / 60, input({ right: true }));
    expect(m.isGliding).toBe(false);
    expect(m.velocity.x).toBeGreaterThan(0);
    expect(Math.abs(m.velocity.z)).toBeLessThan(Math.abs(v0.z)); // 前進の速度は τa で目標（0）へ向かう
  });

  it('滑走は、最高速から約 2 秒以内に止まる', () => {
    for (const dt of DTS) {
      const m = cruising();
      let t = 0;
      while (m.velocity.lengthSq() > 0 && t < 5) {
        m.step(dt, createMoveInput());
        t += dt;
      }
      expect(t, `dt ${dt}`).toBeLessThanOrEqual(2 + dt);
      expect(t, `dt ${dt}`).toBeGreaterThan(1.5);
      expect(m.velocity.length()).toBe(0);
      expect(m.isGliding).toBe(false);
      expect(m.step(dt, createMoveInput())).toBe(false);
    }
  });

  it('停止の閾値は、基準速度 × speedScale × 0.03', () => {
    const m = cruising({ speed: 0.2, speedScale: 0.5 }); // 実効 0.1。閾値 0.003
    let last = 0;
    while (m.velocity.lengthSq() > 0) {
      last = m.velocity.length();
      m.step(1 / 600, createMoveInput());
    }
    expect(last).toBeGreaterThanOrEqual(0.1 * GLIDE_STOP_RATIO);
    expect(last).toBeLessThan(0.1 * GLIDE_STOP_RATIO * 1.02);
  });

  it('入力がないとき speedScale が下がると、残りの速度も同じ割合で下がる', () => {
    const m = cruising();
    const before = m.velocity.length();
    m.speedScale = 0.25;
    m.step(0, createMoveInput());
    expect(m.velocity.length() / before).toBeCloseTo(0.25, 12);
    // さらに 0.25 → 0.1 は 0.4 倍
    m.speedScale = 0.1;
    m.step(0, createMoveInput());
    expect(m.velocity.length() / before).toBeCloseTo(0.1, 12);
  });

  it('speedScale が段階的に下がっても、割合の積は同じ（一度に下げた場合と同じ）', () => {
    const a = cruising();
    const b = cruising();
    a.speedScale = 0.2;
    a.step(0, createMoveInput());
    for (const sc of [0.8, 0.5, 0.3, 0.2]) {
      b.speedScale = sc;
      b.step(0, createMoveInput());
    }
    expect(b.velocity.length()).toBeCloseTo(a.velocity.length(), 12);
  });

  it('speedScale が上がっても残りの速度は増えない。入力があるときは速度を直接は変えない（τa で近づく）', () => {
    const m = cruising();
    const before = m.velocity.length();
    m.speedScale = 4;
    m.step(0, createMoveInput());
    expect(m.velocity.length()).toBe(before);

    const k = cruising();
    k.speedScale = 0.25;
    k.step(0, input({ forward: true }));
    expect(k.velocity.length()).toBeCloseTo(S, 9);
    run(k, 1, 1 / 60, input({ forward: true }));
    expect(k.velocity.length()).toBeCloseTo(S * 0.25, 2);
  });

  it('滑走中に下がった speedScale の分、滑る距離も縮む', () => {
    const plain = cruising();
    run(plain, 3, 1 / 60, createMoveInput());
    const slowed = cruising();
    slowed.speedScale = 0.5;
    run(slowed, 3, 1 / 60, createMoveInput());
    // 速度が半分、閾値も半分なので、総距離も半分
    expect(slowed.position.length() / plain.position.length()).toBeCloseTo(0.5, 9);
  });

  it('時定数 0 以下は慣性なし（キーを離すと滑らずに止まる）', () => {
    const m = cruising({ glideTimeConstant: 0 });
    m.step(1 / 60, createMoveInput());
    expect(m.velocity.length()).toBe(0);
    expect(m.position.length()).toBe(0);
    expect(m.isGliding).toBe(false);
  });

  it('停止するステップも、位置が進んでいるので moved を返し、そのあとは false', () => {
    const m = cruising();
    let reported = 0;
    let lastPos = m.position.clone();
    for (let i = 0; i < 600; i++) {
      const moved = m.step(1 / 60, createMoveInput());
      // moved が false のステップでは位置が変わっていない（カメラへ反映されない移動がない）
      if (!moved) expect(m.position.distanceTo(lastPos)).toBe(0);
      else reported++;
      lastPos = m.position.clone();
    }
    expect(reported).toBeGreaterThan(60);
    expect(m.velocity.length()).toBe(0);
  });

  it('flyTo・setPose・stop は滑走を終える', () => {
    const a = cruising();
    a.step(1 / 60, createMoveInput());
    expect(a.isGliding).toBe(true);
    a.setPose(new Vector3(), new Vector3(0, 0, -1));
    expect(a.isGliding).toBe(false);
    const b = cruising();
    b.step(1 / 60, createMoveInput());
    b.stop();
    expect(b.isGliding).toBe(false);
    expect(b.velocity.length()).toBe(0);
    const c = cruising();
    c.step(1 / 60, createMoveInput());
    c.flyTo(new Vector3(0, 0, -1));
    expect(c.isGliding).toBe(false);
  });
});
