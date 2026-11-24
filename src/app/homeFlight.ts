import { reducedFlightDuration, scaledFlightDuration } from '../controls/easing';
import { directionFromAngles, type Vec3, type ViewAngles } from '../render/view';

/**
 * 現在の視点からホームの視点へ、位置と向きを一緒に補間する移動。DOM にも three.js にも依存しない。
 * 向きは yaw と pitch で補間するので、途中の姿勢も横傾き（roll）を持たない（飛行モードへ切り替えても跳ばない）。
 * yaw は短いほうの回り方で補間する。進み方は始まりと終わりが緩やかな smootherstep。
 * 所要時間は、基準（`HOME_DURATION_SECONDS`・ミニマップは 0.6 秒）を、移動の距離に応じて 0.8〜1.8 倍に伸縮する
 * （`homeFlightDuration`）。「動きを減らす」設定のときは、さらに 0.5 倍。
 */

export const HOME_DURATION_SECONDS = 1;

export interface FlightPose extends ViewAngles {
  position: Vec3;
}

/**
 * `from` から `to` へ移る所要時間（秒）。基準 `baseSeconds` を、位置の移動の距離と点群の半径 `radius` で伸縮し
 * （`scaledFlightDuration`）、`reduced`（動きを減らす設定）なら 0.5 倍にする。`radius` が使えなければ伸縮しない。
 */
export function homeFlightDuration(
  from: FlightPose,
  to: FlightPose,
  baseSeconds: number,
  radius: number | null | undefined,
  reduced: boolean,
): number {
  const distance = Math.hypot(to.position[0] - from.position[0], to.position[1] - from.position[1], to.position[2] - from.position[2]);
  return reducedFlightDuration(scaledFlightDuration(baseSeconds, distance, radius), reduced);
}

/** 0→1 の smootherstep（始まりと終わりで速度と加速度が 0）。範囲外は端に丸める。 */
export function smootherstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** 角度差を (-π, π] に畳む。 */
function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = ((a % twoPi) + twoPi) % twoPi;
  if (r > Math.PI) r -= twoPi;
  return r;
}

/** `from` から `to` への進み具合 `t`（0〜1、イージング済み）の姿勢。 */
export function interpolatePose(from: FlightPose, to: FlightPose, t: number): FlightPose {
  return {
    position: [
      from.position[0] + (to.position[0] - from.position[0]) * t,
      from.position[1] + (to.position[1] - from.position[1]) * t,
      from.position[2] + (to.position[2] - from.position[2]) * t,
    ],
    yaw: from.yaw + wrapAngle(to.yaw - from.yaw) * t,
    pitch: from.pitch + (to.pitch - from.pitch) * t,
  };
}

/** 姿勢の注視点（位置から視線方向へ 1 だけ進んだ点）。 */
export function poseLookAt(pose: FlightPose): Vec3 {
  const d = directionFromAngles(pose);
  return [pose.position[0] + d[0], pose.position[1] + d[1], pose.position[2] + d[2]];
}

export class HomeFlight {
  private elapsed = 0;

  constructor(
    readonly from: FlightPose,
    readonly to: FlightPose,
    readonly durationSeconds: number = HOME_DURATION_SECONDS,
  ) {}

  /** 終点に着いたか。 */
  get done(): boolean {
    return !(this.elapsed < this.durationSeconds);
  }

  /** 進み具合（0〜1、イージング前）。 */
  get progress(): number {
    return this.durationSeconds > 0 ? Math.min(1, this.elapsed / this.durationSeconds) : 1;
  }

  /** `dt` 秒進めて、そのときの姿勢を返す。`dt` が負・非有限なら進めない。終点では `to` をそのまま返す。 */
  advance(dt: number): FlightPose {
    if (Number.isFinite(dt) && dt > 0) this.elapsed += dt;
    if (this.done) return { position: [...this.to.position], yaw: this.to.yaw, pitch: this.to.pitch };
    return interpolatePose(this.from, this.to, smootherstep(this.progress));
  }
}
