import type { AlertRule, Intent } from '@hypersight/protocol';

/** Raw form values as typed on the phone (inputs are strings). */
export type RuleForm =
  | { kind: 'price'; coin: string; px: string; dir: 'above' | 'below' }
  | { kind: 'pnl'; coin: string; pct: string; action: 'half' | 'close' | 'none' }
  | { kind: 'odds'; marketKey: string; points: string; minutes: string }
  | { kind: 'liq'; pct: string };

const COOLDOWN_MS = 600_000;
const LIQ_ID = 'default-liq';
/** The server keeps an hour of odds history. */
const ODDS_MAX_MINUTES = 60;

const fail = (error: string) => ({ error });
const made = (rule: AlertRule) => ({ rule });
const n = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));
const id = (s: string) => s.slice(0, 64);

/**
 * Turns a companion form into an alert rule the server accepts, or says what is missing. The
 * liquidation form edits the existing rule (`current`) in place.
 */
export function buildRule(
  form: RuleForm,
  current?: AlertRule,
): { rule: AlertRule } | { error: string } {
  switch (form.kind) {
    case 'price': {
      const coin = form.coin.trim().toUpperCase();
      const px = n(form.px);
      if (!coin || !(px > 0)) return fail('Enter a coin and a price');
      return made({
        id: id(`price-${coin}-${form.dir}-${px}`),
        kind: 'priceCross',
        params: { coin, px, dir: form.dir },
        cooldownMs: COOLDOWN_MS,
        enabled: true,
      });
    }
    case 'pnl': {
      const coin = form.coin.trim().toUpperCase();
      const pct = n(form.pct);
      if (!coin || !Number.isFinite(pct) || pct === 0) return fail('Enter a coin and a PnL %');
      const action: Intent | undefined =
        form.action === 'none'
          ? undefined
          : { kind: 'closePerp', coin, fraction: form.action === 'half' ? 0.5 : 1 };
      return made({
        id: id(`pnl-${coin}-${pct}`),
        kind: 'pnlPct',
        params: { coin, pct },
        ...(action ? { action } : {}),
        cooldownMs: COOLDOWN_MS,
        enabled: true,
      });
    }
    case 'odds': {
      const points = n(form.points);
      const minutes = n(form.minutes);
      const valid =
        form.marketKey !== '' &&
        Number.isInteger(points) &&
        points >= 1 &&
        points <= 99 &&
        minutes >= 1 &&
        minutes <= ODDS_MAX_MINUTES;
      if (!valid) return fail('Pick a watched market, 1–99 points and 1–60 minutes');
      return made({
        id: id(`odds-${form.marketKey}-${points}`),
        kind: 'oddsMove',
        params: { marketKey: form.marketKey, points, windowMs: Math.round(minutes * 60_000) },
        cooldownMs: COOLDOWN_MS,
        enabled: true,
      });
    }
    case 'liq': {
      const pct = n(form.pct);
      if (!(pct >= 1 && pct <= 50)) return fail('Liquidation distance is 1–50%');
      const base: AlertRule = current ?? {
        id: LIQ_ID,
        kind: 'liqDistance',
        params: {},
        cooldownMs: COOLDOWN_MS,
        enabled: true,
      };
      return made({ ...base, params: { ...base.params, pct } });
    }
  }
}

const signedPct = (pct: number) => (pct > 0 ? `+${pct}%` : `−${Math.abs(pct)}%`);

/** One line per rule, phrased the way its alert reads. */
export function describeRule(r: AlertRule): string {
  const p = r.params;
  switch (r.kind) {
    case 'priceCross':
      return `${p.coin} ${p.dir === 'below' ? 'below' : 'above'} ${p.px}`;
    case 'oddsMove':
      return `${p.marketKey} moves ${p.points} pts in ${Math.round(Number(p.windowMs) / 60_000)} min`;
    case 'pnlPct': {
      const pct = Number(p.pct);
      const verb =
        r.action?.kind === 'closePerp'
          ? r.action.fraction >= 1
            ? ` → close ${r.action.coin}`
            : r.action.fraction === 0.5
              ? ' → take half'
              : ` → close ${Math.round(r.action.fraction * 100)}%`
          : '';
      return `${p.coin} PnL ${pct >= 0 ? '≥' : '≤'} ${signedPct(pct)}${verb}`;
    }
    case 'liqDistance':
      return `Liquidation closer than ${p.pct}%`;
    case 'fill':
      return 'Order filled or stop hit';
    case 'settled':
      return 'Held outcome settled';
  }
}
