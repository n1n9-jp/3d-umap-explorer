import { describe, expect, it } from 'vitest';
import { HudView, type HudInfo } from './hud';

/** DOM のライブラリを使わずに HudView を動かすための、最小の偽の DOM（要素の同一性と子の付け替えを見る）。 */
class FakeText {
  parentNode: FakeEl | null = null;
  constructor(public data: string) {}
  get textContent(): string { return this.data; }
}

class FakeEl {
  parentNode: FakeEl | null = null;
  nodes: (FakeEl | FakeText)[] = [];
  className = '';
  hidden = false;
  title = '';
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  private classes = new Set<string>();
  classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    contains: (c: string) => this.classes.has(c),
  };
  constructor(public id = '') {}
  get children(): FakeEl[] { return this.nodes.filter((n): n is FakeEl => n instanceof FakeEl); }
  get textContent(): string { return this.nodes.map((n) => n.textContent).join(''); }
  set textContent(text: string) { this.replaceChildren(...(text === '' ? [] : [new FakeText(text)])); }
  replaceChildren(...nodes: (FakeEl | FakeText)[]): void {
    for (const n of this.nodes) n.parentNode = null;
    this.nodes = nodes;
    for (const n of nodes) n.parentNode = this;
  }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  addEventListener(): void {}
  blur(): void {}
  getBoundingClientRect(): { height: number } { return { height: 0 }; }
}

function makeDoc(): { doc: Document; byId: Record<string, FakeEl> } {
  const ids = ['hud', 'hud-toggle', 'hud-summary', 'hud-detail', 'hud-notice'];
  const byId = Object.fromEntries(ids.map((id) => [id, new FakeEl(id)])) as Record<string, FakeEl>;
  const doc = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: () => new FakeEl(),
    createTextNode: (t: string) => new FakeText(t),
  };
  byId['hud-notice']!.hidden = true; // index.html と同じく、通知は隠して始まる
  byId['hud-detail']!.hidden = true;
  return { doc: doc as unknown as Document, byId };
}

const info: HudInfo = {
  datasetName: 'MNIST 10k', pointCount: 10000, pointSize: 0.004, mode: 'fly', speed: 0.15,
  autoSpeed: { available: true, enabled: true, effectiveSpeed: 0.027 }, labels: true, minimap: true,
  viewParams: 'pos=0,0,2.6&look=0,0,2.35',
};

function setup() {
  const { doc, byId } = makeDoc();
  const view = new HudView(doc, () => 1280);
  view.render(info);
  const detail = byId['hud-detail']!;
  const summary = byId['hud-summary']!;
  return { view, detail, summary, byId };
}

describe('HudView の描画（行ごとの更新）', () => {
  it('詳細は 3 行。最初の描画で文面が入る', () => {
    const { view } = setup();
    const s = view.getState();
    expect(s.detail).toHaveLength(3);
    expect(s.detail[0]).toContain('MNIST 10k');
    expect(s.detail[1]).toContain('O 俯瞰モードへ');
    expect(s.detail[2]).toBe('?pos=0,0,2.6&look=0,0,2.35');
    expect(s.summary).toBe('飛行速度 0.150  自動調整 入  実速度 0.0270');
  });

  it('同じ内容で描き直しても、行の要素も、操作説明の項目の要素も、そのまま', () => {
    const { view, detail } = setup();
    const rows = detail.children;
    const items = rows[1]!.children;
    view.render({ ...info });
    expect(detail.children).toEqual(rows);
    expect(detail.children.every((r, i) => r === rows[i])).toBe(true);
    expect(detail.children[1]!.children.every((c, i) => c === items[i])).toBe(true);
  });

  it('視点の行だけが変わったとき、ほかの行の要素と操作説明の項目の要素は作り直されない', () => {
    const { view, detail } = setup();
    const rows = [...detail.children];
    const items = [...rows[1]!.children];
    expect(items.length).toBeGreaterThan(5);
    view.render({ ...info, viewParams: 'pos=1,0,2.6&look=0,0,2.35' });
    expect(detail.children).toHaveLength(3);
    detail.children.forEach((r, i) => expect(r).toBe(rows[i]));
    rows[1]!.children.forEach((c, i) => expect(c).toBe(items[i]));
    expect(view.getState().detail[2]).toBe('?pos=1,0,2.6&look=0,0,2.35');
  });

  it('操作説明が変わったとき（モードの切り替え）は、その行の中身だけを作り直す', () => {
    const { view, detail } = setup();
    const rows = [...detail.children];
    const dataset = rows[0]!.nodes[0];
    const viewLine = rows[2]!.nodes[0];
    const oldItems = [...rows[1]!.children];
    view.render({ ...info, mode: 'overview' });
    detail.children.forEach((r, i) => expect(r).toBe(rows[i])); // 行の要素は同じ
    expect(rows[0]!.nodes[0]).toBe(dataset); // 変わらない行の文字も触らない
    expect(rows[2]!.nodes[0]).toBe(viewLine);
    expect(rows[1]!.children[0]).not.toBe(oldItems[0]);
    expect(view.getState().detail[1]).toContain('O 飛行モードへ');
  });

  it('データセットの行だけが変わったとき、ほかの行には触らない', () => {
    const { view, detail } = setup();
    const rows = [...detail.children];
    const items = [...rows[1]!.children];
    const viewLine = rows[2]!.nodes[0];
    view.render({ ...info, pointSize: 0.01 });
    expect(rows[1]!.children.every((c, i) => c === items[i])).toBe(true);
    expect(rows[2]!.nodes[0]).toBe(viewLine);
    expect(view.getState().detail[0]).toContain('0.0100');
  });

  it('要約は、変わった項目だけ書き換え、項目の要素は同じまま。項目の数が変わったときは作り直す', () => {
    const { view, summary } = setup();
    const chips = [...summary.children];
    expect(chips).toHaveLength(3);
    view.render({ ...info, autoSpeed: { available: true, enabled: true, effectiveSpeed: 0.05 } });
    summary.children.forEach((c, i) => expect(c).toBe(chips[i]));
    expect(view.getState().summary).toBe('飛行速度 0.150  自動調整 入  実速度 0.0500');
    view.render({ ...info, mode: 'overview' });
    expect(summary.children).toHaveLength(2);
    expect(view.getState().summary).toBe('飛行速度 0.150  自動調整 入');
  });

  it('通知は、文面が変わったときだけ書き換え、なければ隠す', () => {
    const { view, byId } = setup();
    const notice = byId['hud-notice']!;
    expect(view.getState().notice).toBeNull();
    view.render({ ...info, notice: 'n1' });
    expect(view.getState().notice).toBe('n1');
    const text = notice.nodes[0];
    view.render({ ...info, notice: 'n1' });
    expect(notice.nodes[0]).toBe(text);
    view.render({ ...info });
    expect(notice.hidden).toBe(true);
  });

  it('失敗の表示のあと、clearFailure で消してから描くと、詳細の行を作り直して表示する', () => {
    const { view, detail } = setup();
    view.showFailure('x');
    expect(detail.children).toHaveLength(0);
    view.clearFailure();
    view.render(info);
    expect(detail.children).toHaveLength(3);
    expect(view.getState().detail[2]).toBe('?pos=0,0,2.6&look=0,0,2.35');
  });
});
