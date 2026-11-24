import { Vector3 } from 'three';
import { MAX_VIEW_PITCH, type ViewAngles } from '../render/view';
import { RotationInertia } from '../controls/RotationInertia';
import { flightEase } from '../controls/easing';

/**
 * 飛行モードと俯瞰モードを切り替えるときの、カメラの移り変わり。DOM にも three.js のカメラにも依存しない。
 * - `Reorient`: 飛行 → 俯瞰で、位置を保ったまま点群の中心へ向き直す動き。
 * - `ResidualMotion`: 切り替えた瞬間に残っていた移動の速度と回転の慣性を、短い時定数で減らして消す動き。
 */

/** 角度差を (-π, π] に畳む（`homeFlight` の内部の関数と同じ式）。 */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = ((a % twoPi) + twoPi) % twoPi;
  if (r > Math.PI) r -= twoPi;
  return r;
}

/** 向き直しにかける時間（秒）。 */
export const REORIENT_DURATION_SECONDS = 0.5;
/** 中心までの向きのずれがこれ（ラジアン。3°）未満なら、向き直さない。 */
export const REORIENT_MIN_ANGLE = (3 * Math.PI) / 180;
/** 残った動きを減らす時定数（秒）。 */
export const RESIDUAL_TIME_CONSTANT = 0.15;

/** 移動の速度がこれ未満（単位/秒）なら、止まったとみなす（`FlyMotion` の停止判定と同じ）。 */
const STOP_SPEED = 1e-5;

/**
 * 向き直しの進み方 `f(t) = 1 − (1−t)³(1+3t)`。始まりと終わりの速さが 0。範囲外は端に丸める。
 * 点・塊へ飛ぶ自動移動と同じ式（`flightEase`。src/controls/easing.ts）。
 */
export function reorientEase(t: number): number {
  return flightEase(t);
}

function clampPitch(pitch: number): number {
  return Math.min(MAX_VIEW_PITCH, Math.max(-MAX_VIEW_PITCH, pitch));
}

/**
 * 位置を保ったまま、視線を目標の向きへ回す動き。開始の向き（yaw / pitch）から、毎フレーム渡される目標の向きへ、
 * `reorientEase` で補間する。yaw は短いほうの回り方で、途中の姿勢も横傾き（roll）を持たない。
 * 目標は毎フレーム渡すので、動いている最中にカメラの位置が少しずれても（残った移動の速度）、終わるときには必ず目標を向く。
 */
export class Reorient {
  private elapsed = 0;
  private yaw: number;
  private pitch: number;

  constructor(
    from: ViewAngles,
    readonly durationSeconds: number = REORIENT_DURATION_SECONDS,
  ) {
    this.yaw = from.yaw;
    this.pitch = from.pitch;
  }

  /** 終わったか。 */
  get done(): boolean {
    return !(this.elapsed < this.durationSeconds);
  }

  /** 進み具合（0〜1、イージング前）。 */
  get progress(): number {
    return this.durationSeconds > 0 ? Math.min(1, this.elapsed / this.durationSeconds) : 1;
  }

  /**
   * 開始の向きを `dYaw`・`dPitch` だけずらす。向き直しの最中に残っている回転の慣性が、
   * 向き直しの始まりを急に止めずに引き継ぐために使う（その分は、進むにつれて目標への補間に置き換わる）。
   */
  rotateBaseline(dYaw: number, dPitch: number): void {
    this.yaw = wrapAngle(this.yaw + dYaw);
    this.pitch = clampPitch(this.pitch + dPitch);
  }

  /** `dt` 秒進めて、そのときの向きを返す。`dt` が負・非有限なら進めない。終わったら `target` をそのまま返す。 */
  advance(dt: number, target: ViewAngles): ViewAngles {
    if (Number.isFinite(dt) && dt > 0) this.elapsed += dt;
    if (this.done) return { yaw: target.yaw, pitch: target.pitch };
    const f = reorientEase(this.progress);
    return {
      yaw: this.yaw + wrapAngle(target.yaw - this.yaw) * f,
      pitch: this.pitch + (target.pitch - this.pitch) * f,
    };
  }
}

/** `ResidualMotion.step` が返す、このフレームの動き。 */
export interface ResidualStep {
  /** 位置の変化（ワールド座標）。 */
  translation: Vector3;
  /** ヨーの回転量（ラジアン。正で左 / 反時計回り）。 */
  dYaw: number;
  /** ピッチの回転量（ラジアン。正で上）。 */
  dPitch: number;
}

/**
 * 切り替えの瞬間に残っていた動き。移動の速度（ワールド）と回転の角速度を、時定数 `timeConstant` の指数で減らして消す。
 * 1 回の `step` の移動量・回転量は解析解なので、刻み幅によらず総量は同じ（`v0 · τ · (1 − e^(−T/τ))`）。
 */
export class ResidualMotion {
  private readonly velocity = new Vector3();
  private readonly rotation: RotationInertia;
  private readonly tau: number;
  private readonly out: ResidualStep = { translation: new Vector3(), dYaw: 0, dPitch: 0 };
  /** 回転が、中心のまわりの周回か（俯瞰モードの慣性）。false なら、その場での向きの変化（飛行モードの慣性）。 */
  orbit = false;

  constructor(timeConstant: number = RESIDUAL_TIME_CONSTANT) {
    this.tau = timeConstant;
    // 引き継ぐ角速度は元の慣性で上限が掛かっているので、ここでは上限を設けない
    this.rotation = new RotationInertia({ timeConstant, maxSpeed: Number.POSITIVE_INFINITY });
  }

  /** 残っている動きがあるか。 */
  get active(): boolean {
    return this.velocity.lengthSq() > 0 || this.rotation.active;
  }

  /** 回転が残っているか。 */
  get rotating(): boolean {
    return this.rotation.active;
  }

  /** 移動の速度が残っているか。 */
  get moving(): boolean {
    return this.velocity.lengthSq() > 0;
  }

  /** 移動の速度（ワールド、単位/秒）を足す。 */
  addVelocity(v: Vector3): void {
    if (!Number.isFinite(v.x + v.y + v.z)) return;
    this.velocity.add(v);
    if (this.velocity.lengthSq() < STOP_SPEED * STOP_SPEED) this.velocity.set(0, 0, 0);
  }

  /** 回転の角速度（ラジアン/秒）を決める。いまの回転は置き換える。小さすぎれば回転は残さない。 */
  setRotation(yawRate: number, pitchRate: number, orbit: boolean): void {
    this.orbit = orbit;
    this.rotation.start(yawRate, pitchRate);
  }

  /** 回転だけを捨てる。 */
  stopRotation(): void {
    this.rotation.stop();
  }

  /** 回転が上下の端に当たったとき、ピッチの角速度を捨てる。 */
  blockPitch(): void {
    this.rotation.blockPitch();
  }

  /** 移動も回転も捨てる。 */
  stop(): void {
    this.velocity.set(0, 0, 0);
    this.rotation.stop();
  }

  /** `dt` 秒進める。返す値は次の `step` まで有効（使い回す）。`dt` が負・非有限・0 なら何も動かさない。 */
  step(dt: number): ResidualStep {
    const out = this.out;
    out.translation.set(0, 0, 0);
    out.dYaw = 0;
    out.dPitch = 0;
    if (!Number.isFinite(dt) || dt <= 0) return out;
    if (this.velocity.lengthSq() > 0) {
      const decay = Math.exp(-dt / this.tau);
      out.translation.copy(this.velocity).multiplyScalar(this.tau * (1 - decay));
      this.velocity.multiplyScalar(decay);
      if (this.velocity.lengthSq() < STOP_SPEED * STOP_SPEED) this.velocity.set(0, 0, 0);
    }
    if (this.rotation.step(dt)) {
      out.dYaw = this.rotation.dYaw;
      out.dPitch = this.rotation.dPitch;
    }
    return out;
  }
}
