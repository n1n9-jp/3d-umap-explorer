import { describe, expect, it } from 'vitest';
import {
  defaultHudExpanded, formatHud, formatHudDetail, formatHudNotice, formatHudSummary, formatSpeed, hudHelpItems, hudSummaryParts,
  HudDisclosure, HUD_DETAIL_OPEN_MIN_WIDTH, isHudToggleKey,
} from './hud';

const base = { datasetName: 'MNIST 10k', pointCount: 10000, pointSize: 0.004, speed: 0.15, viewParams: 'pos=0,0,2.6&look=0,0,2.35' };

describe('formatHud', () => {
  it('飛行モードでは、速度・操作方法・既存の表示を 4 行で出す（モード名は左上の表示に出すので含めない）', () => {
    const lines = formatHud({ ...base, mode: 'fly' }).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('MNIST 10k');
    expect(lines[0]).toContain('10,000 点');
    expect(lines[0]).toContain('点の大きさ 0.00400');
    expect(lines[1]).toBe('飛行速度 0.150'); // 全文では 2 行目（画面では、要約を先頭に出す）
    expect(lines.join('\n')).not.toMatch(/モード (飛行|俯瞰)/);
    expect(lines[2]).toContain('WASD');
    expect(lines[2]).toContain('H 全体へ戻る');
    expect(lines[2]).toContain('O 俯瞰モードへ');
    expect(lines[3]).toBe('?pos=0,0,2.6&look=0,0,2.35');
  });

  it('俯瞰モードでは、俯瞰の操作方法と飛行モードへ戻るキーを出す', () => {
    const lines = formatHud({ ...base, mode: 'overview' }).split('\n');
    expect(lines[1]).toBe('飛行速度 0.150');
    expect(lines.join('\n')).not.toMatch(/モード (飛行|俯瞰)/);
    expect(lines[2]).toContain('H 全体へ戻る');
    expect(lines[2]).toContain('O 飛行モードへ');
  });
});

describe('formatHud の通知', () => {
  it('通知があれば 5 行目に出し、なければ 4 行のまま', () => {
    expect(formatHud({ ...base, mode: 'fly' }).split('\n')).toHaveLength(4);
    const lines = formatHud({ ...base, mode: 'fly', notice: '単語の文字を表示できません（x）。丸い点だけで表示しています' }).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('単語の文字を表示できません（x）。丸い点だけで表示しています');
    expect(lines.slice(0, 4)).toEqual(formatHud({ ...base, mode: 'fly' }).split('\n'));
  });
});

describe('formatHud の自動調整', () => {
  it('飛行モードでは、ホイールで決めた速度に続けて、自動調整の入切と実速度を出す', () => {
    const lines = formatHud({ ...base, mode: 'fly', autoSpeed: { available: true, enabled: true, effectiveSpeed: 0.027 } }).split('\n');
    expect(lines[1]).toBe('飛行速度 0.150  自動調整 入  実速度 0.0270');
    expect(lines[2]).toContain('T 速度の自動調整');
    const off = formatHud({ ...base, mode: 'fly', autoSpeed: { available: true, enabled: false, effectiveSpeed: 0.15 } }).split('\n');
    expect(off[1]).toBe('飛行速度 0.150  自動調整 切  実速度 0.150');
  });

  it('俯瞰モードでは実速度を出さない。density がないデータセットでは「なし」', () => {
    const ov = formatHud({ ...base, mode: 'overview', autoSpeed: { available: true, enabled: true, effectiveSpeed: 0.027 } }).split('\n');
    expect(ov[1]).toBe('飛行速度 0.150  自動調整 入');
    const none = formatHud({ ...base, mode: 'fly', autoSpeed: { available: false, enabled: false, effectiveSpeed: 0.15 } }).split('\n');
    expect(none[1]).toBe('飛行速度 0.150  自動調整 なし');
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

describe('formatHud の機能の説明（単語の文字）', () => {
  it('単語のデータセットでは K キーを、目印とミニマップの間に含める', () => {
    const line = formatHud({ ...base, mode: 'fly', labels: true, words: true, minimap: true }).split('\n')[2]!;
    expect(line.endsWith('O 俯瞰モードへ / L 目印の表示 / K 単語の文字 / M ミニマップ')).toBe(true);
    const overview = formatHud({ ...base, mode: 'overview', labels: true, words: true, minimap: true }).split('\n')[2]!;
    expect(overview).toContain('K 単語の文字');
  });
  it('画像のデータセット（words が false・省略）では含めない', () => {
    expect(formatHud({ ...base, mode: 'fly', labels: true, words: false, minimap: true }).split('\n')[2]).not.toContain('K 単語');
    expect(formatHud({ ...base, mode: 'fly', labels: true, minimap: true }).split('\n')[2]).not.toContain('K 単語');
  });
});

describe('HUD の要約（常に出す 1 行）', () => {
  it('飛行速度だけ（自動調整の情報がないとき）', () => {
    expect(formatHudSummary({ ...base, mode: 'fly' })).toBe('飛行速度 0.150');
    expect(hudSummaryParts({ ...base, mode: 'fly' })).toEqual(['飛行速度 0.150']);
  });
  it('飛行モードでは、自動調整の入切と実速度を続ける。項目の切れ目（折り返してよい位置）が分かる', () => {
    const info = { ...base, mode: 'fly' as const, autoSpeed: { available: true, enabled: true, effectiveSpeed: 0.027 } };
    expect(formatHudSummary(info)).toBe('飛行速度 0.150  自動調整 入  実速度 0.0270');
    expect(hudSummaryParts(info)).toEqual(['飛行速度 0.150', '自動調整 入', '実速度 0.0270']);
  });
  it('俯瞰モードでは実速度を出さない。自動調整が使えないデータセットでは「なし」', () => {
    expect(hudSummaryParts({ ...base, mode: 'overview', autoSpeed: { available: true, enabled: false, effectiveSpeed: 0.1 } })).toEqual(['飛行速度 0.150', '自動調整 切']);
    expect(formatHudSummary({ ...base, mode: 'fly', autoSpeed: { available: false, enabled: false, effectiveSpeed: 0.15 } })).toBe('飛行速度 0.150  自動調整 なし');
  });
  it('要約にデータセットの名前・操作説明・視点の URL パラメータは入らない（詳細に出す）', () => {
    const t = formatHudSummary({ ...base, mode: 'fly', labels: true, minimap: true });
    expect(t).not.toContain('MNIST');
    expect(t).not.toContain('WASD');
    expect(t).not.toContain('?pos=');
    expect(t.split('\n')).toHaveLength(1);
  });
});

describe('HUD の詳細（開閉できる 3 行）', () => {
  it('データセットの名前と点の数・点の大きさ、操作説明、視点の URL パラメータの順。文面は従来と同じ', () => {
    const d = formatHudDetail({ ...base, mode: 'fly' });
    expect(d).toHaveLength(3);
    expect(d[0]).toBe('MNIST 10k  10,000 点  点の大きさ 0.00400（[ ] で変更）');
    expect(d[1]).toBe(hudHelpItems({ ...base, mode: 'fly' }).join(' / '));
    expect(d[1]).toContain('O 俯瞰モードへ');
    expect(d[2]).toBe('?pos=0,0,2.6&look=0,0,2.35');
  });
  it('操作説明は、使える機能のキーを含める（俯瞰モードの項目に切り替わる）', () => {
    const d = formatHudDetail({ ...base, mode: 'overview', labels: true, words: true, neighbors: true, minimap: true });
    expect(d[1]).toBe('ドラッグ 点群の中心を回る / ホイール 寄る・離れる / H 全体へ戻る / O 飛行モードへ / L 目印の表示 / K 単語の文字 / N 元のデータで近い点 / M ミニマップ');
  });
  it('速度は詳細に入らない（要約に出す）', () => {
    expect(formatHudDetail({ ...base, mode: 'fly' }).join('\n')).not.toContain('飛行速度');
  });
});

describe('HUD の通知', () => {
  it('通知は詳細とは別に取り出せる（畳んでいても出す）。なければ null', () => {
    expect(formatHudNotice({ ...base, mode: 'fly' })).toBeNull();
    expect(formatHudNotice({ ...base, mode: 'fly', notice: '' })).toBeNull();
    expect(formatHudNotice({ ...base, mode: 'fly', notice: '読み込みに失敗しました: x' })).toBe('読み込みに失敗しました: x');
  });
  it('通知は要約にも詳細にも入らない', () => {
    const info = { ...base, mode: 'fly' as const, notice: '単語の文字を表示できません' };
    expect(formatHudSummary(info)).not.toContain('単語の文字');
    expect(formatHudDetail(info).join('\n')).not.toContain('単語の文字');
  });
  it('全文（formatHud）は、データセット・要約・操作説明・視点の 4 行と、通知があれば 5 行目', () => {
    const lines = formatHud({ ...base, mode: 'fly', notice: 'n' }).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe(formatHudSummary({ ...base, mode: 'fly' }));
    expect(lines[4]).toBe('n');
  });
});

describe('HUD の開閉の既定', () => {
  it(`幅が ${HUD_DETAIL_OPEN_MIN_WIDTH}px 以上なら開き、未満なら畳む`, () => {
    expect(HUD_DETAIL_OPEN_MIN_WIDTH).toBe(720);
    expect(defaultHudExpanded(1280)).toBe(true);
    expect(defaultHudExpanded(720)).toBe(true);
    expect(defaultHudExpanded(719)).toBe(false);
    expect(defaultHudExpanded(360)).toBe(false);
  });
  it('利用者が操作するまでは、画面の幅が変わると既定も変わる', () => {
    const d = new HudDisclosure();
    expect(d.userChosen).toBe(false);
    expect(d.expanded(1280)).toBe(true);
    expect(d.expanded(360)).toBe(false);
    expect(d.expanded(900)).toBe(true);
  });
  it('操作すると、いまの状態を反転する。以後は画面の幅が変わっても、利用者の選択を保つ', () => {
    const narrow = new HudDisclosure();
    expect(narrow.toggle(360)).toBe(true); // 畳んで始まった → 開く
    expect(narrow.userChosen).toBe(true);
    expect(narrow.expanded(360)).toBe(true);
    expect(narrow.expanded(1280)).toBe(true);
    expect(narrow.toggle(1280)).toBe(false);
    expect(narrow.expanded(360)).toBe(false);
    expect(narrow.expanded(1280)).toBe(false);
    const wide = new HudDisclosure();
    expect(wide.toggle(1280)).toBe(false); // 開いて始まった → 畳む
    expect(wide.expanded(360)).toBe(false);
    expect(wide.expanded(1920)).toBe(false);
  });
  it('set は利用者の選択として決める（既定と同じ値でも、以後は保つ）', () => {
    const d = new HudDisclosure();
    d.set(true);
    expect(d.userChosen).toBe(true);
    expect(d.expanded(360)).toBe(true);
    d.set(false);
    expect(d.expanded(1280)).toBe(false);
  });
});

describe('? キー（Shift + /）', () => {
  const key = (init: Partial<KeyboardEvent> & { tag?: string }) => {
    const { tag, ...rest } = init;
    return { code: 'Slash', key: '?', shiftKey: true, repeat: false, ctrlKey: false, metaKey: false, altKey: false,
      target: { tagName: tag ?? 'BODY' }, composedPath: () => [], ...rest } as unknown as KeyboardEvent;
  };
  it('Shift + / で押したときだけ働く', () => {
    expect(isHudToggleKey(key({}))).toBe(true);
    expect(isHudToggleKey(key({ shiftKey: false, key: '/' }))).toBe(false); // 修飾キーなしの /
    expect(isHudToggleKey(key({ code: 'KeyO' }))).toBe(false);
  });
  it('押しっぱなしの繰り返し・Ctrl・Meta・Alt つきは受けない', () => {
    expect(isHudToggleKey(key({ repeat: true }))).toBe(false);
    expect(isHudToggleKey(key({ ctrlKey: true }))).toBe(false);
    expect(isHudToggleKey(key({ metaKey: true }))).toBe(false);
    expect(isHudToggleKey(key({ altKey: true }))).toBe(false);
  });
  it('入力欄（input・textarea・select）の中の入力は受けない', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isHudToggleKey(key({ tag }))).toBe(false);
  });
});
