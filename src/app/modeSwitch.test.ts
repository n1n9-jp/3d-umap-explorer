import { describe, expect, it } from 'vitest';
import { MODE_DESCRIPTION, MODE_ORDER, modeAnnouncement, modeSwitchKey, modeSwitchView } from './modeSwitch';

const key = (init: Partial<KeyboardEvent>) => ({ code: '', key: '', ctrlKey: false, metaKey: false, altKey: false, ...init });

describe('modeSwitchView', () => {
  it('俯瞰・飛行の順に 2 つを並べ、いまのモードだけを選択中にする', () => {
    const v = modeSwitchView('fly');
    expect(v.options.map((o) => o.label)).toEqual(['俯瞰', '飛行']);
    expect(v.options.map((o) => o.checked)).toEqual([false, true]);
    const o = modeSwitchView('overview');
    expect(o.options.map((x) => x.checked)).toEqual([true, false]);
    expect(o.mode).toBe('overview');
  });

  it('それぞれのモードに、何をするものかの短い説明を添える', () => {
    const v = modeSwitchView('overview');
    expect(v.options.map((o) => o.description)).toEqual([MODE_DESCRIPTION.overview, MODE_DESCRIPTION.fly]);
    for (const m of MODE_ORDER) expect(MODE_DESCRIPTION[m].length).toBeGreaterThan(0);
  });

  it('読み上げの文は、カメラのモードの名前と説明', () => {
    expect(modeAnnouncement('fly')).toBe('カメラのモード: 飛行（中へ入って飛ぶ）');
    expect(modeAnnouncement('overview')).toBe('カメラのモード: 俯瞰（外から回して眺める）');
    expect(modeSwitchView('fly').announcement).toBe(modeAnnouncement('fly'));
  });
});

describe('modeSwitchKey', () => {
  it('矢印キーで、もう一方のモードを選ぶ（2 択なので、どちらの向きでも反対側）', () => {
    expect(modeSwitchKey(key({ key: 'ArrowRight', code: 'ArrowRight' }), 'overview')).toEqual({ kind: 'select', mode: 'fly' });
    expect(modeSwitchKey(key({ key: 'ArrowLeft', code: 'ArrowLeft' }), 'fly')).toEqual({ kind: 'select', mode: 'overview' });
    expect(modeSwitchKey(key({ key: 'ArrowDown', code: 'ArrowDown' }), 'fly')).toEqual({ kind: 'select', mode: 'overview' });
    expect(modeSwitchKey(key({ key: 'ArrowUp', code: 'ArrowUp' }), 'overview')).toEqual({ kind: 'select', mode: 'fly' });
  });

  it('Home・End で先頭・末尾', () => {
    expect(modeSwitchKey(key({ key: 'Home', code: 'Home' }), 'fly')).toEqual({ kind: 'select', mode: 'overview' });
    expect(modeSwitchKey(key({ key: 'End', code: 'End' }), 'overview')).toEqual({ kind: 'select', mode: 'fly' });
  });

  it('WASD・E・Q はカメラの操作へ渡さない', () => {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ']) {
      expect(modeSwitchKey(key({ code, key: code.slice(3).toLowerCase() }), 'fly')).toEqual({ kind: 'contain' });
    }
  });

  it('ほかのキー（O・Enter・Space・Tab など）と、修飾キーつきは扱わない', () => {
    for (const [code, k] of [['KeyO', 'o'], ['Enter', 'Enter'], ['Space', ' '], ['Tab', 'Tab'], ['KeyH', 'h']]) {
      expect(modeSwitchKey(key({ code, key: k }), 'fly')).toBeNull();
    }
    expect(modeSwitchKey(key({ code: 'ArrowLeft', key: 'ArrowLeft', altKey: true }), 'fly')).toBeNull();
    expect(modeSwitchKey(key({ code: 'KeyW', key: 'w', ctrlKey: true }), 'fly')).toBeNull();
  });
});
