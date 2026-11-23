import { describe, expect, it } from 'vitest';
import { ProgressAnnouncer, type AnnounceInput } from './progressAnnounce';

const at = (epoch: number, message = ''): AnnounceInput => ({ phase: 'running', epoch, total: 200, message });

describe('ProgressAnnouncer', () => {
  it('5 エポックごとに更新が来ても、読み上げは、開始と 25%・50%・75% と、文の変化だけ', () => {
    const a = new ProgressAnnouncer();
    const spoken: string[] = [];
    spoken.push(...a.next({ phase: 'loading', epoch: 0, total: 200, message: '' }));
    spoken.push(...a.next(at(0)));
    for (let e = 5; e <= 200; e += 5) spoken.push(...a.next(at(e)));
    spoken.push(...a.next({ phase: 'morphing', epoch: 200, total: 200, message: '計算しました（8.0 秒）。' }));
    spoken.push(...a.next({ phase: 'idle', epoch: 200, total: 200, message: '計算しました（8.0 秒）。' }));
    expect(spoken).toEqual(['計算を始めました。', '25%', '50%', '75%', '計算しました（8.0 秒）。']);
  });

  it('同じ状態を何度渡しても、読み上げは増えない', () => {
    const a = new ProgressAnnouncer();
    expect(a.next(at(60))).toEqual(['計算を始めました。', '25%']);
    for (let k = 0; k < 5; k++) expect(a.next(at(60))).toEqual([]);
  });

  it('中断とエラーの文は、変わったときに読み上げる。次の計算では、節目をまた読み上げる', () => {
    const a = new ProgressAnnouncer();
    a.next(at(120));
    expect(a.next({ phase: 'running', epoch: 120, total: 200, message: '中断しています…' })).toEqual(['中断しています…']);
    expect(a.next({ phase: 'idle', epoch: 0, total: 200, message: '計算を中断しました。表示は計算前のままです。' })).toEqual(['計算を中断しました。表示は計算前のままです。']);
    expect(a.next({ phase: 'idle', epoch: 0, total: 200, message: '' })).toEqual([]);
    expect(a.next({ phase: 'loading', epoch: 0, total: 200, message: '' })).toEqual(['計算を始めました。']);
    expect(a.next(at(55))).toEqual(['25%']);
    expect(a.next({ phase: 'idle', epoch: 0, total: 200, message: '計算に失敗しました: だめ' })).toEqual(['計算に失敗しました: だめ']);
  });

  it('節目を飛ばして進んでも（途中の更新が間引かれても）、いまの節目を 1 回だけ読み上げる', () => {
    const a = new ProgressAnnouncer();
    a.next({ phase: 'loading', epoch: 0, total: 200, message: '' });
    expect(a.next(at(160))).toEqual(['75%']);
  });
});
