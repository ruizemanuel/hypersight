/** HIP-4 outcome catalogue: raw `outcomeMeta` + `outcomeTemplates` → human markets with stable keys. */

export type OutcomeSpecLike = {
  outcome: number;
  name: string;
  description: string;
  sideSpecs: { name: string }[];
};

export type QuestionSpecLike = {
  question: number;
  name: string;
  description: string;
  fallbackOutcome: number | null;
  namedOutcomes: number[];
  settledNamedOutcomes: number[];
};

export type OutcomeMetaLike = { outcomes: OutcomeSpecLike[]; questions: QuestionSpecLike[] };

export type OutcomeTemplateLike = {
  id: string;
  role: unknown;
  name: string;
  description: string;
  keywords: [string, string][];
};

export type OutcomeMetaUpdate =
  | { outcomeCreated: OutcomeSpecLike }
  | { outcomeSettled: number }
  | { questionUpdated: QuestionSpecLike }
  | { questionSettled: number };

export type OutcomeMarket = {
  /** Stable across rotations for recurring markets (`rb:BTC:1d`), else `o:<outcome>`. */
  key: string;
  outcome: number;
  question?: number;
  title: string;
  /** ≤ 28 characters, for card titles and lists. */
  short: string;
  sides: [string, string];
  expiresAt?: number;
  category?: string;
  recurring?: { underlying: string; period: string };
};

const SHORT_MAX = 28;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EXPIRY_KEYWORDS = ['expiry', 'time', 'resolutionDeadline', 'deadline', 'date'];
const PERIOD_LABEL: Record<string, string> = { '1d': 'daily', '1h': 'hourly', '1w': 'weekly' };

/** `a:b|c:d:e` → `{a:'b', c:'d:e'}` (split on `|`, then on the first `:` only). */
function parseKv(description: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const part of description.split('|')) {
    const i = part.indexOf(':');
    if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
  }
  return kv;
}

/** `YYYYMMDD-HHMM` or `YYYYMMDD` (UTC) → epoch ms. */
function parseUtc(value: string | undefined): number | undefined {
  const m = value ? /^(\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2}))?$/.exec(value) : null;
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 23), Number(mi ?? 59));
}

function fmtUtc(ms: number, withTime: boolean): string {
  const d = new Date(ms);
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (!withTime) return date;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${date} ${hh}:${mm} UTC`;
}

function fmtNum(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 10 }) : value;
}

function truncate(s: string, max = SHORT_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Shortens `context: label` titles by trimming the context, so the outcome label survives. */
function shortTitle(title: string): string {
  if (title.length <= SHORT_MAX) return title;
  const i = title.lastIndexOf(': ');
  const label = i > 0 ? title.slice(i + 2) : '';
  if (!label || label.length > SHORT_MAX - 8) return truncate(title);
  const context = title.slice(0, i);
  const segment = context.slice(context.lastIndexOf(': ') + 1).trim();
  return `${truncate(segment, SHORT_MAX - label.length - 2)}: ${label}`;
}

function isFallback(o: OutcomeSpecLike): boolean {
  return /fallback/i.test(o.name);
}

class Builder {
  private readonly templates: Map<string, OutcomeTemplateLike>;
  private readonly questionOf = new Map<number, QuestionSpecLike>();
  private readonly hidden = new Set<number>();

  constructor(
    private readonly meta: OutcomeMetaLike,
    templates: OutcomeTemplateLike[],
  ) {
    this.templates = new Map(templates.map((t) => [t.id, t]));
    for (const q of meta.questions) {
      for (const id of q.namedOutcomes) this.questionOf.set(id, q);
      if (q.fallbackOutcome !== null) {
        this.questionOf.set(q.fallbackOutcome, q);
        this.hidden.add(q.fallbackOutcome);
      }
      for (const id of q.settledNamedOutcomes) this.hidden.add(id);
    }
  }

  build(): OutcomeMarket[] {
    const out: OutcomeMarket[] = [];
    for (const o of this.meta.outcomes) {
      if (isFallback(o) || this.hidden.has(o.outcome)) continue;
      const m = this.market(o);
      if (m) out.push(m);
    }
    return out;
  }

  private market(o: OutcomeSpecLike): OutcomeMarket | null {
    const q = this.questionOf.get(o.outcome);
    const kv = parseKv(o.description);

    if (o.name === 'Recurring' && kv.class === 'priceBinary') return this.priceBinary(o, kv);
    if (o.name === 'Recurring Named Outcome' && q) return this.priceBucket(o, kv, q);

    const sides = this.sides(o, kv);
    if (o.name.startsWith('template:')) {
      const t = this.templates.get(o.name.slice('template:'.length));
      if (!t) return null;
      const own = this.interpolate(t.name, kv, t);
      const title = q ? `${this.questionTitle(q)}: ${own}` : own;
      const short =
        kv.shortNameA && kv.shortNameB ? `${kv.shortNameA} v ${kv.shortNameB}` : shortTitle(title);
      return {
        key: `o:${o.outcome}`,
        outcome: o.outcome,
        ...(q ? { question: q.question } : {}),
        title,
        short: truncate(short),
        sides,
        ...optional('expiresAt', this.templateExpiry(t, kv)),
        ...optional('category', parseKv(t.description.split(' metadata=')[1] ?? '').category),
      };
    }

    const title = q ? `${this.questionTitle(q)}: ${o.name}` : o.name;
    return {
      key: `o:${o.outcome}`,
      outcome: o.outcome,
      ...(q ? { question: q.question } : {}),
      title,
      short: shortTitle(title),
      sides,
    };
  }

  private priceBinary(o: OutcomeSpecLike, kv: Record<string, string>): OutcomeMarket | null {
    const { underlying, targetPrice, period } = kv;
    const expiresAt = parseUtc(kv.expiry);
    if (!underlying || !targetPrice || !period || expiresAt === undefined) return null;
    const target = fmtNum(targetPrice);
    return {
      key: `rb:${underlying}:${period}`,
      outcome: o.outcome,
      title: `${underlying} above ${target} at ${fmtUtc(expiresAt, true)}?`,
      short: truncate(`${underlying} > ${target} · ${PERIOD_LABEL[period] ?? period}`),
      sides: ['Yes', 'No'],
      expiresAt,
      category: 'price',
      recurring: { underlying, period },
    };
  }

  /** Recurring priceBucket member: `index:0` < lower, `index:1` in [lower, upper), `index:2` ≥ upper. */
  private priceBucket(
    o: OutcomeSpecLike,
    kv: Record<string, string>,
    q: QuestionSpecLike,
  ): OutcomeMarket | null {
    const qkv = parseKv(q.description);
    const [lower, upper] = (qkv.priceThresholds ?? '').split(',').map(fmtNum);
    const expiresAt = parseUtc(qkv.expiry);
    const { underlying, period } = qkv;
    if (!underlying || !period || !lower || !upper || expiresAt === undefined) return null;
    const range =
      kv.index === '0'
        ? `below ${lower}`
        : kv.index === '1'
          ? `${lower}–${upper}`
          : kv.index === '2'
            ? `${upper} or above`
            : null;
    if (!range) return null;
    const shortRange =
      kv.index === '0' ? `< ${lower}` : kv.index === '1' ? `${lower}–${upper}` : `≥ ${upper}`;
    return {
      key: `rq:${underlying}:${period}:${kv.index}`,
      outcome: o.outcome,
      question: q.question,
      title: `${underlying} ${range} at ${fmtUtc(expiresAt, true)}?`,
      short: truncate(`${underlying} ${shortRange} · ${PERIOD_LABEL[period] ?? period}`),
      sides: ['Yes', 'No'],
      expiresAt,
      category: 'price',
    };
  }

  private questionTitle(q: QuestionSpecLike): string {
    if (!q.name.startsWith('template:')) return q.name;
    const t = this.templates.get(q.name.slice('template:'.length));
    return t ? this.interpolate(t.name, parseKv(q.description), t) : q.name;
  }

  private sides(o: OutcomeSpecLike, kv: Record<string, string>): [string, string] {
    const label = (i: number, fallback: string) => {
      const raw = o.sideSpecs[i]?.name ?? fallback;
      const name = raw.startsWith('template:') ? raw.slice('template:'.length) : raw;
      return name.replace(/\{(\w+)\}/g, (_, k: string) => kv[k] ?? k);
    };
    return [label(0, 'Yes'), label(1, 'No')];
  }

  private interpolate(text: string, kv: Record<string, string>, t: OutcomeTemplateLike): string {
    const types = new Map(t.keywords);
    return text.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = kv[k];
      if (v === undefined) return k;
      const type = types.get(k);
      if (type === 'dateTime' || type === 'date') {
        const ms = parseUtc(v);
        return ms === undefined ? v : fmtUtc(ms, type === 'dateTime');
      }
      return v;
    });
  }

  private templateExpiry(t: OutcomeTemplateLike, kv: Record<string, string>): number | undefined {
    const types = new Map(t.keywords);
    for (const k of EXPIRY_KEYWORDS) {
      const type = types.get(k);
      if (type === 'dateTime' || type === 'date') {
        const ms = parseUtc(kv[k]);
        if (ms !== undefined) return ms;
      }
    }
    return undefined;
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function buildCatalogue(
  meta: OutcomeMetaLike,
  templates: OutcomeTemplateLike[],
): OutcomeMarket[] {
  return new Builder(meta, templates).build();
}

type InfoLike = {
  outcomeMeta(): Promise<unknown>;
  outcomeTemplates(): Promise<unknown>;
};

/** Live catalogue kept fresh by `outcomeMetaUpdates`; rebuilt from raw specs on every change. */
export class Catalogue {
  private outcomes = new Map<number, OutcomeSpecLike>();
  private questions = new Map<number, QuestionSpecLike>();
  private templates: OutcomeTemplateLike[] = [];
  private markets: OutcomeMarket[] = [];
  private byKeyMap = new Map<string, OutcomeMarket>();
  private byOutcomeMap = new Map<number, OutcomeMarket>();

  async load(info: InfoLike): Promise<void> {
    const [meta, templates] = await Promise.all([info.outcomeMeta(), info.outcomeTemplates()]);
    this.reset(meta as OutcomeMetaLike, templates as OutcomeTemplateLike[]);
  }

  reset(meta: OutcomeMetaLike, templates: OutcomeTemplateLike[]): void {
    this.outcomes = new Map(meta.outcomes.map((o) => [o.outcome, o]));
    this.questions = new Map(meta.questions.map((q) => [q.question, q]));
    this.templates = templates;
    this.rebuild();
  }

  apply(update: OutcomeMetaUpdate): void {
    if ('outcomeCreated' in update) {
      this.outcomes.set(update.outcomeCreated.outcome, update.outcomeCreated);
    } else if ('outcomeSettled' in update) {
      this.outcomes.delete(update.outcomeSettled);
    } else if ('questionUpdated' in update) {
      this.questions.set(update.questionUpdated.question, update.questionUpdated);
    } else if ('questionSettled' in update) {
      const q = this.questions.get(update.questionSettled);
      if (q) {
        for (const id of q.namedOutcomes) this.outcomes.delete(id);
        if (q.fallbackOutcome !== null) this.outcomes.delete(q.fallbackOutcome);
      }
      this.questions.delete(update.questionSettled);
    }
    this.rebuild();
  }

  byKey(key: string): OutcomeMarket | undefined {
    return this.byKeyMap.get(key);
  }

  byOutcome(id: number): OutcomeMarket | undefined {
    return this.byOutcomeMap.get(id);
  }

  all(): OutcomeMarket[] {
    return this.markets;
  }

  /** Whole-word matches rank above prefix and substring matches; ties go to the soonest expiry. */
  search(q: string, limit = 10): OutcomeMarket[] {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const scored: { m: OutcomeMarket; score: number }[] = [];
    for (const m of this.markets) {
      const words = `${m.title} ${m.short} ${m.category ?? ''} ${m.sides.join(' ')}`
        .toLowerCase()
        .split(/[^a-z0-9.]+/)
        .filter(Boolean);
      let score = 0;
      for (const term of terms) {
        if (words.includes(term)) score += 3;
        else if (words.some((w) => w.startsWith(term))) score += 1;
      }
      if (score > 0) scored.push({ m, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        (a.m.expiresAt ?? Number.POSITIVE_INFINITY) - (b.m.expiresAt ?? Number.POSITIVE_INFINITY),
    );
    return scored.slice(0, limit).map((s) => s.m);
  }

  private rebuild(): void {
    this.markets = buildCatalogue(
      { outcomes: [...this.outcomes.values()], questions: [...this.questions.values()] },
      this.templates,
    );
    this.byOutcomeMap = new Map(this.markets.map((m) => [m.outcome, m]));
    // During a rotation the old and new recurring outcomes coexist: the newest id owns the key.
    this.byKeyMap = new Map();
    for (const m of this.markets) {
      const current = this.byKeyMap.get(m.key);
      if (!current || m.outcome > current.outcome) this.byKeyMap.set(m.key, m);
    }
  }
}
