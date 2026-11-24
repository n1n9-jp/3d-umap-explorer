import { Vector3 } from 'three';
import { MAX_VIEW_PITCH, type ViewAngles } from '../render/view';
import { DEFAULT_INERTIA_STOP_SPEED } from '../controls/RotationInertia';
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

/**
 * 残った動きは、切り替えた瞬間の速さ（回転は角速度）がこの比まで減った時点で、0 にして止める
 * （飛行モードの滑走の停止、`GLIDE_STOP_RATIO` と同じ比）。時定数 0.15 秒で約 0.53 秒（ln(1/0.03) × 0.15）。
 */
export const RESIDUAL_STOP_RATIO = 0.03;
/** 移動の速度がこれ未満（単位/秒）なら、残さない・止まったとみなす（`FlyMotion` の停止判定と同じ）。 */
const STOP_SPEED = 1e-5;
/** 回転の角速度がこれ以下（ラジアン/秒）なら、残さない・止まったとみなす（回転の慣性の `stopSpeed` と同じ）。 */
const STOP_ROTATION_SPEED = DEFAULT_INERTIA_STOP_SPEED;

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
 * 速さが、切り替えた瞬間の速さの `RESIDUAL_STOP_RATIO`（0.03）まで減った時刻（`τ · ln(1 / 0.03)`）で 0 にして止める。
 * その時刻までを解析解で進めるので、止まる位置と向きは刻み幅によらない（総量は `v0 · τ · (1 − 0.03)`）。
 * 切り替えた瞬間の速さが絶対値の閾値を下回る（移動は 1e-5 単位/秒未満、回転は 0.02 ラジアン/秒以下）なら、残さない。
 */
export class ResidualMotion {
  private readonly velocity = new Vector3();
  /** 移動の速さが、これまで減ったら止める（単位/秒）。 */
  private moveThreshold = STOP_SPEED;
  private yawRate = 0;
  private pitchRate = 0;
  /** 回転の角速度が、これまで減ったら止める（ラジアン/秒）。 */
  private rotationThreshold = STOP_ROTATION_SPEED;
  private _rotating = false;
  private stoppedBy: object | null = null;
  private readonly tau: number;
  private readonly out: ResidualStep = { translation: new Vector3(), dYaw: 0, dPitch: 0 };
  /** 回転が、中心のまわりの周回か（俯瞰モードの慣性）。false なら、その場での向きの変化（飛行モードの慣性）。 */
  orbit = false;

  constructor(timeConstant: number = RESIDUAL_TIME_CONSTANT) {
    this.tau = timeConstant;
  }

  /** 残っている動きがあるか。 */
  get active(): boolean {
    return this.velocity.lengthSq() > 0 || this._rotating;
  }

  /** 回転が残っているか。 */
  get rotating(): boolean {
    return this._rotating;
  }

  /** 移動の速度が残っているか。 */
  get moving(): boolean {
    return this.velocity.lengthSq() > 0;
  }

  /** 移動の速度（ワールド、単位/秒）を足す。足したあとの速さが、止める閾値を決める。 */
  addVelocity(v: Vector3): void {
    if (!Number.isFinite(v.x + v.y + v.z)) return;
    this.velocity.add(v);
    const speed = this.velocity.length();
    if (!(speed >= STOP_SPEED)) {
      this.velocity.set(0, 0, 0);
      return;
    }
    this.moveThreshold = Math.max(STOP_SPEED, speed * RESIDUAL_STOP_RATIO);
  }

  /** 回転の角速度（ラジアン/秒）を決める。いまの回転は置き換える。小さすぎれば回転は残さない。 */
  setRotation(yawRate: number, pitchRate: number, orbit: boolean): void {
    this.orbit = orbit;
    this.stopRotation();
    if (!(this.tau > 0) || !Number.isFinite(yawRate) || !Number.isFinite(pitchRate)) return;
    const speed = Math.hypot(yawRate, pitchRate);
    if (!(speed > STOP_ROTATION_SPEED)) return;
    this.yawRate = yawRate;
    this.pitchRate = pitchRate;
    this.rotationThreshold = Math.max(STOP_ROTATION_SPEED, speed * RESIDUAL_STOP_RATIO);
    this._rotating = true;
  }

  /** 回転だけを捨てる。 */
  stopRotation(): void {
    this.yawRate = 0;
    this.pitchRate = 0;
    this._rotating = false;
  }

  /**
   * 押下 `press`（pointerdown のイベントなど）で回転を止める。回っていて止めたなら true で、その押下を覚える
   * （`isRotationStoppedBy`）。回っていなければ何も覚えない（`RotationInertia.stopByPress` と同じ）。
   */
  stopRotationByPress(press: object): boolean {
    const wasRotating = this._rotating;
    this.stopRotation();
    this.stoppedBy = wasRotating ? press : null;
    return wasRotating;
  }

  /**
   * 押下 `press` が、回転を止めた押下か。`stopRotationByPress` が止めたあとなら、止めたのがこの押下かどうか。
   * まだ回っているなら、この押下がこれから止めるので true（ほかのリスナーが先に呼ばれても、あとに呼ばれても同じ答えになる）。
   */
  isRotationStoppedBy(press: object): boolean {
    return this._rotating || this.stoppedBy === press;
  }

  /** 回転が上下の端に当たったとき、ピッチの角速度を捨てる。残りが閾値以下なら止まる。 */
  blockPitch(): void {
    this.pitchRate = 0;
    if (this._rotating && !(Math.abs(this.yawRate) > this.rotationThreshold)) this.stopRotation();
  }

  /** 移動も回転も捨てる。 */
  stop(): void {
    this.velocity.set(0, 0, 0);
    this.stopRotation();
  }

  /** `dt` 秒進める。返す値は次の `step` まで有効（使い回す）。`dt` が負・非有限・0 なら何も動かさない。 */
  step(dt: number): ResidualStep {
    const out = this.out;
    out.translation.set(0, 0, 0);
    out.dYaw = 0;
    out.dPitch = 0;
    if (!Number.isFinite(dt) || dt <= 0) return out;
    if (!(this.tau > 0)) {
      this.stop();
      return out;
    }
    if (this.velocity.lengthSq() > 0) {
      const gain = this.advance(this.velocity.length(), this.moveThreshold, dt);
      out.translation.copy(this.velocity).multiplyScalar(gain.gain);
      if (gain.done) this.velocity.set(0, 0, 0);
      else this.velocity.multiplyScalar(gain.decay);
    }
    if (this._rotating) {
      const gain = this.advance(Math.hypot(this.yawRate, this.pitchRate), this.rotationThreshold, dt);
      out.dYaw = this.yawRate * gain.gain;
      out.dPitch = this.pitchRate * gain.gain;
      if (gain.done) this.stopRotation();
      else {
        this.yawRate *= gain.decay;
        this.pitchRate *= gain.decay;
      }
    }
    return out;
  }

  /**
   * 速さ `speed` から `dt` 秒進める。速さが `threshold` に達する時刻 `τ · ln(speed / threshold)` がこの区間内なら、
   * そこまでを解析解で進めて止める（`done`）。`gain` は、いまの速度（ベクトル）に掛けると、この区間の変位になる係数。
   */
  private advance(speed: number, threshold: number, dt: number): { gain: number; decay: number; done: boolean } {
    const tau = this.tau;
    if (!(speed > threshold)) return { gain: 0, decay: 0, done: true };
    const tc = tau * Math.log(speed / threshold);
    if (tc <= dt) return { gain: (tau * (speed - threshold)) / speed, decay: 0, done: true };
    const decay = Math.exp(-dt / tau);
    return { gain: tau * (1 - decay), decay, done: false };
  }
}
