import type { CameraMode } from './cameraRig';
import { isCharacterPress } from './keyEvents';

/** モードの名前（左上のモードの表示と、操作説明で使う）。 */
export const MODE_LABEL: Record<CameraMode, string> = { fly: '飛行', overview: '俯瞰' };

/** モードごとの操作説明の項目。 */
const HELP: Record<CameraMode, readonly string[]> = {
  fly: ['WASD 前後左右', 'E Q 上下', 'ドラッグ 視点', 'ホイール 速度', 'T 速度の自動調整', 'H 全体へ戻る', 'O 俯瞰モードへ'],
  overview: ['ドラッグ 点群の中心を回る', 'ホイール 寄る・離れる', 'H 全体へ戻る', 'O 飛行モードへ'],
};

/** 操作説明の項目の区切り。 */
const HELP_SEPARATOR = ' / ';
/** 詳細（`formatHudDetail`）の中で、操作説明の行は 2 行目。 */
const HELP_LINE = 1;
/** 視点の URL パラメータの行（詳細の 3 行目）。 */
const VIEW_LINE = 2;
/** 要約の項目の区切り。 */
const SUMMARY_SEPARATOR = '  ';

/** 画面の幅（CSS ピクセル）がこの値以上なら、詳細を開いた状態で始める（index.html の狭い画面の境界と同じ）。 */
export const HUD_DETAIL_OPEN_MIN_WIDTH = 720;

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
  /** 近くの単語の文字の表示があるか（K キーの説明を操作説明に含める。単語のデータセットだけ）。省略時は含めない。 */
  words?: boolean;
  /** 選択中の点の、元のデータで近い点の表示があるか（N キーの説明を操作説明に含める。kNN グラフのあるデータセットだけ）。省略時は含めない。 */
  neighbors?: boolean;
  /** 利用者に知らせる文（単語の文字を作れず丸い点だけで表示しているときなど）。あれば詳細の下に出す（詳細を畳んでいても出す）。 */
  notice?: string;
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

/** 操作説明の項目。モードごとの操作に、使える機能（目印・単語の文字・ミニマップ）のキーを続ける。 */
export function hudHelpItems(info: HudInfo): string[] {
  const items = [...HELP[info.mode]];
  if (info.labels) items.push('L 目印の表示');
  if (info.words) items.push('K 単語の文字');
  if (info.neighbors) items.push('N 元のデータで近い点');
  if (info.minimap) items.push('M ミニマップ');
  return items;
}

/**
 * 要約の項目（飛行速度、自動調整の入切、実速度）。飛んでいる最中に見たい値で、詳細を畳んでいても常に出す。
 * 画面の幅が足りないときは、項目の切れ目で折り返す。
 */
export function hudSummaryParts(info: HudInfo): string[] {
  const parts = [`飛行速度 ${formatSpeed(info.speed)}`]; // モード名は左上の表示（src/app/modeSwitch.ts）に出す
  if (info.autoSpeed) parts.push(...formatAutoSpeed(info.autoSpeed, info.mode).split(SUMMARY_SEPARATOR));
  return parts;
}

/** HUD の要約（1 行。例: `飛行速度 0.150  自動調整 入  実速度 0.0270`）。 */
export function formatHudSummary(info: HudInfo): string {
  return hudSummaryParts(info).join(SUMMARY_SEPARATOR);
}

/** HUD の詳細（開閉できる 3 行）: データセットの名前と点の数・点の大きさ、操作説明、視点の URL パラメータ。 */
export function formatHudDetail(info: HudInfo): string[] {
  return [
    `${info.datasetName}  ${info.pointCount.toLocaleString()} 点  点の大きさ ${info.pointSize.toPrecision(3)}（[ ] で変更）`,
    hudHelpItems(info).join(HELP_SEPARATOR),
    `?${info.viewParams}`,
  ];
}

/** 通知。なければ null。 */
export function formatHudNotice(info: HudInfo): string | null {
  return info.notice ? info.notice : null;
}

/** HUD の全文（改行区切り。データセット・要約・操作説明・視点の 4 行に、通知があれば 5 行目）。画面は要約と詳細を分けて出す。 */
export function formatHud(info: HudInfo): string {
  const [dataset, help, view] = formatHudDetail(info) as [string, string, string];
  const lines = [dataset, formatHudSummary(info), help, view];
  const notice = formatHudNotice(info);
  if (notice) lines.push(notice);
  return lines.join('\n');
}

// ---- 開閉 ----

/** 開閉の既定: 幅が `HUD_DETAIL_OPEN_MIN_WIDTH` 以上なら開く。 */
export function defaultHudExpanded(viewportWidth: number): boolean {
  return viewportWidth >= HUD_DETAIL_OPEN_MIN_WIDTH;
}

/**
 * 詳細の開閉の状態。利用者が操作するまでは、そのときの画面の幅から既定で決める。操作したあとは、画面の幅が変わっても利用者の選択を保つ。
 */
export class HudDisclosure {
  private choice: boolean | null = null;

  /** 利用者が開閉を操作したか。 */
  get userChosen(): boolean {
    return this.choice !== null;
  }

  expanded(viewportWidth: number): boolean {
    return this.choice ?? defaultHudExpanded(viewportWidth);
  }

  /** 利用者の選択として開閉を決める。 */
  set(expanded: boolean): void {
    this.choice = expanded;
  }

  /** 利用者の操作で、いまの状態を反転する。反転後の状態を返す。 */
  toggle(viewportWidth: number): boolean {
    this.choice = !this.expanded(viewportWidth);
    return this.choice;
  }
}

/**
 * `?` の文字を入力した押下か。物理キーの位置ではなく、入力された文字（`e.key`）で見る。
 * US・JIS の Shift + `/`、ドイツ語の Shift + `ß`、フランス語の Shift + `M` など、配列ごとに `?` を打つキーで働き、
 * ほかの配列で Shift + `/` の位置にある文字（`_` など）では働かない。
 * `key` が取れない環境のための、物理キーの位置での予備の判定は置かない（配列によっては、`?` ではない文字で誤って開閉するため）。
 * 修飾キー・リピート・入力欄の扱いは `isCharacterPress`（`keyEvents.ts`）による。
 */
export function isHudToggleKey(e: KeyboardEvent): boolean {
  return isCharacterPress(e, '?');
}

// ---- 画面 ----

/** 検証用に読む、HUD の状態。文面は、畳んでいても読める（要素は DOM に残し、表示だけ隠す）。 */
export interface HudState {
  expanded: boolean;
  /** 利用者が開閉を操作したか（false なら、画面の幅からの既定） */
  userChosen: boolean;
  summary: string;
  /** 詳細の 3 行（データセット、操作説明、視点の URL パラメータ） */
  detail: string[];
  notice: string | null;
  /** HUD の矩形の高さ（CSS ピクセル） */
  height: number;
}

interface HudElements {
  root: HTMLElement;
  toggle: HTMLButtonElement;
  summary: HTMLElement;
  detail: HTMLElement;
  notice: HTMLElement;
}

const HUD_IDS = { toggle: 'hud-toggle', summary: 'hud-summary', detail: 'hud-detail', notice: 'hud-notice' } as const;

function findHudElements(doc: Document): HudElements | null {
  const root = doc.getElementById('hud');
  const toggle = doc.getElementById(HUD_IDS.toggle) as HTMLButtonElement | null;
  const summary = doc.getElementById(HUD_IDS.summary);
  const detail = doc.getElementById(HUD_IDS.detail);
  const notice = doc.getElementById(HUD_IDS.notice);
  return root && toggle && summary && detail && notice ? { root, toggle, summary, detail, notice } : null;
}

/** 読み込みの失敗を HUD に出す。要約と詳細は空にし、失敗は通知の行に出す（詳細を畳んでいても見える）。 */
export function showHudFailure(doc: Document, message: string): void {
  const els = findHudElements(doc);
  const text = `読み込みに失敗しました: ${message}`;
  if (!els) {
    const hud = doc.getElementById('hud');
    if (hud) { hud.textContent = text; hud.classList.add('error'); }
    return;
  }
  els.summary.replaceChildren();
  els.detail.replaceChildren();
  els.notice.textContent = text;
  els.notice.hidden = false;
  els.root.classList.add('error');
}

/**
 * 左下の HUD（index.html の `#hud`）。常に出す要約（飛行速度と自動調整）、開閉できる詳細、畳んでいても出す通知からなる。
 * 開閉は、ボタン（`aria-expanded`）と `toggle()` で行う（`?` の文字のキーは main.ts が `isHudToggleKey` で受けて `toggle()` を呼ぶ）。
 * 内容が変わらなければ、要素には触れない。
 */
export class HudView {
  private readonly els: HudElements;
  private readonly disclosure = new HudDisclosure();
  private shown: boolean | null = null;
  /** 要約の項目（chip）の要素と、いま出している文字。項目の数が変わらなければ、変わった項目だけ書き換える。 */
  private summaryChips: HTMLElement[] = [];
  private summaryTexts: string[] = [];
  /** 詳細の行（`formatHudDetail` の順）の要素と、行ごとにいま出している内容。変わった行だけ書き換える。 */
  private detailRows: HTMLElement[] = [];
  private detailTexts: string[] = [];
  private noticeText: string | null = null;

  constructor(private readonly doc: Document, private readonly viewportWidth: () => number) {
    const els = findHudElements(doc);
    if (!els) throw new Error('HUD の要素（#hud-toggle・#hud-summary・#hud-detail・#hud-notice）が見つかりません');
    this.els = els;
    els.toggle.addEventListener('click', (e) => {
      this.toggle();
      // マウスで押したあとはフォーカスを残さない（移動キーがすぐに効く）。キーボードで押したときは残す
      if (e.detail > 0) els.toggle.blur();
    });
    this.applyExpanded();
  }

  get expanded(): boolean {
    return this.disclosure.expanded(this.viewportWidth());
  }

  /** 利用者の選択として、詳細を開く・畳む。 */
  setExpanded(expanded: boolean): void {
    this.disclosure.set(expanded);
    this.applyExpanded();
  }

  toggle(): void {
    this.disclosure.toggle(this.viewportWidth());
    this.applyExpanded();
  }

  /** 画面の幅が変わったとき。利用者が操作するまでは、新しい幅の既定に合わせる。 */
  resize(): void {
    this.applyExpanded();
  }

  /** 失敗の表示を消す（読み込みに成功したとき）。次の `render` で内容を作り直す。 */
  clearFailure(): void {
    if (!this.els.root.classList.contains('error')) return;
    this.els.root.classList.remove('error');
    this.forgetContent();
  }

  showFailure(message: string): void {
    showHudFailure(this.doc, message);
    this.forgetContent();
  }

  /** 画面の内容を覚えていない状態に戻す（次の `render` で作り直す）。 */
  private forgetContent(): void {
    this.summaryChips = [];
    this.summaryTexts = [];
    this.detailRows = [];
    this.detailTexts = [];
    this.noticeText = null;
  }

  render(info: HudInfo): void {
    const { summary, detail, notice } = this.els;
    this.renderSummary(hudSummaryParts(info), summary);
    this.renderDetail(info, detail);
    const text = formatHudNotice(info);
    if (text !== this.noticeText) {
      this.noticeText = text;
      notice.textContent = text ?? '';
      notice.hidden = text === null;
    }
    this.applyExpanded();
  }

  getState(): HudState {
    const { root, summary, detail, notice } = this.els;
    return {
      expanded: this.shown ?? this.expanded,
      userChosen: this.disclosure.userChosen,
      summary: summary.textContent ?? '',
      detail: [...detail.children].map((c) => c.textContent ?? ''),
      notice: notice.hidden ? null : notice.textContent,
      height: root.getBoundingClientRect().height,
    };
  }

  private span(className: string, text: string): HTMLElement {
    const span = this.doc.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  }

  /** 要約。項目の数が変わったときだけ作り直し、そうでなければ、文字の変わった項目だけ書き換える。 */
  private renderSummary(parts: string[], summary: HTMLElement): void {
    const intact = this.summaryChips.length === parts.length && this.summaryChips.every((c) => c.parentNode === summary);
    if (!intact) {
      const nodes: Node[] = [];
      this.summaryChips = parts.map((part, i) => {
        if (i > 0) nodes.push(this.doc.createTextNode(SUMMARY_SEPARATOR));
        const chip = this.span('hud-chip', part);
        nodes.push(chip);
        return chip;
      });
      this.summaryTexts = [...parts];
      summary.replaceChildren(...nodes);
      return;
    }
    parts.forEach((part, i) => {
      if (part === this.summaryTexts[i]) return;
      this.summaryTexts[i] = part;
      this.summaryChips[i]!.textContent = part;
    });
  }

  /** 詳細の 3 行。行の要素は残し、内容の変わった行だけ書き換える（操作説明は、項目が変わったときだけ項目の要素を作り直す）。 */
  private renderDetail(info: HudInfo, detail: HTMLElement): void {
    const lines = formatHudDetail(info);
    const intact = this.detailRows.length === lines.length && this.detailRows.every((r) => r.parentNode === detail);
    if (!intact) {
      this.detailRows = lines.map((_, i) => this.detailRow(i));
      this.detailTexts = lines.map(() => '');
      detail.replaceChildren(...this.detailRows);
    }
    lines.forEach((line, i) => {
      if (line === this.detailTexts[i]) return;
      this.detailTexts[i] = line;
      const row = this.detailRows[i]!;
      if (i === HELP_LINE) this.fillHelpLine(row, hudHelpItems(info));
      else row.textContent = line;
    });
  }

  private detailRow(i: number): HTMLElement {
    const div = this.doc.createElement('div');
    // 視点の URL パラメータは区切りがないので、幅が足りなければ文字の途中で折り返す（「?」だけが行に残らないように）
    if (i === VIEW_LINE) div.className = 'hud-view';
    return div;
  }

  /** 操作説明の各項目を折り返さない 1 つのまとまりにして、幅が足りないときは項目の切れ目（区切りの `/` のあと）で折り返す。 */
  private fillHelpLine(div: HTMLElement, items: string[]): void {
    const nodes: Node[] = [];
    items.forEach((item, k) => {
      // 区切りは前の項目に付けて、行頭に「/」が来ないようにする（表示される文字列は、項目を ' / ' でつないだものと同じ）
      nodes.push(this.span('hud-item', k < items.length - 1 ? `${item} /` : item));
      if (k < items.length - 1) nodes.push(this.doc.createTextNode(' '));
    });
    div.replaceChildren(...nodes);
  }

  private applyExpanded(): void {
    const expanded = this.expanded;
    if (expanded === this.shown) return;
    this.shown = expanded;
    const { root, toggle, detail } = this.els;
    detail.hidden = !expanded; // 要素は DOM に残す（検証用の getState は、畳んでいても詳細の文面を読める）
    root.dataset.expanded = String(expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.title = expanded ? '操作説明を閉じる（?）' : '操作説明を開く（?）';
  }
}
