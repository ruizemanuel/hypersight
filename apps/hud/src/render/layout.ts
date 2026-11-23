import { getTextWidth, pxTruncate } from '@evenrealities/pretext';
import type { Badge, CardModel, Overlay } from '@hypersight/protocol';

export type TextSpec = {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** Brightness 0–4 (there are no font sizes: emphasis = border + brightness). */
  color: 0 | 1 | 2 | 3 | 4;
  border?: { width: number; radius: number; color: number };
  capture?: boolean;
};

/** A list always captures events (taps arrive as listEvent with the item index). */
export type ListSpec = {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  items: string[];
};

export type PageSpec = { layoutKey: string; texts: TextSpec[]; list?: ListSpec };

export const PADDING = 4;
const TRANSCRIPT_TAIL = 240;

export function innerWidth(t: { w: number; border?: { width: number } }): number {
  return t.w - 2 * (PADDING + (t.border?.width ?? 0));
}

export function innerHeight(t: { h: number; border?: { width: number } }): number {
  return t.h - 2 * (PADDING + (t.border?.width ?? 0));
}

/** One display line: newlines flattened, then cut with pretext so it never wraps. */
function fitLine(text: string, width: number): string {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  if (!flat) return ' ';
  return getTextWidth(flat) <= width ? flat : pxTruncate(flat, width);
}

/** `TITLE · BADGE · 2/4`: the title is cut so the badge and position always show. */
function header(title: string, suffix: string, width: number): string {
  const tail = ` · ${suffix}`;
  const room = width - getTextWidth(tail);
  return `${fitLine(title, room)}${tail}`;
}

type Skeleton = { hdr: string; val: string; body: string; ftr: string };

/** Header 36 px · bordered value box 50 px · body 150 px (captures input) · footer 36 px. */
function skeleton(s: Skeleton, layoutKey = 'card'): PageSpec {
  const hdr: TextSpec = { id: 1, name: 'hdr', x: 0, y: 0, w: 576, h: 36, text: s.hdr, color: 2 };
  const val: TextSpec = {
    id: 2,
    name: 'val',
    x: 0,
    y: 40,
    w: 576,
    h: 50,
    text: fitLine(s.val, 576 - 2 * (PADDING + 1)),
    color: 4,
    border: { width: 1, radius: 6, color: 13 },
  };
  const body: TextSpec = {
    id: 3,
    name: 'body',
    x: 0,
    y: 96,
    w: 576,
    h: 150,
    text: s.body || ' ',
    color: 3,
    capture: true,
  };
  const ftr: TextSpec = {
    id: 4,
    name: 'ftr',
    x: 0,
    y: 252,
    w: 576,
    h: 36,
    text: fitLine(s.ftr, 576 - 2 * PADDING),
    color: 2,
  };
  return { layoutKey, texts: [hdr, val, body, ftr] };
}

const BODY_WIDTH = 576 - 2 * PADDING;
const HDR_WIDTH = 576 - 2 * PADDING;

function bodyLines(lines: string[]): string {
  return lines
    .slice(0, 3)
    .map((l) => fitLine(l, BODY_WIDTH))
    .join('\n');
}

export function layoutCard(
  card: CardModel,
  index: number,
  total: number,
  opts: { offline?: boolean } = {},
): PageSpec {
  const position = opts.offline ? 'offline' : `${index + 1}/${total}`;
  return skeleton({
    hdr: header(card.title, `${card.badge} · ${position}`, HDR_WIDTH),
    val: card.value,
    body: bodyLines(card.lines),
    ftr: card.hint,
  });
}

export function layoutStatus(s: {
  title: string;
  value: string;
  lines: string[];
  hint: string;
}): PageSpec {
  return skeleton({
    hdr: fitLine(s.title, HDR_WIDTH),
    val: s.value,
    body: bodyLines(s.lines),
    ftr: s.hint,
  });
}

export function layoutOverlay(
  o: Overlay,
  now: number,
  opts: { badge?: Badge; shownAt?: number } = {},
): PageSpec {
  const badge = opts.badge ?? 'TESTNET';
  const hdr = (label: string) => fitLine(`${label} · ${badge}`, HDR_WIDTH);
  switch (o.kind) {
    case 'listening': {
      const elapsed = Math.max(0, Math.floor((now - (opts.shownAt ?? now)) / 1000));
      const transcript = o.transcript.trim();
      return skeleton({
        hdr: hdr('LISTENING'),
        val: '● Recording',
        body: transcript ? transcript.slice(-TRANSCRIPT_TAIL) : `Listening… ${elapsed}s`,
        ftr: 'Release to send · 2×TAP cancel',
      });
    }
    case 'thinking':
      return skeleton({ hdr: hdr('THINKING'), val: 'Thinking…', body: '', ftr: 'One moment' });
    case 'confirm': {
      const p = o.proposal;
      if (p.blocked) {
        return skeleton({
          hdr: hdr('NOT ALLOWED'),
          val: p.title,
          body: bodyLines([p.blocked, ...p.lines]),
          ftr: '2×TAP back',
        });
      }
      const seconds = Math.max(0, Math.ceil((p.expiresAt - now) / 1000));
      return skeleton({
        hdr: hdr('CONFIRM'),
        val: p.title,
        body: bodyLines(p.lines),
        ftr: `TAP confirm · 2×TAP cancel · ${seconds}s`,
      });
    }
    case 'result':
      return skeleton({
        hdr: hdr(o.ok ? 'DONE' : 'NOT EXECUTED'),
        val: o.title,
        body: bodyLines(o.lines),
        ftr: 'TAP dismiss',
      });
    case 'alert':
      return skeleton({
        hdr: hdr('ALERT'),
        val: o.title,
        body: bodyLines(o.lines),
        ftr: o.action ? `TAP ${o.action.label} · 2×TAP dismiss` : 'TAP dismiss',
      });
    case 'error':
      return skeleton({ hdr: hdr('ERROR'), val: o.message, body: '', ftr: 'TAP dismiss' });
  }
}

export function layoutActions(card: CardModel): PageSpec {
  const hdr: TextSpec = {
    id: 1,
    name: 'hdr',
    x: 0,
    y: 0,
    w: 576,
    h: 36,
    text: header(card.title, card.badge, HDR_WIDTH),
    color: 2,
  };
  return {
    layoutKey: 'actions',
    texts: [hdr],
    list: {
      id: 5,
      name: 'acts',
      x: 0,
      y: 40,
      w: 576,
      h: 248,
      items: card.actions.map((a) => a.label),
    },
  };
}
