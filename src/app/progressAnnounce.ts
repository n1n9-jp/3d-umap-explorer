/**
 * UMAP の計算の進捗の読み上げ（スクリーンリーダー向け）。画面の表示（進捗バーと「エポック n / 200」）は細かく更新するが、
 * 読み上げは次のときだけにする（5 エポックごとに読み上げると多すぎるため）。
 *   - 計算の開始
 *   - 進捗の大きな節目（25%・50%・75%）
 *   - 画面の下の文（完了・中断・エラー・保持した結果の表示など）が変わったとき
 */

/** 進捗を読み上げる間隔（%） */
export const ANNOUNCE_STEP_PERCENT = 25;

export interface AnnounceInput {
  phase: 'idle' | 'loading' | 'running' | 'morphing';
  epoch: number;
  total: number;
  /** パネルの下の文（完了・中断・エラーなど。なければ空） */
  message: string;
}

export class ProgressAnnouncer {
  private active = false;
  private milestone = 0;
  private lastMessage = '';

  /** 状態を渡す（変化のたびに何度呼んでもよい）。いま読み上げる文を返す（なければ空の配列）。 */
  next(v: AnnounceInput): string[] {
    const out: string[] = [];
    const busy = v.phase === 'loading' || v.phase === 'running';
    if (busy && !this.active) {
      this.active = true;
      this.milestone = 0;
      out.push('計算を始めました。');
    }
    if (v.phase === 'running' && v.total > 0) {
      const pct = Math.floor((100 * v.epoch) / v.total);
      const step = Math.floor(pct / ANNOUNCE_STEP_PERCENT) * ANNOUNCE_STEP_PERCENT;
      // 100% は、続く完了の文（message）が伝えるので、節目には含めない
      if (step > this.milestone && step < 100) {
        this.milestone = step;
        out.push(`${step}%`);
      }
    }
    if (v.phase === 'idle') {
      this.active = false;
      this.milestone = 0;
    }
    if (v.message !== this.lastMessage) {
      this.lastMessage = v.message;
      if (v.message !== '') out.push(v.message);
    }
    return out;
  }
}
