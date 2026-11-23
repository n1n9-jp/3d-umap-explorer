import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FlyMotion, MAX_PITCH, createMoveInput, easeOutQuart } from './FlyMotion';
import type { MoveInput } from './FlyMotion';

const deg = (d: number) => (d * Math.PI) / 180;

function input(patch: Partial<MoveInput>): MoveInput {
  return { ...createMoveInput(), ...patch };
}

/** `seconds` を `dt` 刻みで積分する。 */
function run(m: FlyMotion, seconds: number, dt: number, inp: MoveInput): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) m.step(dt, inp);
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
    const a = new FlyMotion({ timeConstant: 0 });
    const b = new FlyMotion({ timeConstant: 0 });
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
    const m = new FlyMotion({ timeConstant: 0 });
    run(m, 1, 1 / 60, input({ forward: true }));
    expect(m.position.length()).toBeCloseTo(0.45, 9);
    expect(Object.keys(createMoveInput()).sort()).toEqual(['backward', 'down', 'forward', 'left', 'right', 'up']);
    expect('boostFactor' in m).toBe(false);
  });

  it('速度は時定数 τ で目標へ指数的に近づく', () => {
    const m = new FlyMotion({ speed: 0.15, timeConstant: 0.12 });
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

  it('ease-out quartic: 中間点で進行率 1-(1-t)^4', () => {
    expect(easeOutQuart(0)).toBe(0);
    expect(easeOutQuart(1)).toBe(1);
    expect(easeOutQuart(0.5)).toBeCloseTo(1 - 0.5 ** 4, 12);

    const m = new FlyMotion();
    m.flyTo(new Vector3(0, 0, -1), { distance: 0, durationMs: 1000 });
    m.step(0.1, createMoveInput());
    expect(m.position.z).toBeCloseTo(-easeOutQuart(0.1), 12);
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
  const noInertia = (o: object = {}) => new FlyMotion({ timeConstant: 0, ...o });

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
    const m = new FlyMotion({ timeConstant: 0.12 });
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
