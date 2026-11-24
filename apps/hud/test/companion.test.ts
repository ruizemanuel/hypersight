import { describe, expect, it } from 'vitest';
import { httpBaseFromWs } from '../src/companion/api';

describe('httpBaseFromWs', () => {
  it('derives the companion API origin from the socket URL', () => {
    expect(httpBaseFromWs('ws://192.168.1.5:8787/ws')).toBe('http://192.168.1.5:8787');
    expect(httpBaseFromWs('wss://hypersight.fly.dev/ws')).toBe('https://hypersight.fly.dev');
  });
});
