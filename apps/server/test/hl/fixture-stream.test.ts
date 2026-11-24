import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixtureMarketStream } from '../../src/hl/fixture-stream';
import { Catalogue } from '../../src/hl/outcomes';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FixtureMarketStream', () => {
  it('serves the captured account: the ETH position is in the view', async () => {
    const stream = new FixtureMarketStream({ catalogue: new Catalogue() });
    await stream.start();
    const eth = stream.view().perps.find((p) => p.coin === 'ETH');
    expect(eth?.size).toBe(0.5);
    expect(stream.perpMeta().find((m) => m.name === 'ETH')).toBeDefined();
    expect(stream.catalogue.all().length).toBeGreaterThan(0);
    await stream.stop();
  });

  it('walks the ETH price so live updates show: a view event within 2.5 s', async () => {
    const stream = new FixtureMarketStream({ catalogue: new Catalogue() });
    await stream.start();
    const before = Number(stream.mids().ETH);
    const views: unknown[] = [];
    stream.on('view', (v) => views.push(v));
    vi.advanceTimersByTime(2500);
    expect(views.length).toBeGreaterThanOrEqual(1);
    expect(Number(stream.mids().ETH)).toBeCloseTo(before * 1.002, 6);
    await stream.stop();
    vi.advanceTimersByTime(10_000);
    expect(views).toHaveLength(1);
  });

  it('answers order books around the mid (perps and outcomes), with nothing filled today', async () => {
    const stream = new FixtureMarketStream({ catalogue: new Catalogue() });
    await stream.start();
    const mid = Number(stream.mids().ETH);
    const book = await stream.book('ETH');
    expect(book.bids[0]?.px).toBeLessThan(mid);
    expect(book.asks[0]?.px).toBeGreaterThan(mid);
    const outcome = Object.keys(stream.mids()).find((k) => k.startsWith('#')) as string;
    const ob = await stream.book(outcome);
    expect(ob.asks[0]?.px).toBeLessThan(1);
    expect(ob.bids[0]?.px).toBeGreaterThan(0);
    expect(stream.todayFills(Date.now())).toEqual([]);
    await stream.stop();
  });
});
