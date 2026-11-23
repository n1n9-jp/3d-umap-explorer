import { describe, expect, it } from 'vitest';
import { bindAutoSpeedKey } from './autoSpeedKey';

type Listener = (e: KeyboardEvent) => void;

function fakeWindow() {
  const listeners = new Set<Listener>();
  return {
    addEventListener: (_type: string, l: Listener) => listeners.add(l),
    removeEventListener: (_type: string, l: Listener) => listeners.delete(l),
    fire: (init: Partial<KeyboardEvent>) => {
      for (const l of listeners) l({ code: '', repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: null, ...init } as KeyboardEvent);
    },
    get size() { return listeners.size; },
  };
}

describe('bindAutoSpeedKey', () => {
  it('T で切り替え、修飾キー・押しっぱなしの繰り返し・入力欄では反応しない', () => {
    const win = fakeWindow();
    let toggles = 0;
    const unbind = bindAutoSpeedKey(win as unknown as Window, { toggleAutoSpeed: () => { toggles++; } });
    win.fire({ code: 'KeyT' });
    expect(toggles).toBe(1);
    win.fire({ code: 'KeyT', repeat: true });
    win.fire({ code: 'KeyT', ctrlKey: true });
    win.fire({ code: 'KeyT', metaKey: true });
    win.fire({ code: 'KeyT', altKey: true });
    win.fire({ code: 'KeyT', target: { tagName: 'INPUT' } as unknown as EventTarget });
    win.fire({ code: 'KeyY' });
    expect(toggles).toBe(1);
    unbind();
    expect(win.size).toBe(0);
    win.fire({ code: 'KeyT' });
    expect(toggles).toBe(1);
  });
});
