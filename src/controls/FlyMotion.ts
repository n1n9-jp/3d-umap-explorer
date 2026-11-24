import { Vector3 } from 'three';
import { MAX_WHEEL_EVENT_NOTCHES } from './WheelGesture';
import {
  FLIGHT_ORIENT_END,
  flightEase,
  flightEaseDerivative,
  reducedFlightDuration,
  scaledFlightDuration,
} from './easing';

/**
 * 飛行カメラの運動の積分。DOM にも three.js のカメラにも依存せず、
 * 入力状態と経過時間から位置・向きを更新する。
 *
 * 座標系は three.js と同じ右手系（+Y が上、カメラは既定で -Z を向く）。
 * yaw は +Y まわりの回転（正で左へ向く）、pitch は水平からの仰角（正で上を向く）。
 */

/** 1 フレーム分のキー入力状態。 */
export interface MoveInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

export function createMoveInput(): MoveInput {
  return { forward: false, backward: false, left: false, right: false, up: false, down: false };
}

export interface FlyMotionOptions {
  /** 基準速度（単位/秒）。ユーザーが決める値で、`minSpeed`〜`maxSpeed` に丸められる。 */
  speed?: number;
  /**
   * 実際の移動速度にだけ掛ける係数（既定 1、正の有限値）。密度に応じた自動調整など、
   * 外部が `speed` を書き換えずに速度を変えるために使う。`minSpeed`・`maxSpeed` の制限は受けない。
   */
  speedScale?: number;
  minSpeed?: number;
  maxSpeed?: number;
  /** 移動キーの入力があるときに目標速度へ近づく指数応答の時定数（秒。逆向きのキーで止めるときも同じ）。0 以下で慣性なし。既定 0.15。 */
  accelTimeConstant?: number;
  /** 移動キーの入力がないときに、残った速度が減る指数応答の時定数（秒）。0 以下で滑らずに止まる。既定 0.5。 */
  glideTimeConstant?: number;
  /** ホイール 1 ノッチあたりの速度倍率。 */
  wheelFactor?: number;
  /** 1 回の update で積分する時間の上限（秒）。タブ復帰時の跳躍を防ぐ。 */
  maxDeltaTime?: number;
}

export interface FlyToOptions {
  /** 対象から手前に取る距離。 */
  distance?: number;
  /**
   * 基準の所要時間（ミリ秒。既定 600）。実際の所要時間は、移動の距離と `cloudRadius` に応じて 0.8〜1.8 倍に伸縮する
   * （`scaledFlightDuration`）。0 なら即座に着く。
   */
  durationMs?: number;
  /** 点群の半径。所要時間の伸縮の目安（移動の距離との比）。正の有限値でなければ伸縮しない。 */
  cloudRadius?: number;
  /** 「動きを減らす」設定が有効か。有効なら、所要時間を 0.5 倍にし、動いていたカメラの速度を引き継がない。 */
  reducedMotion?: boolean;
}

/** 自動移動の進行状況（検証用）。 */
export interface FlightInfo {
  /** 実際の所要時間（ミリ秒。伸縮・動きを減らす設定の倍率を反映済み）。 */
  durationMs: number;
  /** 経過時間（ミリ秒）。 */
  elapsedMs: number;
  /** 進み（0〜1。経過時間 / 所要時間）。緩急の前の値。 */
  progress: number;
  /** 始めたときのカメラの速度の大きさ（単位/秒）。引き継いだ速度。 */
  carriedSpeed: number;
}

export interface FlyPose {
  position: Vector3;
  /** 位置から 1 単位前方の点。`setPose` にそのまま渡せる。 */
  lookAt: Vector3;
  yaw: number;
  pitch: number;
}

export const DEFAULT_FLY_TO_DISTANCE = 0.03;
export const DEFAULT_FLY_TO_DURATION_MS = 600;
export const MAX_PITCH = (89 * Math.PI) / 180;

/** 移動の慣性の時定数の既定値（秒）。加速（入力があるとき。逆向きのキーで止めるときも）。 */
export const DEFAULT_ACCEL_TIME_CONSTANT = 0.15;
/** 移動の慣性の時定数の既定値（秒）。滑走（入力がないとき）。 */
export const DEFAULT_GLIDE_TIME_CONSTANT = 0.5;
/** 「動きを減らす」設定（`prefers-reduced-motion: reduce`）での、加速・滑走の時定数（秒）。キーを離すとすぐ止まる。 */
export const REDUCED_MOTION_TIME_CONSTANT = 0.12;
/**
 * 入力がないとき、残っている速さが「基準速度 × speedScale × この値」を下回ったら 0 にして停止とする。
 * 最高速からの滑走が、時定数 0.5 秒で約 1.75 秒（ln(1/0.03) × 0.5）で止まる。
 */
export const GLIDE_STOP_RATIO = 0.03;
/** 速度がこれ未満で入力が無ければ停止とみなす下限（単位/秒）。 */
const STOP_SPEED = 1e-5;
const ZERO = new Vector3();
/** 1 回のホイールイベントで反映するノッチ数の上限。 */
const MAX_WHEEL_NOTCHES = MAX_WHEEL_EVENT_NOTCHES;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 角度差を (-π, π] に畳む。 */
function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = (a + Math.PI) % twoPi;
  if (r <= 0) r += twoPi;
  return r - Math.PI;
}

interface FlightState {
  startPosition: Vector3;
  endPosition: Vector3;
  startYaw: number;
  yawDelta: number;
  startPitch: number;
  endPitch: number;
  /** 始めたときのカメラの速度（単位/秒）。位置へ `T·v0·t·(1−t)²` として足す。 */
  startVelocity: Vector3;
  durationMs: number;
  elapsedMs: number;
}

export class FlyMotion {
  readonly position = new Vector3();
  yaw = 0;
  pitch = 0;
  /** ワールド座標系の現在速度（単位/秒）。 */
  readonly velocity = new Vector3();

  minSpeed: number;
  maxSpeed: number;
  /** 入力があるときの時定数（秒）。 */
  accelTimeConstant: number;
  /** 入力がないときの時定数（秒）。 */
  glideTimeConstant: number;
  wheelFactor: number;
  maxDeltaTime: number;

  private _speed: number;
  private _speedScale = 1;
  /** 直近の `step` で見た `speedScale`（滑走中に下がったぶんを、残りの速度へ反映するため）。 */
  private lastStepScale = 1;
  /** 直近の `step` が、入力がないまま残りの速度で進んだか（滑走中か）。 */
  private _gliding = false;
  private flight: FlightState | null = null;
  /** rotateBy / setPose による未報告の姿勢変化。次の step で moved として返す。 */
  private dirty = false;

  private readonly forwardDir = new Vector3();
  private readonly rightDir = new Vector3();
  private readonly target = new Vector3();

  constructor(options: FlyMotionOptions = {}) {
    this.minSpeed = options.minSpeed ?? 0.005;
    this.maxSpeed = options.maxSpeed ?? 2;
    this.accelTimeConstant = options.accelTimeConstant ?? DEFAULT_ACCEL_TIME_CONSTANT;
    this.glideTimeConstant = options.glideTimeConstant ?? DEFAULT_GLIDE_TIME_CONSTANT;
    this.wheelFactor = options.wheelFactor ?? 1.1;
    this.maxDeltaTime = options.maxDeltaTime ?? 0.1;
    this._speed = clamp(options.speed ?? 0.45, this.minSpeed, this.maxSpeed);
    this.speedScale = options.speedScale ?? 1;
    this.lastStepScale = this._speedScale;
  }

  get speed(): number {
    return this._speed;
  }

  set speed(value: number) {
    this._speed = clamp(value, this.minSpeed, this.maxSpeed);
  }

  /** 実際の移動速度に掛ける係数。正の有限値以外を代入しても無視する（直前の値を保つ）。 */
  get speedScale(): number {
    return this._speedScale;
  }

  set speedScale(value: number) {
    if (Number.isFinite(value) && value > 0) this._speedScale = value;
  }

  get isFlying(): boolean {
    return this.flight !== null;
  }

  /** 移動キーの入力がないまま、残った速度で滑っている最中か（直近の `step` の結果）。 */
  get isGliding(): boolean {
    return this._gliding;
  }

  /** 現在の視線方向（単位ベクトル）を `out` に書く。 */
  getDirection(out: Vector3): Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  getPose(): FlyPose {
    const position = this.position.clone();
    const lookAt = this.getDirection(new Vector3()).add(position);
    return { position, lookAt, yaw: this.yaw, pitch: this.pitch };
  }

  /**
   * 位置と注視点を設定する。速度は 0 に戻り、飛行中なら中断する。
   * `lookAt` が `position` と一致して向きが決まらないときは、現在の向きを保つ。
   */
  setPose(position: Vector3, lookAt: Vector3): void {
    this.flight = null;
    this.velocity.set(0, 0, 0);
    this._gliding = false;
    this.position.copy(position);
    this.lookTowards(lookAt.x - position.x, lookAt.y - position.y, lookAt.z - position.z);
    this.dirty = true;
  }

  /** カメラの向き（視線方向ベクトル）から yaw / pitch を設定する。 */
  setDirection(dir: Vector3): void {
    this.lookTowards(dir.x, dir.y, dir.z);
    this.dirty = true;
  }

  /** ホイール操作。`notches` は 1 ノッチ = 1、正で減速、負で加速。速度が変わったら true。 */
  applyWheel(notches: number): boolean {
    const n = clamp(notches, -MAX_WHEEL_NOTCHES, MAX_WHEEL_NOTCHES);
    const before = this._speed;
    this._speed = clamp(before * Math.pow(this.wheelFactor, -n), this.minSpeed, this.maxSpeed);
    return this._speed !== before;
  }

  /** 視点を回す。正の `dYaw` で左へ、正の `dPitch` で上へ。飛行中なら中断する。 */
  rotateBy(dYaw: number, dPitch: number): void {
    if (dYaw === 0 && dPitch === 0) return;
    this.flight = null;
    this.yaw = wrapAngle(this.yaw + dYaw);
    this.pitch = clamp(this.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
    this.dirty = true;
  }

  /**
   * `target` を注視する位置へ移動する自動移動を始める。進行は `step` が受け持つ。
   * 終了位置は、`target` からカメラ方向へ `distance` だけ離れた点。
   */
  flyTo(target: Vector3, options: FlyToOptions = {}): void {
    const distance = Math.max(0, options.distance ?? DEFAULT_FLY_TO_DISTANCE);
    const baseMs = Math.max(0, options.durationMs ?? DEFAULT_FLY_TO_DURATION_MS);
    const reduced = options.reducedMotion === true;

    const offset = this.position.clone().sub(target);
    if (offset.lengthSq() < 1e-18) {
      // カメラが対象と重なっている。今の視線の反対側に退く。
      offset.copy(this.getDirection(new Vector3())).negate();
    }
    offset.normalize();
    const end = target.clone().addScaledVector(offset, distance);

    // end から target を見る向き = -offset。
    let endYaw = this.yaw;
    if (Math.hypot(offset.x, offset.z) > 1e-9) endYaw = Math.atan2(offset.x, offset.z);
    const endPitch = clamp(Math.asin(clamp(-offset.y, -1, 1)), -MAX_PITCH, MAX_PITCH);

    // 動いていたカメラの速度を引き継ぐ（滑走中。飛行の途中なら、その瞬間の飛行の速度）。動きを減らす設定では引き継がない。
    const startVelocity = new Vector3();
    if (!reduced) {
      if (this.flight) this.flightVelocity(this.flight, startVelocity);
      else startVelocity.copy(this.velocity);
    }

    const durationMs = reducedFlightDuration(scaledFlightDuration(baseMs, this.position.distanceTo(end), options.cloudRadius), reduced);

    this.velocity.set(0, 0, 0);
    this._gliding = false;
    this.flight = {
      startPosition: this.position.clone(),
      endPosition: end,
      startYaw: this.yaw,
      yawDelta: wrapAngle(endYaw - this.yaw),
      startPitch: this.pitch,
      endPitch,
      startVelocity,
      durationMs,
      elapsedMs: 0,
    };
    if (durationMs === 0) this.advanceFlight(0);
  }

  /** 自動移動の進行状況。自動移動の最中でなければ null。 */
  get flightInfo(): FlightInfo | null {
    const fl = this.flight;
    if (!fl) return null;
    const progress = fl.durationMs <= 0 ? 1 : Math.min(1, fl.elapsedMs / fl.durationMs);
    return { durationMs: fl.durationMs, elapsedMs: fl.elapsedMs, progress, carriedSpeed: fl.startVelocity.length() };
  }

  cancelFlyTo(): void {
    this.flight = null;
  }

  /** 速度と進行中の飛行を捨てる（無効化時など）。 */
  stop(): void {
    this.flight = null;
    this.velocity.set(0, 0, 0);
    this._gliding = false;
  }

  /**
   * `dtSeconds` だけ時間を進める。入力は区間内で一定とみなす。
   * 速度は目標速度へ指数的に近づき、位置はその解析解で積分するので、
   * 同じ入力なら刻み幅によらず同じ位置に着く。時定数は、入力があるとき（逆向きのキーで止めるときも）は
   * `accelTimeConstant`、入力がないとき（滑走）は `glideTimeConstant`。
   * 入力がない間は、`speedScale` が下がったぶん（下がった割合）を残りの速度へ掛け、残りの速さが
   * 「基準速度 × speedScale × `GLIDE_STOP_RATIO`」を下回る時点で止まる（その時刻までを解析解で進める）。
   * 位置または向きが変わったら true。
   * `dtSeconds` が NaN・負・無限大のときは、状態を変えずに false を返す。
   */
  step(dtSeconds: number, input: MoveInput): boolean {
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0) return false;
    const dt = clamp(dtSeconds, 0, this.maxDeltaTime);
    let moved = this.dirty;
    this.dirty = false;

    this.computeTargetVelocity(input, this.target);
    const hasMoveInput = this.target.lengthSq() > 0;
    const v = this.velocity;

    // 入力がない間に speedScale が下がったら、残っている速度も同じ割合で下げる（速い速度のまま密な所へ滑り込まない）。
    // 係数は前回の step との比で見るので、いくつの step に分けて下がっても、積は同じ。
    const scale = this._speedScale;
    const prevScale = this.lastStepScale;
    this.lastStepScale = scale;
    if (!hasMoveInput && scale < prevScale && v.lengthSq() > 0) {
      v.multiplyScalar(Math.min(1, scale / prevScale));
      moved = true;
    }

    if (this.flight) {
      if (hasMoveInput) {
        this.flight = null; // 操作による中断。以降は通常の移動として扱う。
      } else {
        this.advanceFlight(dt * 1000);
        return true;
      }
    }

    if (dt === 0) return moved;

    // 停止するステップは、速度が 0 になっても、その区間の位置は進んでいる（カメラへ反映させるため moved にする）
    const wasMoving = v.lengthSq() > 0;
    if (hasMoveInput) this.integrate(dt, this.accelTimeConstant, this.target);
    else this.glide(dt);

    this._gliding = !hasMoveInput && v.lengthSq() > 0;
    if (wasMoving || v.lengthSq() > 0 || hasMoveInput) moved = true;
    return moved;
  }

  /** 速度を目標速度へ時定数 `tau` で近づけ、その解析解で位置を進める。 */
  private integrate(dt: number, tau: number, target: Vector3): void {
    const v = this.velocity;
    if (tau <= 0) {
      v.copy(target);
      this.position.addScaledVector(v, dt);
      return;
    }
    const decay = Math.exp(-dt / tau);
    // x(t) = target·dt + (v0 − target)·τ·(1 − e^(−dt/τ))、v(t) = target + (v0 − target)·e^(−dt/τ)
    const gain = tau * (1 - decay);
    this.position.x += target.x * dt + (v.x - target.x) * gain;
    this.position.y += target.y * dt + (v.y - target.y) * gain;
    this.position.z += target.z * dt + (v.z - target.z) * gain;
    v.x = target.x + (v.x - target.x) * decay;
    v.y = target.y + (v.y - target.y) * decay;
    v.z = target.z + (v.z - target.z) * decay;
  }

  /** 入力がないときの 1 区間。残りの速さが停止の閾値を下回る時刻までを解析解で進めて止める。 */
  private glide(dt: number): void {
    const v = this.velocity;
    const speed = v.length();
    if (speed === 0) return;
    const threshold = Math.max(STOP_SPEED, this._speed * this._speedScale * GLIDE_STOP_RATIO);
    const tau = this.glideTimeConstant;
    if (tau <= 0 || speed <= threshold) {
      v.set(0, 0, 0); // 滑らずに止まる（慣性なし）。閾値以下の速度は、そこで止める
      return;
    }
    // 閾値に達する時刻 tc = τ·ln(speed / threshold)。この区間内なら、tc まで進めて止める。
    const tc = tau * Math.log(speed / threshold);
    if (tc <= dt) {
      this.position.addScaledVector(v, (tau * (speed - threshold)) / speed);
      v.set(0, 0, 0);
      return;
    }
    this.integrate(dt, tau, ZERO);
  }

  private computeTargetVelocity(input: MoveInput, out: Vector3): Vector3 {
    const f = Number(input.forward) - Number(input.backward);
    const r = Number(input.right) - Number(input.left);
    const u = Number(input.up) - Number(input.down);
    out.set(0, 0, 0);
    if (f === 0 && r === 0 && u === 0) return out;

    this.getDirection(this.forwardDir);
    // 右方向は水平面内（ピッチに依らない）。
    this.rightDir.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    out.addScaledVector(this.forwardDir, f).addScaledVector(this.rightDir, r);
    out.y += u;
    const len = out.length();
    if (len === 0) return out; // 打ち消し合った
    const speed = this._speed * this._speedScale;
    return out.multiplyScalar(speed / Math.max(len, 1));
  }

  private advanceFlight(dtMs: number): void {
    const fl = this.flight;
    if (!fl) return;
    fl.elapsedMs += dtMs;
    const t = fl.durationMs <= 0 ? 1 : Math.min(1, fl.elapsedMs / fl.durationMs);
    if (t >= 1) {
      this.position.copy(fl.endPosition);
      this.yaw = wrapAngle(fl.startYaw + fl.yawDelta);
      this.pitch = fl.endPitch;
      this.flight = null;
    } else {
      // 位置: 緩急 f(t) での補間に、始めの速度の引き継ぎ T·v0·t(1−t)²（t=0 で速度 v0、t=1 で位置・速度への寄与 0）を足す。
      const e = flightEase(t);
      this.position.lerpVectors(fl.startPosition, fl.endPosition, e);
      const carry = (fl.durationMs / 1000) * t * (1 - t) * (1 - t);
      this.position.addScaledVector(fl.startVelocity, carry);
      // 向き: 進みの 70% で合い終える（着く前に対象を捉え終える）。
      const o = flightEase(t / FLIGHT_ORIENT_END);
      this.yaw = wrapAngle(fl.startYaw + fl.yawDelta * o);
      this.pitch = fl.startPitch + (fl.endPitch - fl.startPitch) * o;
    }
    this.velocity.set(0, 0, 0);
    this.dirty = false;
  }

  /** 飛行の現在の速度（単位/秒）を `out` に書く。位置の式 `S + (E−S)·f(t) + T·v0·t(1−t)²` の時間微分。 */
  private flightVelocity(fl: FlightState, out: Vector3): Vector3 {
    const t = fl.durationMs <= 0 ? 1 : Math.min(1, fl.elapsedMs / fl.durationMs);
    if (t >= 1 || fl.durationMs <= 0) return out.set(0, 0, 0);
    const T = fl.durationMs / 1000;
    out.subVectors(fl.endPosition, fl.startPosition).multiplyScalar(flightEaseDerivative(t) / T);
    // d/dt [t(1−t)²] = (1−t)(1−3t)。T·v0 を T で割るので、v0 に掛かる係数はそのまま
    return out.addScaledVector(fl.startVelocity, (1 - t) * (1 - 3 * t));
  }

  private lookTowards(x: number, y: number, z: number): void {
    const len = Math.hypot(x, y, z);
    if (len < 1e-12) return;
    if (Math.hypot(x, z) > 1e-9 * len) this.yaw = Math.atan2(-x, -z);
    this.pitch = clamp(Math.asin(clamp(y / len, -1, 1)), -MAX_PITCH, MAX_PITCH);
  }
}
