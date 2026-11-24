import { describe, expect, it } from 'vitest';
import { bindShortcut, eventOrigin, isCharacterPress, isEditableTarget, isShortcutPress } from './keyEvents';

const el = (props: Record<string, unknown>) => props as unknown as EventTarget;

/** シャドウ DOM の内側で起きたイベントのように、`target` はホスト、`composedPath()` の先頭が実際の発生元。 */
function keyEvent(init: Partial<KeyboardEvent>, origin?: EventTarget): KeyboardEvent {
  const e = { code: 'KeyO', repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: null, ...init };
  if (origin) (e as Record<string, unknown>).composedPath = () => [origin];
  return e as unknown as KeyboardEvent;
}

describe('isEditableTarget', () => {
  it('input / textarea / select / contenteditable は入力欄', () => {
    expect(isEditableTarget(el({ tagName: 'INPUT' }))).toBe(true);
    expect(isEditableTarget(el({ tagName: 'textarea' }))).toBe(true);
    expect(isEditableTarget(el({ tagName: 'SELECT' }))).toBe(true);
    expect(isEditableTarget(el({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
    expect(isEditableTarget(el({ tagName: 'DIV', getAttribute: () => '' }))).toBe(true);
    expect(isEditableTarget(el({ tagName: 'DIV', getAttribute: () => 'false' }))).toBe(false);
  });
  it('それ以外・要素でないものは入力欄ではない', () => {
    expect(isEditableTarget(el({ tagName: 'CANVAS' }))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(el({}))).toBe(false);
  });
});

describe('eventOrigin', () => {
  it('composedPath の先頭を優先し、なければ target', () => {
    const host = el({ tagName: 'DIV' });
    const inner = el({ tagName: 'INPUT' });
    expect(eventOrigin(keyEvent({ target: host }, inner))).toBe(inner);
    expect(eventOrigin(keyEvent({ target: host }))).toBe(host);
  });
});

describe('isShortcutPress', () => {
  it('コードが合い、修飾キーも繰り返しもなければ押下とみなす', () => {
    expect(isShortcutPress(keyEvent({}), 'KeyO')).toBe(true);
    expect(isShortcutPress(keyEvent({ code: 'KeyP' }), 'KeyO')).toBe(false);
    expect(isShortcutPress(keyEvent({ repeat: true }), 'KeyO')).toBe(false);
    expect(isShortcutPress(keyEvent({ ctrlKey: true }), 'KeyO')).toBe(false);
    expect(isShortcutPress(keyEvent({ metaKey: true }), 'KeyO')).toBe(false);
    expect(isShortcutPress(keyEvent({ altKey: true }), 'KeyO')).toBe(false);
  });
  it('入力欄は target ではなく発生元で判定する（シャドウ DOM の内側の入力欄でも反応しない）', () => {
    const host = el({ tagName: 'DIV' });
    expect(isShortcutPress(keyEvent({ target: host }, el({ tagName: 'INPUT' })), 'KeyO')).toBe(false);
    expect(isShortcutPress(keyEvent({ target: el({ tagName: 'INPUT' }) }, el({ tagName: 'CANVAS' })), 'KeyO')).toBe(true);
    expect(isShortcutPress(keyEvent({ target: el({ tagName: 'INPUT' }) }), 'KeyO')).toBe(false);
  });
});

describe('bindShortcut', () => {
  it('押下で handler を呼び、返す関数で外せる', () => {
    const listeners = new Set<(e: KeyboardEvent) => void>();
    const win = {
      addEventListener: (_t: string, l: (e: KeyboardEvent) => void) => listeners.add(l),
      removeEventListener: (_t: string, l: (e: KeyboardEvent) => void) => listeners.delete(l),
    };
    let n = 0;
    const unbind = bindShortcut(win as unknown as Window, 'KeyH', () => { n++; });
    for (const l of listeners) l(keyEvent({ code: 'KeyH' }));
    for (const l of listeners) l(keyEvent({ code: 'KeyH', repeat: true }));
    expect(n).toBe(1);
    unbind();
    expect(listeners.size).toBe(0);
  });
});

describe('isCharacterPress', () => {
  const press = (init: Partial<KeyboardEvent> & { altGraph?: boolean }, origin?: EventTarget) => {
    const { altGraph, ...rest } = init;
    return keyEvent({ code: 'Minus', key: '?', shiftKey: true, getModifierState: (m: string) => m === 'AltGraph' && altGraph === true, ...rest }, origin);
  };
  it('物理キーの位置ではなく、入力された文字で判定する', () => {
    expect(isCharacterPress(press({}), '?')).toBe(true);
    expect(isCharacterPress(press({ code: 'Slash', key: '_' }), '?')).toBe(false);
  });
  it('Ctrl・Meta・AltGr でない Alt・リピート・入力欄の中は受けない。AltGr は受ける', () => {
    expect(isCharacterPress(press({ ctrlKey: true }), '?')).toBe(false);
    expect(isCharacterPress(press({ metaKey: true }), '?')).toBe(false);
    expect(isCharacterPress(press({ altKey: true }), '?')).toBe(false);
    expect(isCharacterPress(press({ repeat: true }), '?')).toBe(false);
    expect(isCharacterPress(press({}, el({ tagName: 'INPUT' })), '?')).toBe(false);
    expect(isCharacterPress(press({ ctrlKey: true, altKey: true, altGraph: true }), '?')).toBe(true);
  });
});
