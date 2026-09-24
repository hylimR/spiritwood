/**
 * A minimal fake DOM for the HUD, menu and debug-overlay tests (no jsdom in this repo): elements with a
 * class list, children, text, attributes and listeners, a document that creates them, and counters of
 * class-list writes so tests can assert "touch the DOM only when the value changes".
 */

export class FakeClassList {
  private readonly set = new Set<string>();
  writes = 0;

  add(...names: string[]): void {
    this.writes++;
    for (const n of names) this.set.add(n);
  }

  remove(...names: string[]): void {
    this.writes++;
    for (const n of names) this.set.delete(n);
  }

  toggle(name: string, force?: boolean): boolean {
    this.writes++;
    const on = force ?? !this.set.has(name);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }

  contains(name: string): boolean {
    return this.set.has(name);
  }

  /** Replace from a className string (no write counted). */
  reset(value: string): void {
    this.set.clear();
    for (const n of value.split(/\s+/)) if (n) this.set.add(n);
  }

  toString(): string {
    return [...this.set].join(' ');
  }
}

type Child = FakeElement | string;

export class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly classList: FakeClassList = new FakeClassList();
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((e: { detail: number; stopPropagation(): void }) => void)[]>();
  children: Child[] = [];
  parent: FakeElement | null = null;
  id = '';
  type = '';
  inert = false;
  width = 0;
  height = 0;
  offsetWidth = 0;

  constructor(tag: string, doc: FakeDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
  }

  get className(): string {
    return this.classList.toString();
  }

  set className(v: string) {
    this.classList.reset(v);
  }

  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }

  set textContent(v: string) {
    this.children = v ? [v] : [];
  }

  append(...nodes: Child[]): void {
    for (const n of nodes) {
      if (typeof n !== 'string') n.parent = this;
      this.children.push(n);
    }
  }

  appendChild(n: FakeElement): FakeElement {
    this.append(n);
    return n;
  }

  replaceChildren(...nodes: Child[]): void {
    this.children = [];
    this.append(...nodes);
  }

  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  setAttribute(k: string, v: string): void {
    this.attributes.set(k, v);
  }

  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
  }

  addEventListener(type: string, fn: (e: { detail: number; stopPropagation(): void }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  getContext(): null {
    return null;
  }

  /** Pointer click (detail 1) on this element. */
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn({ detail: 1, stopPropagation() {} });
  }

  /** Depth-first search. */
  find(pred: (e: FakeElement) => boolean): FakeElement | null {
    if (pred(this)) return this;
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      const f = c.find(pred);
      if (f) return f;
    }
    return null;
  }

  findAll(pred: (e: FakeElement) => boolean, out: FakeElement[] = []): FakeElement[] {
    if (pred(this)) out.push(this);
    for (const c of this.children) if (typeof c !== 'string') c.findAll(pred, out);
    return out;
  }
}

export class FakeDocument {
  readonly head: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;

  constructor() {
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  getElementById(id: string): FakeElement | null {
    return this.head.find((e) => e.id === id) ?? this.body.find((e) => e.id === id);
  }
}

/** A parent element for a UI component, plus `HTMLElement` for the code's instanceof checks. */
export function fakeUiRoot(): { doc: FakeDocument; root: FakeElement; parent: HTMLElement } {
  const g = globalThis as { HTMLElement?: unknown };
  if (!g.HTMLElement) g.HTMLElement = FakeElement;
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  return { doc, root, parent: root as unknown as HTMLElement };
}

export function hasClass(e: FakeElement | null, name: string): boolean {
  return e !== null && e.classList.contains(name);
}
