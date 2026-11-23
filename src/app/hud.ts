import type { CameraMode } from './cameraRig';

export const MODE_LABEL: Record<CameraMode, string> = { fly: '飛行', overview: '俯瞰' };

const HELP: Record<CameraMode, string> = {
  fly: 'WASD 前後左右 / E Q 上下 / Shift 加速 / ドラッグ 視点 / ホイール 速度 / T 速度の自動調整 / H 全体へ戻る / O 俯瞰モードへ',
  overview: 'ドラッグ 点群の中心を回る / ホイール 寄る・離れる / H 全体へ戻る / O 飛行モードへ',
};

export interface HudInfo {
  datasetName: string;
  pointCount: number;
  pointSize: number;
  mode: CameraMode;
  /** 飛行の基準速度（単位/秒）。ユーザーがホイールで決める値。 */
  speed: number;
  /** 速度の自動調整。省略時は表示しない。 */
  autoSpeed?: HudAutoSpeed;
  /** `pos=…&look=…` 形式の現在の視点。 */
  viewParams: string;
}

export interface HudAutoSpeed {
  /** 使えるか（データセットに `density` があるか）。 */
  available: boolean;
  enabled: boolean;
  /** 実際の移動速度（`speed × speedScale`）。 */
  effectiveSpeed: number;
}

/** 速度は桁をそろえて 3 桁の有効数字で見せる（0.005〜2 の範囲）。 */
export function formatSpeed(speed: number): string {
  return speed.toPrecision(3);
}

/** 自動調整の表示（例: `自動調整 入  実速度 0.0270`）。実速度は飛行モードでだけ出す。 */
export function formatAutoSpeed(auto: HudAutoSpeed, mode: CameraMode): string {
  if (!auto.available) return '自動調整 なし';
  const state = `自動調整 ${auto.enabled ? '入' : '切'}`;
  return mode === 'fly' ? `${state}  実速度 ${formatSpeed(auto.effectiveSpeed)}` : state;
}

/** HUD の本文（改行区切りの 4 行）。 */
export function formatHud(info: HudInfo): string {
  const auto = info.autoSpeed ? `  ${formatAutoSpeed(info.autoSpeed, info.mode)}` : '';
  return [
    `${info.datasetName}  ${info.pointCount.toLocaleString()} 点  点の大きさ ${info.pointSize.toPrecision(3)}（[ ] で変更）`,
    `モード ${MODE_LABEL[info.mode]}  飛行速度 ${formatSpeed(info.speed)}${auto}`,
    HELP[info.mode],
    `?${info.viewParams}`,
  ].join('\n');
}
