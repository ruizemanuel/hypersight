/** Number and time formatting for glasses cards. Negative numbers use U+2212 (−), not a hyphen. */

const MINUS = '−';

function signed(body: string, negative: boolean, positive: boolean, sign: boolean): string {
  if (negative) return `${MINUS}${body}`;
  return sign && positive ? `+${body}` : body;
}

/** `1234.5 → $1,234.50`; `|n| ≥ 100k → $123.4k`, `≥ 10M → $12.5M`; `sign` adds `+` to positives. */
export function fmtUsd(n: number, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(n);
  let body: string;
  let rounded: number;
  if (abs >= 10_000_000) {
    rounded = Math.round(abs / 100_000) / 10;
    body = `$${rounded.toFixed(1)}M`;
  } else if (abs >= 100_000) {
    rounded = Math.round(abs / 100) / 10;
    body = `$${rounded.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
  } else {
    rounded = Math.round(abs * 100) / 100;
    body = `$${rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return signed(body, n < 0 && rounded > 0, n > 0 && rounded > 0, opts.sign === true);
}

/** Five significant figures with thousands separators: `62317 → 62,317`, `0.02305 → 0.02305`. */
export function fmtPrice(n: number): string {
  const v = Number(n.toPrecision(5));
  const body = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 10 });
  return v < 0 ? `${MINUS}${body}` : body;
}

/** `0.031 → 3.1%` (`+3.1%` with sign). */
export function fmtPct(n: number, opts: { sign?: boolean } = {}): string {
  const rounded = Math.round(Math.abs(n) * 1000) / 10;
  return signed(
    `${rounded.toFixed(1)}%`,
    n < 0 && rounded > 0,
    n > 0 && rounded > 0,
    opts.sign === true,
  );
}

/** Implied probability from a 0–1 price: `0.593705 → 59%`; extremes read `<1%` / `>99%`. */
export function fmtProb(p: number): string {
  if (p > 0 && p < 0.005) return '<1%';
  if (p >= 0.995 && p < 1) return '>99%';
  return `${Math.round(p * 100)}%`;
}

/** `in 2h 05m`, `in 42m`, `in 3d`, `closed`. */
export function fmtUntil(ts: number, now: number): string {
  const ms = ts - now;
  if (ms <= 0) return 'closed';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'in <1m';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `in ${Math.floor(hours / 24)}d`;
}

/** Position size rounded down to the asset's size decimals, no trailing zeros. */
export function fmtSize(n: number, decimals: number): string {
  const f = 10 ** decimals;
  return String(Math.floor(Math.abs(n) * f + 1e-9) / f);
}

/** `▲ ` for a gain, `▼ ` for a loss, nothing when it rounds to zero cents (glyphs from the G2 safe set). */
export function trend(usd: number): string {
  const cents = Math.round(Math.abs(usd) * 100);
  if (cents === 0) return '';
  return usd > 0 ? '▲ ' : '▼ ';
}

/**
 * A 0–1 share as solid `█` cells on a thin `─` track; out of range is clamped. (The G2 font
 * draws `━` almost as thin as `─`, so the heavy-line bar is unreadable at a glance.)
 */
export function bar(share: number, cells = 24): string {
  const clamped = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
  const filled = Math.round(clamped * cells);
  return '█'.repeat(filled) + '─'.repeat(cells - filled);
}
