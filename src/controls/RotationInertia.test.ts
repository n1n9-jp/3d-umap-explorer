import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INERTIA_MAX_SPEED,
  DEFAULT_INERTIA_STOP_SPEED,
  DEFAULT_INERTIA_TIME_CONSTANT,
  DragVelocityTracker,
  prefersReducedMotion,
  RotationInertia,
} from './RotationInertia';

/** 1 秒あたり `vx` ピクセルの速さで `ms` ミリ秒ドラッグした標本を、16 ミリ秒ごとに流す。最後の時刻を返す。 */
function dragAt(tracker: DragVelocityTracker, vx: number, ms: number, startT = 1000, vy = 0): number {
  tracker.begin(100, 100, startT);
  let t = startT;
  let x = 100;
  let y = 100;
  while (t < startT + ms) {
    t += 16;
    x += (vx * 16) / 1000;
    y += (vy * 16) / 1000;
    tracker.move(x, y, t);
  }
  return t;
}

describe('DragVelocityTracker: 離したときのポインタの速さ', () => {
  it('一定の速さで動かして離すと、その速さが求まる', () => {
    const tracker = new DragVelocityTracker();
    const t = dragAt(tracker, 1000, 300);
    const v = tracker.release(t)!;
    expect(v.vx).toBeCloseTo(1000, -1);
    expect(v.vy).toBeCloseTo(0, 6);
  });

  it('縦横の速さを別々に求める（左上へ動かすと負）', () => {
    const tracker = new DragVelocityTracker();
    const t = dragAt(tracker, -600, 300, 0, -300);
    const v = tracker.release(t)!;
    expect(v.vx).toBeCloseTo(-600, -1);
    expect(v.vy).toBeCloseTo(-300, -1);
  });

  it('速く動かしたあと、ポインタを止めて窓（90 ミリ秒）より長く待ってから離すと、速さは 0', () => {
    const tracker = new DragVelocityTracker();
    const t = dragAt(tracker, 2000, 300);
    const v = tracker.release(t + 200)!;
    expect(Math.hypot(v.vx, v.vy)).toBe(0);
  });

  it('離す直前の 90 ミリ秒の動きだけを使う（前半が速く、後半が止まりかけ）', () => {
    const tracker = new DragVelocityTracker();
    tracker.begin(0, 0, 0);
    let x = 0;
    let t = 0;
    for (let i = 0; i < 10; i++) {
      t += 16;
      x += 32; // 2000 px/s
      tracker.move(x, 0, t);
    }
    for (let i = 0; i < 6; i++) {
      t += 16;
      x += 0.8; // 50 px/s
      tracker.move(x, 0, t);
    }
    const v = tracker.release(t)!;
    expect(v.vx).toBeLessThan(700); // 全体の平均（約 1300）ではなく、直近の動き
  });

  it('1 回の移動イベントが長い区間の動きをまとめて運んできても、動いた速さを過大に見積もらない', () => {
    const tracker = new DragVelocityTracker();
    tracker.begin(0, 0, 0);
    tracker.move(100, 0, 200); // 200 ミリ秒の間に 100 ピクセル = 500 px/s
    const v = tracker.release(200)!;
    expect(v.vx).toBeCloseTo(500, 0);
  });

  it('動かさずに離したクリックは null（慣性が始まらない）', () => {
    const tracker = new DragVelocityTracker();
    tracker.begin(50, 50, 0);
    expect(tracker.release(80)).toBeNull();
  });

  it('押した位置から 4 ピクセル以内の動きしかなかった押下は、速くても null', () => {
    const tracker = new DragVelocityTracker();
    tracker.begin(50, 50, 0);
    tracker.move(52, 51, 10);
    tracker.move(53, 52, 20);
    expect(tracker.release(20)).toBeNull();
    // 4 ピクセルを超えれば、ドラッグとして速さを返す
    tracker.begin(50, 50, 0);
    tracker.move(56, 50, 10);
    expect(tracker.release(10)).not.toBeNull();
  });

  it('時刻が逆戻りしても、0 除算や NaN にならない', () => {
    const tracker = new DragVelocityTracker();
    tracker.begin(0, 0, 100);
    tracker.move(30, 0, 90);
    tracker.move(60, 0, 100);
    const v = tracker.release(100)!;
    expect(Number.isFinite(v.vx)).toBe(true);
    expect(Number.isFinite(v.vy)).toBe(true);
  });

  it('release のあと、次の begin までは何も覚えていない', () => {
    const tracker = new DragVelocityTracker();
    const t = dragAt(tracker, 1000, 200);
    tracker.release(t);
    expect(tracker.release(t)).toBeNull();
  });

  it('cancel のあとの release は null', () => {
    const tracker = new DragVelocityTracker();
    const t = dragAt(tracker, 1000, 200);
    tracker.cancel();
    expect(tracker.release(t)).toBeNull();
  });
});

describe('RotationInertia: 積分', () => {
  const total = (inertia: RotationInertia, seconds: number, dt: number) => {
    let yaw = 0;
    let pitch = 0;
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      if (inertia.step(dt)) {
        yaw += inertia.dYaw;
        pitch += inertia.dPitch;
      }
    }
    return { yaw, pitch };
  };

  it('総回転量は解析解 v0·τ·(1 − e^(−T/τ)) に一致する', () => {
    const inertia = new RotationInertia({ timeConstant: 0.3 });
    inertia.start(2, -1);
    const { yaw, pitch } = total(inertia, 0.6, 1 / 60);
    const k = 0.3 * (1 - Math.exp(-0.6 / 0.3));
    expect(yaw).toBeCloseTo(2 * k, 9);
    expect(pitch).toBeCloseTo(-1 * k, 9);
  });

  it('フレームレートによらず、総回転量が同じ（1/60 秒刻みと 1/30 秒刻み、不揃いな刻み）', () => {
    const run = (dts: number[]) => {
      const inertia = new RotationInertia({ timeConstant: 0.3 });
      inertia.start(3, 1.5);
      let yaw = 0;
      let pitch = 0;
      for (const dt of dts) {
        if (inertia.step(dt)) {
          yaw += inertia.dYaw;
          pitch += inertia.dPitch;
        }
      }
      return { yaw, pitch };
    };
    const a = run(Array(60).fill(1 / 60));
    const b = run(Array(30).fill(1 / 30));
    const c = run([...Array(10).fill(0.07), ...Array(30).fill(0.01)]);
    expect(b.yaw).toBeCloseTo(a.yaw, 9);
    expect(b.pitch).toBeCloseTo(a.pitch, 9);
    expect(c.yaw).toBeCloseTo(a.yaw, 9);
    expect(c.pitch).toBeCloseTo(a.pitch, 9);
  });

  it('最初の角速度に上限がある（速くても向きを保ったまま最大 4 rad/s）', () => {
    const inertia = new RotationInertia();
    expect(inertia.start(30, 40)).toBe(true);
    expect(inertia.speed).toBeCloseTo(DEFAULT_INERTIA_MAX_SPEED, 9);
    const { yaw, pitch } = total(inertia, 5, 1 / 60);
    expect(Math.hypot(yaw, pitch)).toBeLessThanOrEqual(DEFAULT_INERTIA_MAX_SPEED * DEFAULT_INERTIA_TIME_CONSTANT + 1e-9);
    expect(yaw / pitch).toBeCloseTo(30 / 40, 3); // 向きは保つ
  });

  it('上限以下の速さはそのまま使う', () => {
    const inertia = new RotationInertia();
    inertia.start(1, 0);
    expect(inertia.speed).toBeCloseTo(1, 12);
  });

  it('十分小さくなったら完全に止まる（active が false になり、step は false を返し続ける）', () => {
    const inertia = new RotationInertia();
    inertia.start(1, 0);
    let steps = 0;
    while (inertia.active && steps < 10000) {
      inertia.step(1 / 60);
      steps++;
    }
    expect(inertia.active).toBe(false);
    expect(inertia.speed).toBe(0);
    // 1 rad/s が 0.02 rad/s 未満になるまで: τ·ln(50) ≈ 1.17 秒
    expect(steps / 60).toBeGreaterThan(1.1);
    expect(steps / 60).toBeLessThan(1.3);
    for (let i = 0; i < 5; i++) {
      expect(inertia.step(1 / 60)).toBe(false);
      expect(inertia.dYaw).toBe(0);
    }
  });

  it('始めから止める閾値以下の速さでは始まらない', () => {
    const inertia = new RotationInertia();
    expect(inertia.start(DEFAULT_INERTIA_STOP_SPEED / 2, 0)).toBe(false);
    expect(inertia.active).toBe(false);
  });

  it('時定数を変えられる。0 以下で無効、null で既定に戻る', () => {
    const inertia = new RotationInertia();
    expect(inertia.timeConstant).toBe(DEFAULT_INERTIA_TIME_CONSTANT);
    inertia.timeConstant = 0.6;
    inertia.start(1, 0);
    const slow = total(inertia, 0.6, 1 / 60).yaw;
    inertia.timeConstant = 0.15;
    inertia.start(1, 0);
    const fast = total(inertia, 0.6, 1 / 60).yaw;
    expect(slow).toBeGreaterThan(fast);
    inertia.timeConstant = 0;
    expect(inertia.enabled).toBe(false);
    expect(inertia.start(1, 0)).toBe(false);
    inertia.timeConstant = null;
    expect(inertia.timeConstant).toBe(DEFAULT_INERTIA_TIME_CONSTANT);
  });

  it('時定数を 0 にすると、回っている最中の慣性も止まる', () => {
    const inertia = new RotationInertia();
    inertia.start(1, 0);
    inertia.timeConstant = 0;
    expect(inertia.active).toBe(false);
    expect(inertia.step(1 / 60)).toBe(false);
  });

  it('NaN・負・無限大の dt は何もしない', () => {
    const inertia = new RotationInertia();
    inertia.start(1, 0);
    for (const dt of [NaN, -1, Infinity]) {
      expect(inertia.step(dt)).toBe(false);
      expect(inertia.dYaw).toBe(0);
    }
    expect(inertia.active).toBe(true);
    expect(inertia.speed).toBeCloseTo(1, 12);
  });

  it('blockPitch でピッチの角速度を捨てる。ヨーが残っていれば回り続け、なければ止まる', () => {
    const a = new RotationInertia();
    a.start(1, 1);
    a.blockPitch();
    expect(a.active).toBe(true);
    a.step(1 / 60);
    expect(a.dPitch).toBe(0);
    expect(a.dYaw).toBeGreaterThan(0);

    const b = new RotationInertia();
    b.start(0, 1);
    b.blockPitch();
    expect(b.active).toBe(false);
  });

  it('stop で止まる', () => {
    const inertia = new RotationInertia();
    inertia.start(1, 1);
    inertia.stop();
    expect(inertia.active).toBe(false);
    expect(inertia.step(1 / 60)).toBe(false);
  });
});

describe('DragVelocityTracker: 離した位置を速さに入れる', () => {
  /** 1 秒あたり 1000 ピクセルで右へ 300 ミリ秒動かして、最後の pointermove の時刻と位置を返す。 */
  const flickRight = (tracker: DragVelocityTracker) => {
    const t = dragAt(tracker, 1000, 300);
    return { t, x: 100 + (1000 * (t - 1000)) / 1000 };
  };

  it('位置を渡さなければ、最後の pointermove までの動きだけが数えられる（従来どおり）', () => {
    const tracker = new DragVelocityTracker();
    const { t } = flickRight(tracker);
    const v = tracker.release(t + 16)!;
    // 最後の移動から 16 ミリ秒たっているので、窓 90 ミリ秒のうち動いたのは 74 ミリ秒分
    expect(v.vx).toBeCloseTo((1000 * 74) / 90, -1);
  });

  it('最後の pointermove のあとに動いて離したら、その動きも速さに入る（同じ速さで動き続けた分）', () => {
    const tracker = new DragVelocityTracker();
    const { t, x } = flickRight(tracker);
    const v = tracker.release(t + 16, x + 16, 100)!; // 16 ミリ秒で 16 ピクセル = 1000 px/s の続き
    expect(v.vx).toBeCloseTo(1000, -1);
    expect(v.vy).toBeCloseTo(0, 6);
  });

  it('最後の pointermove から離すまでの動きが、窓の中の速さを変える（止まりかけから、離す直前に払った）', () => {
    const tracker = new DragVelocityTracker();
    tracker.begin(0, 0, 0);
    tracker.move(10, 0, 100); // ゆっくり（100 px/s）
    const slow = new DragVelocityTracker();
    slow.begin(0, 0, 0);
    slow.move(10, 0, 100);
    const without = slow.release(116)!;
    const withEnd = tracker.release(116, 90, 0)!; // 最後の 16 ミリ秒で 80 ピクセル動いて離した
    expect(withEnd.vx).toBeGreaterThan(without.vx * 4);
  });

  it('位置が変わらないなら、位置を渡しても速さは変わらない', () => {
    const a = new DragVelocityTracker();
    const b = new DragVelocityTracker();
    const { t, x } = flickRight(a);
    flickRight(b);
    const va = a.release(t + 5)!;
    const vb = b.release(t + 5, x, 100)!;
    expect(vb.vx).toBeCloseTo(va.vx, 6);
    expect(vb.vy).toBeCloseTo(va.vy, 6);
  });

  it('離した位置で初めて閾値を超えたなら、ドラッグとして扱う（動かさずに離した位置が遠いとき）', () => {
    const tracker = new DragVelocityTracker();
    tracker.begin(100, 100, 0);
    tracker.move(101, 100, 10);
    const v = tracker.release(26, 160, 100);
    expect(v).not.toBeNull();
    expect(v!.vx).toBeGreaterThan(0);
  });

  it('動かさずに離したクリックは、位置を渡しても null', () => {
    const tracker = new DragVelocityTracker();
    tracker.begin(100, 100, 0);
    expect(tracker.release(30, 102, 101)).toBeNull();
  });

  it('押していない状態では、位置を渡しても何も覚えない', () => {
    const tracker = new DragVelocityTracker();
    expect(tracker.release(10, 50, 50)).toBeNull();
    tracker.begin(0, 0, 100);
    expect(tracker.release(150)).toBeNull(); // 前の release の位置が残っていない
  });
});

describe('RotationInertia: 離した位置の動きでも慣性が付く', () => {
  it('最後の pointermove では止まりかけでも、離した位置が大きく動いていれば慣性が付く', () => {
    const slow = new RotationInertia();
    slow.beginDrag(100, 100, 1000);
    slow.dragMove(110, 100, 1100); // 100 px/s（80 px/s 以上だが小さい）
    expect(slow.endDrag(1116, 0.0025)).toBe(true);
    const slowSpeed = (slow.step(1e-9), slow.speed);

    const flung = new RotationInertia();
    flung.beginDrag(100, 100, 1000);
    flung.dragMove(110, 100, 1100);
    expect(flung.endDrag(1116, 0.0025, 190, 100)).toBe(true); // 離す直前の 16 ミリ秒で 80 ピクセル
    flung.step(1e-9);
    expect(flung.speed).toBeGreaterThan(slowSpeed * 3);
  });

  it('離した位置で初めて動いた（move なし）押下も、速ければ慣性が付く', () => {
    const inertia = new RotationInertia();
    inertia.beginDrag(100, 100, 1000);
    expect(inertia.endDrag(1020, 0.0025, 180, 100)).toBe(true); // 20 ミリ秒で 80 ピクセル
    expect(inertia.active).toBe(true);
  });
});

describe('RotationInertia: 押下で止めたことを覚える', () => {
  const rolling = () => {
    const inertia = new RotationInertia();
    expect(inertia.start(2, 0)).toBe(true);
    return inertia;
  };

  it('回っているときに止めた押下は、止めた押下として覚える', () => {
    const inertia = rolling();
    const press = {};
    expect(inertia.stopByPress(press)).toBe(true);
    expect(inertia.active).toBe(false);
    expect(inertia.isStoppedBy(press)).toBe(true);
    expect(inertia.isStoppedBy({})).toBe(false);
  });

  it('止めるより前に聞かれても（まだ回っている）、止めた押下として答える', () => {
    const inertia = rolling();
    expect(inertia.isStoppedBy({})).toBe(true);
  });

  it('回っていなかったときの押下は、止めた押下ではない。次の押下は前の押下を引き継がない', () => {
    const inertia = rolling();
    const first = {};
    inertia.stopByPress(first);
    const second = {};
    expect(inertia.stopByPress(second)).toBe(false);
    expect(inertia.isStoppedBy(second)).toBe(false);
    expect(inertia.isStoppedBy(first)).toBe(false);
  });
});

describe('RotationInertia: ドラッグの離し方', () => {
  /** 1 秒あたり `vx` ピクセルの速さで動かして離す。 */
  const flick = (inertia: RotationInertia, vx: number, ms = 300, pauseMs = 0, vy = 0) => {
    inertia.beginDrag(100, 100, 1000);
    let t = 1000;
    let x = 100;
    let y = 100;
    while (t < 1000 + ms) {
      t += 16;
      x += (vx * 16) / 1000;
      y += (vy * 16) / 1000;
      inertia.dragMove(x, y, t);
    }
    return inertia.endDrag(t + pauseMs, 0.0025);
  };

  it('動かしながら離すと、その速さ（角速度 = −px/s × ラジアン/px）で慣性が始まる', () => {
    const inertia = new RotationInertia();
    expect(flick(inertia, 800)).toBe(true);
    expect(inertia.active).toBe(true);
    // 右へ 800 px/s → ヨーは負（右を向く向き）、2 rad/s
    inertia.step(1e-9);
    expect(inertia.dYaw).toBeLessThan(0);
    expect(inertia.speed).toBeCloseTo(2, 1);
  });

  it('ポインタを止めてから離すと、慣性は付かない', () => {
    const inertia = new RotationInertia();
    expect(flick(inertia, 800, 300, 150)).toBe(false);
    expect(inertia.active).toBe(false);
  });

  it('動きがごく小さいとき（80 px/s 未満）は付かない', () => {
    const inertia = new RotationInertia();
    expect(flick(inertia, 40)).toBe(false);
    expect(flick(inertia, 200)).toBe(true);
  });

  it('動かさずに離したクリックでは付かない', () => {
    const inertia = new RotationInertia();
    inertia.beginDrag(10, 10, 0);
    expect(inertia.endDrag(50, 0.0025)).toBe(false);
  });

  it('押すと、回っている慣性が止まる', () => {
    const inertia = new RotationInertia();
    inertia.start(2, 0);
    inertia.beginDrag(0, 0, 0);
    expect(inertia.active).toBe(false);
  });

  it('無効のときは、速く動かして離しても付かない', () => {
    const inertia = new RotationInertia({ timeConstant: 0 });
    expect(flick(inertia, 2000)).toBe(false);
    expect(inertia.active).toBe(false);
  });

  it('cancelDrag のあとに離しても付かない', () => {
    const inertia = new RotationInertia();
    inertia.beginDrag(0, 0, 0);
    inertia.dragMove(100, 0, 16);
    inertia.cancelDrag();
    expect(inertia.endDrag(16, 0.0025)).toBe(false);
  });
});

describe('prefers-reduced-motion', () => {
  const win = (reduce: boolean) => ({ matchMedia: (q: string) => ({ matches: reduce && q.includes('reduce') }) as MediaQueryList });

  it('prefersReducedMotion: 設定を読む。matchMedia がなければ false', () => {
    expect(prefersReducedMotion(win(true))).toBe(true);
    expect(prefersReducedMotion(win(false))).toBe(false);
    expect(prefersReducedMotion(null)).toBe(false);
    expect(prefersReducedMotion({} as Pick<Window, 'matchMedia'>)).toBe(false);
  });

  it('時定数を指定しなければ、「動きを減らす」が有効なとき既定で無効になる', () => {
    const inertia = new RotationInertia({}, win(true));
    expect(inertia.timeConstant).toBe(0);
    expect(inertia.enabled).toBe(false);
    expect(inertia.start(1, 0)).toBe(false);
  });

  it('時定数を明示すれば、「動きを減らす」でも使える。null で自動に戻る', () => {
    const inertia = new RotationInertia({ timeConstant: 0.3 }, win(true));
    expect(inertia.enabled).toBe(true);
    inertia.timeConstant = null;
    expect(inertia.enabled).toBe(false);
  });

  it('「動きを減らす」でなければ既定の 0.3 秒', () => {
    expect(new RotationInertia({}, win(false)).timeConstant).toBe(DEFAULT_INERTIA_TIME_CONSTANT);
  });
});
