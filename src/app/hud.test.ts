import { describe, expect, it } from 'vitest';
import { formatHud, formatSpeed, hudHelpItems } from './hud';

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
    expect(lines[2]).toContain('H 全体へ戻る');
    expect(lines[2]).toContain('O 俯瞰モードへ');
    expect(lines[3]).toBe('?pos=0,0,2.6&look=0,0,2.35');
  });

  it('俯瞰モードでは、俯瞰の操作方法と飛行モードへ戻るキーを出す', () => {
    const lines = formatHud({ ...base, mode: 'overview' }).split('\n');
    expect(lines[1]).toContain('モード 俯瞰');
    expect(lines[2]).toContain('H 全体へ戻る');
    expect(lines[2]).toContain('O 飛行モードへ');
  });
});

describe('formatHud の自動調整', () => {
  it('飛行モードでは、ホイールで決めた速度に続けて、自動調整の入切と実速度を出す', () => {
    const lines = formatHud({ ...base, mode: 'fly', autoSpeed: { available: true, enabled: true, effectiveSpeed: 0.027 } }).split('\n');
    expect(lines[1]).toBe('モード 飛行  飛行速度 0.150  自動調整 入  実速度 0.0270');
    expect(lines[2]).toContain('T 速度の自動調整');
    const off = formatHud({ ...base, mode: 'fly', autoSpeed: { available: true, enabled: false, effectiveSpeed: 0.15 } }).split('\n');
    expect(off[1]).toBe('モード 飛行  飛行速度 0.150  自動調整 切  実速度 0.150');
  });

  it('俯瞰モードでは実速度を出さない。density がないデータセットでは「なし」', () => {
    const ov = formatHud({ ...base, mode: 'overview', autoSpeed: { available: true, enabled: true, effectiveSpeed: 0.027 } }).split('\n');
    expect(ov[1]).toBe('モード 俯瞰  飛行速度 0.150  自動調整 入');
    const none = formatHud({ ...base, mode: 'fly', autoSpeed: { available: false, enabled: false, effectiveSpeed: 0.15 } }).split('\n');
    expect(none[1]).toBe('モード 飛行  飛行速度 0.150  自動調整 なし');
  });
});

describe('formatSpeed', () => {
  it('3 桁の有効数字にする', () => {
    expect(formatSpeed(0.005)).toBe('0.00500');
    expect(formatSpeed(2)).toBe('2.00');
  });
});

describe('formatHud の機能の説明（目印・ミニマップ）', () => {
  it('機能の有無を引数で受け取り、操作説明の行に L・M キーを含める', () => {
    const lines = formatHud({ ...base, mode: 'fly', labels: true, minimap: true }).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[2].endsWith('O 俯瞰モードへ / L 目印の表示 / M ミニマップ')).toBe(true);
    expect(lines[3]).toBe('?pos=0,0,2.6&look=0,0,2.35');
  });
  it('俯瞰モードでも含める', () => {
    const lines = formatHud({ ...base, mode: 'overview', labels: true, minimap: true }).split('\n');
    expect(lines[2].endsWith('O 飛行モードへ / L 目印の表示 / M ミニマップ')).toBe(true);
  });
  it('使えない機能（クラスタのないデータセット）は含めない。省略時もどちらも含めない', () => {
    const noLabels = formatHud({ ...base, mode: 'fly', labels: false, minimap: true }).split('\n')[2]!;
    expect(noLabels).not.toContain('L 目印');
    expect(noLabels.endsWith('O 俯瞰モードへ / M ミニマップ')).toBe(true);
    const none = formatHud({ ...base, mode: 'fly' }).split('\n')[2]!;
    expect(none).not.toContain('L 目印');
    expect(none).not.toContain('M ミニマップ');
  });
  it('操作説明の項目は ` / ` でつなぐ。項目の中に区切りは含まれない', () => {
    const items = hudHelpItems({ ...base, mode: 'fly', labels: true, minimap: true });
    expect(items.every((x) => !x.includes(' / '))).toBe(true);
    expect(formatHud({ ...base, mode: 'fly', labels: true, minimap: true }).split('\n')[2]).toBe(items.join(' / '));
  });
});
