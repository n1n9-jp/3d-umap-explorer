import { FLIGHT_ORIENT_END, flightEase, flightEaseDerivative, reducedFlightDuration, scaledFlightDuration } from '../controls/easing';
import { directionFromAngles, type Vec3, type ViewAngles } from '../render/view';

/**
 * 現在の視点からホームの視点へ、位置と向きを一緒に補間する移動。DOM にも three.js にも依存しない。
 * 向きは yaw と pitch で補間するので、途中の姿勢も横傾き（roll）を持たない（飛行モードへ切り替えても跳ばない）。
 * yaw は短いほうの回り方で補間する。進み方は、点や塊へ飛ぶ移動（`FlyMotion.flyTo`）とそろえ、位置は
 * `flightEase`（`f(t) = 1 − (1−t)³(1+3t)`。速さの山が進みの 1/3 で、長く減速して止まる）、向きは
 * `f(t / 0.7)`（進みの 70% で合わせ終え、全体が見える向きを早めに捉える）。
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

/** 角度差を (-π, π] に畳む。 */
function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = ((a % twoPi) + twoPi) % twoPi;
  if (r > Math.PI) r -= twoPi;
  return r;
}

/**
 * `from` から `to` への姿勢。位置は進み具合 `t`（0〜1、イージング済み）、向き（yaw・pitch）は `orient`
 * （0〜1、イージング済み。省略すると `t`）で補間する。
 */
export function interpolatePose(from: FlightPose, to: FlightPose, t: number, orient: number = t): FlightPose {
  return {
    position: [
      from.position[0] + (to.position[0] - from.position[0]) * t,
      from.position[1] + (to.position[1] - from.position[1]) * t,
      from.position[2] + (to.position[2] - from.position[2]) * t,
    ],
    yaw: from.yaw + wrapAngle(to.yaw - from.yaw) * orient,
    pitch: from.pitch + (to.pitch - from.pitch) * orient,
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

  /**
   * いまの移動の速度（単位/秒。位置の式 `from + (to − from)·f(t)` の時間微分 `(to − from)·f′(t) / T`）。
   * 着いたあと（所要時間 0 を含む）は 0。操作で中断したとき、その瞬間の速度を引き継ぐために使う。
   */
  velocity(): Vec3 {
    if (this.done) return [0, 0, 0];
    const k = flightEaseDerivative(this.progress) / this.durationSeconds;
    return [
      (this.to.position[0] - this.from.position[0]) * k,
      (this.to.position[1] - this.from.position[1]) * k,
      (this.to.position[2] - this.from.position[2]) * k,
    ];
  }

  /** `dt` 秒進めて、そのときの姿勢を返す。`dt` が負・非有限なら進めない。終点では `to` をそのまま返す。 */
  advance(dt: number): FlightPose {
    if (Number.isFinite(dt) && dt > 0) this.elapsed += dt;
    if (this.done) return { position: [...this.to.position], yaw: this.to.yaw, pitch: this.to.pitch };
    const t = this.progress;
    return interpolatePose(this.from, this.to, flightEase(t), flightEase(t / FLIGHT_ORIENT_END));
  }
}
