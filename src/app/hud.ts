import type { CameraMode } from './cameraRig';

export const MODE_LABEL: Record<CameraMode, string> = { fly: '飛行', overview: '俯瞰' };

const HELP: Record<CameraMode, string> = {
  fly: 'WASD 前後左右 / E Q 上下 / Shift 加速 / ドラッグ 視点 / ホイール 速度 / O 俯瞰モードへ',
  overview: 'ドラッグ 点群の中心を回る / ホイール 寄る・離れる / O 飛行モードへ',
};

export interface HudInfo {
  datasetName: string;
  pointCount: number;
  pointSize: number;
  mode: CameraMode;
  /** 飛行の基準速度（単位/秒）。 */
  speed: number;
  /** `pos=…&look=…` 形式の現在の視点。 */
  viewParams: string;
}

/** 速度は桁をそろえて 3 桁の有効数字で見せる（0.005〜2 の範囲）。 */
export function formatSpeed(speed: number): string {
  return speed.toPrecision(3);
}

/** HUD の本文（改行区切りの 4 行）。 */
export function formatHud(info: HudInfo): string {
  return [
    `${info.datasetName}  ${info.pointCount.toLocaleString()} 点  点の大きさ ${info.pointSize.toPrecision(3)}（[ ] で変更）`,
    `モード ${MODE_LABEL[info.mode]}  飛行速度 ${formatSpeed(info.speed)}`,
    HELP[info.mode],
    `?${info.viewParams}`,
  ].join('\n');
}
