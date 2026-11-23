import { describe, expect, it } from 'vitest';
import { formatHud, formatSpeed } from './hud';

const base = { datasetName: 'MNIST 10k', pointCount: 10000, pointSize: 0.004, speed: 0.15, viewParams: 'pos=0,0,2.6&look=0,0,2.35' };

describe('formatHud', () => {
  it('飛行モードでは、モード・速度・操作方法・既存の表示を 4 行で出す', () => {
    const lines = formatHud({ ...base, mode: 'fly' }).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('MNIST 10k');
    expect(lines[0]).toContain('10,000 点');
    expect(lines[0]).toContain('点の大きさ 0.00400');
    expect(lines[1]).toBe('モード 飛行  飛行速度 0.150');
    expect(lines[2]).toContain('WASD');
    expect(lines[2]).toContain('O 俯瞰モードへ');
    expect(lines[3]).toBe('?pos=0,0,2.6&look=0,0,2.35');
  });

  it('俯瞰モードでは、俯瞰の操作方法と飛行モードへ戻るキーを出す', () => {
    const lines = formatHud({ ...base, mode: 'overview' }).split('\n');
    expect(lines[1]).toContain('モード 俯瞰');
    expect(lines[2]).toContain('O 飛行モードへ');
  });
});

describe('formatSpeed', () => {
  it('3 桁の有効数字にする', () => {
    expect(formatSpeed(0.005)).toBe('0.00500');
    expect(formatSpeed(2)).toBe('2.00');
  });
});
