import type { CameraMode } from './cameraRig';

export const MODE_LABEL: Record<CameraMode, string> = { fly: '飛行', overview: '俯瞰' };

/** モードごとの操作説明の項目。 */
const HELP: Record<CameraMode, readonly string[]> = {
  fly: ['WASD 前後左右', 'E Q 上下', 'Shift 加速', 'ドラッグ 視点', 'ホイール 速度', 'T 速度の自動調整', 'H 全体へ戻る', 'O 俯瞰モードへ'],
  overview: ['ドラッグ 点群の中心を回る', 'ホイール 寄る・離れる', 'H 全体へ戻る', 'O 飛行モードへ'],
};

/** 操作説明の項目の区切り。 */
const HELP_SEPARATOR = ' / ';
/** HUD の本文の中で、操作説明の行は 3 行目。 */
const HELP_LINE = 2;
/** 視点の URL パラメータの行（4 行目）。 */
const VIEW_LINE = 3;

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
  /** クラスタの目印が使えるか（L キーの説明を操作説明に含める）。省略時は含めない。 */
  labels?: boolean;
  /** ミニマップがあるか（M キーの説明を操作説明に含める）。省略時は含めない。 */
  minimap?: boolean;
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

/** 操作説明の項目。モードごとの操作に、使える機能（目印・ミニマップ）のキーを続ける。 */
export function hudHelpItems(info: HudInfo): string[] {
  const items = [...HELP[info.mode]];
  if (info.labels) items.push('L 目印の表示');
  if (info.minimap) items.push('M ミニマップ');
  return items;
}

/** HUD の本文（改行区切りの 4 行）。 */
export function formatHud(info: HudInfo): string {
  const auto = info.autoSpeed ? `  ${formatAutoSpeed(info.autoSpeed, info.mode)}` : '';
  return [
    `${info.datasetName}  ${info.pointCount.toLocaleString()} 点  点の大きさ ${info.pointSize.toPrecision(3)}（[ ] で変更）`,
    `モード ${MODE_LABEL[info.mode]}  飛行速度 ${formatSpeed(info.speed)}${auto}`,
    hudHelpItems(info).join(HELP_SEPARATOR),
    `?${info.viewParams}`,
  ].join('\n');
}

const rendered = new WeakMap<HTMLElement, string>();

/**
 * HUD の要素へ本文を出す。文字列は `formatHud` と同じで、操作説明の各項目を折り返さない 1 つのまとまり（span）にして、
 * 幅が足りないときは項目の切れ目（区切りの `/` のあと）で折り返す。内容が変わらなければ、要素には触れない。
 */
export function renderHud(el: HTMLElement, info: HudInfo): void {
  const text = formatHud(info);
  if (rendered.get(el) === text) return;
  rendered.set(el, text);
  const lines = text.split('\n');
  const doc = el.ownerDocument;
  const nodes: Node[] = [];
  lines.forEach((line, i) => {
    if (i > 0) nodes.push(doc.createTextNode('\n'));
    if (i === VIEW_LINE) {
      // 視点の URL パラメータは区切りがないので、幅が足りなければ文字の途中で折り返す（「?」だけが行に残らないように）
      const span = doc.createElement('span');
      span.className = 'hud-view';
      span.textContent = line;
      nodes.push(span);
      return;
    }
    if (i !== HELP_LINE) { nodes.push(doc.createTextNode(line)); return; }
    const items = hudHelpItems(info);
    items.forEach((item, k) => {
      const span = doc.createElement('span');
      span.className = 'hud-item';
      // 区切りは前の項目に付けて、行頭に「/」が来ないようにする（表示される文字列は、項目を ' / ' でつないだものと同じ）
      span.textContent = k < items.length - 1 ? `${item} /` : item;
      nodes.push(span);
      if (k < items.length - 1) nodes.push(doc.createTextNode(' '));
    });
  });
  el.replaceChildren(...nodes);
}
