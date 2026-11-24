import { measureTextWrap } from '@evenrealities/pretext';
import type { CardModel, Overlay } from '@hypersight/protocol';
import { describe, expect, it } from 'vitest';
import {
  innerHeight,
  innerWidth,
  layoutActions,
  layoutCard,
  layoutOverlay,
  layoutStatus,
  type PageSpec,
} from '../src/render/layout';

const ethCard: CardModel = {
  id: 'perp:ETH',
  kind: 'perp',
  title: 'ETH LONG 2×',
  value: '+$42.10 (+3.1%)',
  lines: ['0.5 ETH · 3,326.8 → 3,411', 'liq $2,950 · 13.5% away'],
  hint: 'TAP actions · HOLD speak',
  badge: 'TESTNET',
  actions: [
    {
      id: 'close-25',
      label: 'Close 25%',
      intent: { kind: 'closePerp', coin: 'ETH', fraction: 0.25 },
    },
    {
      id: 'close-50',
      label: 'Close 50%',
      intent: { kind: 'closePerp', coin: 'ETH', fraction: 0.5 },
    },
    {
      id: 'close-100',
      label: 'Close all',
      intent: { kind: 'closePerp', coin: 'ETH', fraction: 1 },
    },
  ],
};

const longCard: CardModel = {
  ...ethCard,
  id: 'mkt:o:1',
  kind: 'market',
  title: 'UEFA Champions League Matchday 5: Inter Milan v VfB Stuttgart',
  value: 'Inter Milan v VfB Stuttgart: Draw — the value is also far too long for one line',
  lines: [
    'UEFA Champions League Matchday 5: Inter Milan v VfB Stuttgart: Draw, a line that wraps',
    'No 41% · in 2d',
    'A third line that is also much longer than the container is wide, by a lot',
  ],
  hint: 'TAP actions · HOLD speak · and a footer hint that does not fit on one line at all',
};

const NOW = 1_795_470_000_000;

const overlays: Overlay[] = [
  { kind: 'listening', transcript: '' },
  { kind: 'listening', transcript: 'buy twenty dollars of yes on the bitcoin daily '.repeat(8) },
  { kind: 'thinking' },
  {
    kind: 'confirm',
    proposal: {
      id: 'p1',
      title: 'CLOSE 50% ETH LONG',
      lines: ['0.25 ETH ≈ $852 @ ~3,411', '+$21.40 realized'],
      expiresAt: NOW + 12_000,
    },
  },
  {
    kind: 'confirm',
    proposal: {
      id: 'p2',
      title: 'BUY YES · BTC > 61,509',
      lines: [],
      expiresAt: NOW,
      blocked: 'Max order is $250',
    },
  },
  { kind: 'result', ok: true, title: 'FILLED 0.25 ETH @ 3,411.2', lines: ['+$21.40 realized'] },
  { kind: 'alert', title: 'ETH +5%', lines: ['your rule: take half'] },
  {
    kind: 'error',
    message: 'Hyperliquid error: something went wrong with a very long message here',
  },
];

function checkFits(page: PageSpec): void {
  for (const t of page.texts) {
    const lines = measureTextWrap(t.text, innerWidth(t)).lineCount;
    if (t.name !== 'body') expect(lines, `${t.name}: "${t.text}"`).toBeLessThanOrEqual(1);
    expect(lines * 27, `${t.name}: "${t.text}"`).toBeLessThanOrEqual(innerHeight(t));
    expect(new TextEncoder().encode(t.text).length).toBeLessThanOrEqual(999);
    expect(t.name).toMatch(/^[\x20-\x7e]{1,15}$/);
    expect(t.text).not.toMatch(/[✓✔✕✗☐☑⏱♦]/u);
    if (t.name === 'hdr' || t.name === 'ftr') expect(t.h).toBeGreaterThanOrEqual(35);
  }
  const captures = page.texts.filter((t) => t.capture).length + (page.list ? 1 : 0);
  expect(captures).toBe(1);
  expect(page.texts.length + (page.list ? 1 : 0)).toBeLessThanOrEqual(12);
}

describe('layoutCard', () => {
  it('lays out a card in the header / value box / body / footer skeleton', () => {
    const page = layoutCard(ethCard, 1, 4);
    expect(page.layoutKey).toBe('card');
    const byName = Object.fromEntries(page.texts.map((t) => [t.name, t]));
    expect(byName.hdr?.text).toBe('ETH LONG 2× · TESTNET · 2/4');
    expect(byName.val).toMatchObject({
      text: '+$42.10 (+3.1%)',
      color: 4,
      border: { width: 1, radius: 6, color: 13 },
    });
    expect(byName.body).toMatchObject({ capture: true, color: 3 });
    expect(byName.body?.text).toBe('0.5 ETH · 3,326.8 → 3,411\nliq $2,950 · 13.5% away');
    expect(byName.ftr?.text).toBe('TAP actions · HOLD speak');
    checkFits(page);
  });

  it('truncates every overlong text to fit its container', () => {
    const page = layoutCard(longCard, 9, 12);
    checkFits(page);
    expect(page.texts.find((t) => t.name === 'hdr')?.text.endsWith(' · TESTNET · 10/12')).toBe(
      true,
    );
  });

  it('marks the header offline instead of the position when disconnected', () => {
    const page = layoutCard(ethCard, 0, 4, { offline: true });
    expect(page.texts.find((t) => t.name === 'hdr')?.text).toBe('ETH LONG 2× · TESTNET · offline');
  });
});

describe('layoutOverlay', () => {
  it.each(overlays.map((o) => [o.kind, o] as const))('%s fits the display', (_kind, o) => {
    checkFits(layoutOverlay(o, NOW, { badge: 'TESTNET', shownAt: NOW - 3_000 }));
  });

  it('shows the confirm countdown and the badge', () => {
    const page = layoutOverlay(overlays[3] as Overlay, NOW, { badge: 'TESTNET', shownAt: NOW });
    const text = Object.fromEntries(page.texts.map((t) => [t.name, t.text]));
    expect(text.ftr).toBe('TAP confirm · 2×TAP cancel · 12s');
    expect(text.hdr).toContain('TESTNET');
    expect(text.val).toBe('CLOSE 50% ETH LONG');
  });

  it('shows what was heard under the confirm details', () => {
    const page = layoutOverlay(
      {
        kind: 'confirm',
        proposal: {
          id: 'p1',
          title: 'CLOSE 50% ETH LONG',
          lines: ['0.25 ETH ≈ $852.75', 'Est. PnL +$21.05', 'Reduce-only'],
          expiresAt: NOW + 12_000,
          note: 'heard: "close half my eth"',
        },
      },
      NOW,
      { badge: 'TESTNET', shownAt: NOW },
    );
    checkFits(page);
    const body = page.texts.find((t) => t.name === 'body')?.text ?? '';
    expect(body.split('\n')).toEqual([
      '0.25 ETH ≈ $852.75',
      'Est. PnL +$21.05',
      'Reduce-only',
      'heard: "close half my eth"',
    ]);
  });

  it('offers no confirm on a blocked proposal', () => {
    const page = layoutOverlay(overlays[4] as Overlay, NOW, { badge: 'TESTNET', shownAt: NOW });
    const text = Object.fromEntries(page.texts.map((t) => [t.name, t.text]));
    expect(text.body).toContain('Max order is $250');
    expect(text.ftr).not.toContain('TAP confirm');
  });

  it('shows elapsed time while the transcript is still empty', () => {
    const page = layoutOverlay({ kind: 'listening', transcript: '' }, NOW, {
      badge: 'TESTNET',
      shownAt: NOW - 3_400,
    });
    expect(page.texts.find((t) => t.name === 'body')?.text).toBe('Listening… 3s');
  });

  it('tells the user how to send and cancel, per how listening started', () => {
    const ftr = (source?: 'hold' | 'menu') =>
      layoutOverlay(
        { kind: 'listening', transcript: '', ...(source ? { source } : {}) },
        NOW,
      ).texts.find((t) => t.name === 'ftr')?.text;
    expect(ftr('hold')).toBe('Release to send · 2×TAP cancel');
    expect(ftr('menu')).toBe('TAP send · 2×TAP cancel');
    expect(ftr()).toBe('Release to send · 2×TAP cancel');
  });

  it('keeps only the tail of a long transcript', () => {
    const transcript = `${'x'.repeat(300)} close half my eth`;
    const page = layoutOverlay({ kind: 'listening', transcript }, NOW, {
      badge: 'TESTNET',
      shownAt: NOW,
    });
    const body = page.texts.find((t) => t.name === 'body')?.text ?? '';
    expect(body.length).toBeLessThanOrEqual(240);
    expect(body.endsWith('close half my eth')).toBe(true);
  });
});

describe('layoutActions', () => {
  it('lists the card actions in a capturing list', () => {
    const page = layoutActions(ethCard);
    expect(page.layoutKey).toBe('actions');
    expect(page.list?.items).toEqual(['Close 25%', 'Close 50%', 'Close all']);
    checkFits(page);
  });
});

describe('layoutStatus', () => {
  it('renders a status screen in the card skeleton', () => {
    const page = layoutStatus({
      title: 'HyperSight',
      value: 'Exit HyperSight?',
      lines: [],
      hint: 'TAP exit · 2×TAP stay',
    });
    expect(page.texts.find((t) => t.name === 'val')?.text).toBe('Exit HyperSight?');
    checkFits(page);
  });
});
