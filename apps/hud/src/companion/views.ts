/** Tiny DOM helpers for the companion (no framework). */
type Attrs = Record<string, string | boolean | ((ev: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function section(title: string, ...body: (Node | string | null | false)[]): HTMLElement {
  return h('section', { class: 'card' }, h('h2', {}, title), ...body);
}

/** A labelled number/text input row; returns the input so callers can read it. */
export function field(
  label: string,
  value: string,
  opts: { type?: string; step?: string; hint?: string } = {},
): { row: HTMLElement; input: HTMLInputElement } {
  const input = h('input', {
    type: opts.type ?? 'number',
    value,
    inputmode: opts.type === 'text' ? 'text' : 'decimal',
    ...(opts.step ? { step: opts.step } : {}),
  });
  const row = h('label', { class: 'field' }, h('span', {}, label), input);
  if (opts.hint) row.append(h('small', {}, opts.hint));
  return { row, input };
}

export function button(text: string, onclick: () => void, kind: 'primary' | 'ghost' = 'primary') {
  return h('button', { class: kind, type: 'button', onclick }, text);
}

export const fmtMs = (ms: number | undefined): string =>
  ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;

export const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
