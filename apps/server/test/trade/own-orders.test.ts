import { describe, expect, it } from 'vitest';
import { OwnOrders } from '../../src/trade/own-orders';

describe('OwnOrders', () => {
  it('treats fills on a coin with an order in flight as own, then goes by order id', () => {
    const clock = { now: 0 };
    const own = new OwnOrders(() => clock.now);
    own.begin(['ETH']);
    // The websocket fill can arrive before the exchange answers the order request.
    expect(own.isOwn({ coin: 'ETH', oid: 77 })).toBe(true);
    expect(own.isOwn({ coin: 'BTC', oid: 5 })).toBe(false);
    own.end(['ETH'], [77]);
    expect(own.isOwn({ coin: 'ETH', oid: 77 })).toBe(true);
    expect(own.isOwn({ coin: 'ETH', oid: 78 })).toBe(false);
  });

  it('forgets order ids after a while', () => {
    const clock = { now: 0 };
    const own = new OwnOrders(() => clock.now);
    own.begin(['#273210']);
    own.end(['#273210'], [42]);
    clock.now += 5 * 60_000;
    expect(own.isOwn({ coin: '#273210', oid: 42 })).toBe(false);
  });

  it('keeps a coin in flight until every order on it has answered', () => {
    const own = new OwnOrders(() => 0);
    own.begin(['ETH']);
    own.begin(['ETH']);
    own.end(['ETH'], []);
    expect(own.isOwn({ coin: 'ETH', oid: 1 })).toBe(true);
    own.end(['ETH'], []);
    expect(own.isOwn({ coin: 'ETH', oid: 1 })).toBe(false);
  });

  it('remembers the stops the user set, per coin', () => {
    const own = new OwnOrders(() => 0);
    own.rememberStop('ETH', 2950);
    expect(own.stopFor('ETH')).toBe(2950);
    expect(own.stopFor('BTC')).toBeUndefined();
  });
});
