import { describe, expect, it } from 'vitest';
import { createInputNormalizer, type HubEventLike, type InputEvent } from '../src/input/normalize';

function once(ev: HubEventLike): InputEvent | null {
  return createInputNormalizer().normalize(ev, 1000);
}

describe('createInputNormalizer', () => {
  it.each<[string, HubEventLike, InputEvent | null]>([
    [
      'tap with no eventType (protobuf zero omission)',
      { sysEvent: { eventSource: 1 } },
      { type: 'tap' },
    ],
    ['swipe up on a text container', { textEvent: { eventType: 1 } }, { type: 'up' }],
    ['swipe down on a text container', { textEvent: { eventType: 2 } }, { type: 'down' }],
    ['double tap', { sysEvent: { eventType: 3 } }, { type: 'doubleTap' }],
    ['double tap on the text envelope', { textEvent: { eventType: 3 } }, { type: 'doubleTap' }],
    ['long press', { sysEvent: { eventType: 9 } }, { type: 'holdStart' }],
    ['long press release', { sysEvent: { eventType: 10 } }, { type: 'holdEnd' }],
    ['foreground enter', { sysEvent: { eventType: 4 } }, { type: 'foregroundEnter' }],
    ['foreground exit', { sysEvent: { eventType: 5 } }, { type: 'foregroundExit' }],
    ['system exit', { sysEvent: { eventType: 7 } }, { type: 'exit' }],
    ['abnormal exit', { sysEvent: { eventType: 6 } }, { type: 'exit' }],
    ['menu item', { menuItemClickEvent: { itemID: 2 } }, { type: 'menu', id: 2 }],
    ['list tap on index 0 (index omitted)', { listEvent: {} }, { type: 'listSelect', index: 0 }],
    [
      'list tap with index (simulator sends no item name)',
      { listEvent: { containerID: 2, containerName: 'acts', currentSelectItemIndex: 1 } },
      { type: 'listSelect', index: 1 },
    ],
    ['audio-only envelope', { audioEvent: { audioPcm: new Uint8Array(4) } }, null],
    ['IMU sample', { sysEvent: { eventType: 8 } }, null],
    ['empty envelope', {}, null],
  ])('%s', (_name, ev, expected) => {
    expect(once(ev)).toEqual(expected);
  });

  it('drops a duplicate tap 50 ms later but keeps one 200 ms later', () => {
    const n = createInputNormalizer();
    expect(n.normalize({ sysEvent: {} }, 1000)).toEqual({ type: 'tap' });
    expect(n.normalize({ sysEvent: {} }, 1050)).toBeNull();
    expect(n.normalize({ sysEvent: {} }, 1250)).toEqual({ type: 'tap' });
  });

  it('drops same-direction scroll bursts within 350 ms but not a direction change', () => {
    const n = createInputNormalizer();
    expect(n.normalize({ textEvent: { eventType: 2 } }, 1000)).toEqual({ type: 'down' });
    expect(n.normalize({ textEvent: { eventType: 2 } }, 1200)).toBeNull();
    expect(n.normalize({ textEvent: { eventType: 1 } }, 1250)).toEqual({ type: 'up' });
    expect(n.normalize({ textEvent: { eventType: 2 } }, 1700)).toEqual({ type: 'down' });
  });

  it('suppresses scrolls for 80 ms after a text update (re-layout noise)', () => {
    const n = createInputNormalizer();
    n.markTextUpdate(1000);
    expect(n.normalize({ textEvent: { eventType: 2 } }, 1040)).toBeNull();
    expect(n.normalize({ textEvent: { eventType: 2 } }, 1100)).toEqual({ type: 'down' });
  });

  it('does not suppress taps after a text update', () => {
    const n = createInputNormalizer();
    n.markTextUpdate(1000);
    expect(n.normalize({ sysEvent: {} }, 1010)).toEqual({ type: 'tap' });
  });
});
