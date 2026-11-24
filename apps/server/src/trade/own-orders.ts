/** How long the ids of orders the user just confirmed are remembered (fills arrive in seconds). */
const OID_TTL_MS = 2 * 60_000;

type FillRef = { coin?: unknown; oid?: unknown };

/**
 * Orders this app just sent, so fill alerts skip them (the user already saw the result card) and
 * report everything else: resting orders that filled later and triggered stops. A coin with an
 * order in flight counts as own too: the websocket fill can beat the exchange's answer.
 */
export class OwnOrders {
  private readonly oids = new Map<number, number>();
  private readonly inFlight = new Map<string, number>();
  private readonly stops = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  begin(coins: string[]): void {
    for (const c of coins) this.inFlight.set(c, (this.inFlight.get(c) ?? 0) + 1);
  }

  end(coins: string[], oids: number[]): void {
    const now = this.now();
    for (const [oid, at] of this.oids) if (now - at > OID_TTL_MS) this.oids.delete(oid);
    for (const oid of oids) this.oids.set(oid, now);
    for (const c of coins) {
      const n = (this.inFlight.get(c) ?? 0) - 1;
      if (n > 0) this.inFlight.set(c, n);
      else this.inFlight.delete(c);
    }
  }

  isOwn(fill: FillRef): boolean {
    if (typeof fill.coin === 'string' && this.inFlight.has(fill.coin)) return true;
    const at = typeof fill.oid === 'number' ? this.oids.get(fill.oid) : undefined;
    return at !== undefined && this.now() - at <= OID_TTL_MS;
  }

  /** A stop the user set from the glasses: its fill later reads "Stop hit". */
  rememberStop(coin: string, triggerPx: number): void {
    this.stops.set(coin, triggerPx);
  }

  stopFor(coin: string): number | undefined {
    return this.stops.get(coin);
  }
}
