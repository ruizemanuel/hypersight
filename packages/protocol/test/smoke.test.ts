import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/index';

describe('protocol package', () => {
  it('exposes the wire protocol version shared by server and HUD', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
