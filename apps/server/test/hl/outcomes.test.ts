import { describe, expect, it } from 'vitest';
import outcomeMetaFixture from '../../../../fixtures/hl/outcomeMeta.json';
import templatesFixture from '../../../../fixtures/hl/outcomeTemplates.json';
import {
  buildCatalogue,
  Catalogue,
  type OutcomeMetaLike,
  type OutcomeSpecLike,
  type OutcomeTemplateLike,
  parseOutcomeMetaEvent,
} from '../../src/hl/outcomes';

const templates: OutcomeTemplateLike[] = [
  {
    id: 'binaryPrice',
    role: { standaloneOutcome: { sideNames: ['Yes', 'No'] } },
    name: '{perp} above {threshold} at {time}?',
    description: 'If the {perp} mark price at time of settlement is above {threshold} at {time}.',
    keywords: [
      ['perp', 'hlPerp'],
      ['threshold', 'string'],
      ['time', 'dateTime'],
    ],
  },
  {
    id: 'sportsContestWinner7',
    role: { standaloneOutcome: { sideNames: ['{shortNameA}', '{shortNameB}'] } },
    name: '{competition} {stage}: {participantA} v {participantB}',
    description:
      'This {sport} market ... metadata=category:sports|subCategory:basketball|semanticRestriction:none',
    keywords: [
      ['competition', 'string'],
      ['stage', 'string'],
      ['participantA', 'string'],
      ['participantB', 'string'],
      ['shortNameA', 'shortString'],
      ['shortNameB', 'shortString'],
      ['resolutionDeadline', 'dateTime'],
    ],
  },
];

const btcDaily: OutcomeSpecLike = {
  outcome: 27121,
  name: 'Recurring',
  description: 'class:priceBinary|underlying:BTC|expiry:20261120-0300|targetPrice:61509|period:1d',
  sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
};
const ethDaily: OutcomeSpecLike = {
  outcome: 27122,
  name: 'Recurring',
  description: 'class:priceBinary|underlying:ETH|expiry:20261120-0300|targetPrice:1756.7|period:1d',
  sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
};
const btcTemplate: OutcomeSpecLike = {
  outcome: 22989,
  name: 'template:binaryPrice',
  description: 'perp:BTC|threshold:86000|time:20261006-2300',
  sideSpecs: [{ name: 'template:Yes' }, { name: 'template:No' }],
};
const hawks: OutcomeSpecLike = {
  outcome: 24274,
  name: 'template:sportsContestWinner7',
  description:
    'competition:NBA|contestType:game|participantA:Atlanta Hawks|participantB:Dallas Mavericks|resolutionDeadline:20261017-0600|shortNameA:Hawks|shortNameB:Mavericks|sport:basketball|stage:Preseason',
  sideSpecs: [{ name: 'template:{shortNameA}' }, { name: 'template:{shortNameB}' }],
};
const cpiBelow: OutcomeSpecLike = {
  outcome: 10218,
  name: 'Below 4.3%',
  description: 'This outcome resolves to Yes if the BLS CPI value for May 2026 is below 4.3%.',
  sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
};
const cpiFallback: OutcomeSpecLike = {
  outcome: 10217,
  name: 'Fallback',
  description: 'other',
  sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
};
const recurringFallback: OutcomeSpecLike = {
  outcome: 27128,
  name: 'Recurring Fallback',
  description: 'other',
  sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
};
const fedChange: OutcomeSpecLike = {
  outcome: 10225,
  name: 'June Fed rate change',
  description: 'The market resolves to Change if the upper bound of the target federal funds rate…',
  sideSpecs: [{ name: 'Change' }, { name: 'No change' }],
};
const fedStake: OutcomeSpecLike = {
  outcome: 12334,
  name: 'US Federal Government Stake in Nvidia',
  description: 'Resolves Yes if the US federal government takes a stake.',
  sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
};
const colonPerp: OutcomeSpecLike = {
  outcome: 11034,
  name: 'template:binaryPrice',
  description: 'perp:xyz:XYZ100|threshold:30000|time:20260815-0600',
  sideSpecs: [{ name: 'template:Yes' }, { name: 'template:No' }],
};

const meta: OutcomeMetaLike = {
  outcomes: [
    btcDaily,
    ethDaily,
    btcTemplate,
    hawks,
    cpiBelow,
    cpiFallback,
    recurringFallback,
    fedStake,
    fedChange,
    colonPerp,
  ],
  questions: [
    {
      question: 820,
      name: 'May CPI year-over-year',
      description: 'The question resolves by assigning Yes to exactly one of …',
      fallbackOutcome: 10217,
      namedOutcomes: [10218],
      settledNamedOutcomes: [],
    },
  ],
};

const byOutcome = (id: number) => buildCatalogue(meta, templates).find((m) => m.outcome === id);

describe('buildCatalogue', () => {
  it('turns a recurring priceBinary into a stable-key daily market', () => {
    expect(byOutcome(27121)).toEqual({
      key: 'rb:BTC:1d',
      outcome: 27121,
      title: 'BTC above 61,509 at Nov 20 03:00 UTC?',
      short: 'BTC > 61,509 · daily',
      sides: ['Yes', 'No'],
      expiresAt: Date.UTC(2026, 10, 20, 3, 0),
      category: 'price',
      recurring: { underlying: 'BTC', period: '1d' },
    });
    expect(byOutcome(27122)?.short).toBe('ETH > 1,756.7 · daily');
  });

  it('interpolates template names, side names and dateTime keywords', () => {
    expect(byOutcome(22989)).toMatchObject({
      key: 'o:22989',
      title: 'BTC above 86000 at Oct 6 23:00 UTC?',
      sides: ['Yes', 'No'],
      expiresAt: Date.UTC(2026, 9, 6, 23, 0),
    });
  });

  it('uses team short names for sports sides and the short label', () => {
    expect(byOutcome(24274)).toMatchObject({
      title: 'NBA Preseason: Atlanta Hawks v Dallas Mavericks',
      short: 'Hawks v Mavericks',
      sides: ['Hawks', 'Mavericks'],
      category: 'sports',
      expiresAt: Date.UTC(2026, 9, 17, 6, 0),
    });
  });

  it('titles a free-text outcome inside a question as "question: outcome"', () => {
    expect(byOutcome(10218)).toMatchObject({
      key: 'o:10218',
      question: 820,
      title: 'May CPI year-over-year: Below 4.3%',
    });
  });

  it('keeps the outcome label when shortening a long question title', () => {
    expect(byOutcome(10218)?.short).toBe('May CPI year-ov…: Below 4.3%');
  });

  it('leaves out fallback outcomes', () => {
    expect(byOutcome(10217)).toBeUndefined();
    expect(byOutcome(27128)).toBeUndefined();
  });

  it('keeps description values that contain ":"', () => {
    expect(byOutcome(11034)?.title).toBe('xyz:XYZ100 above 30000 at Aug 15 06:00 UTC?');
  });

  it('keeps every short label within 28 characters', () => {
    for (const m of buildCatalogue(meta, templates)) expect(m.short.length).toBeLessThanOrEqual(28);
  });
});

describe('Catalogue', () => {
  // A clock before every fixture expiry, so nothing here is hidden as expired.
  const make = () => {
    const c = new Catalogue({ now: () => Date.UTC(2026, 8, 1) });
    c.reset(meta, templates);
    return c;
  };

  it('looks markets up by key and by outcome id', () => {
    const c = make();
    expect(c.byKey('rb:BTC:1d')?.outcome).toBe(27121);
    expect(c.byOutcome(24274)?.key).toBe('o:24274');
    expect(c.byKey('rb:SOL:1d')).toBeUndefined();
  });

  it('removes a settled outcome', () => {
    const c = make();
    c.apply({ outcomeSettled: 24274 });
    expect(c.byOutcome(24274)).toBeUndefined();
    expect(c.byKey('o:24274')).toBeUndefined();
  });

  it('follows a recurring rotation: the key stays on the live market, then moves on settlement', () => {
    const c = make();
    c.apply({
      outcomeCreated: {
        ...btcDaily,
        outcome: 27153,
        description:
          'class:priceBinary|underlying:BTC|expiry:20261121-0300|targetPrice:62452|period:1d',
      },
    });
    // the old daily is still trading until its expiry: the key keeps pointing at it
    expect(c.byKey('rb:BTC:1d')?.outcome).toBe(27121);
    expect(c.byOutcome(27153)).toBeDefined();
    c.apply({ outcomeSettled: 27121 });
    expect(c.byKey('rb:BTC:1d')).toMatchObject({
      outcome: 27153,
      title: 'BTC above 62,452 at Nov 21 03:00 UTC?',
    });
    expect(c.byOutcome(27121)).toBeUndefined();
  });

  it('drops the members of a settled question', () => {
    const c = make();
    c.apply({ questionSettled: 820 });
    expect(c.byOutcome(10218)).toBeUndefined();
  });

  it('ranks whole-word matches first in search', () => {
    const c = make();
    const results = c.search('fed');
    expect(results[0]?.outcome).toBe(10225);
    expect(results.map((m) => m.outcome)).toContain(12334);
    expect(c.search('hawks')[0]?.outcome).toBe(24274);
    expect(c.search('zzz')).toEqual([]);
  });

  it('respects the search limit', () => {
    expect(make().search('btc', 1)).toHaveLength(1);
  });
});

describe('parseOutcomeMetaEvent', () => {
  it('accepts the SDK shape ({updates}, settled ids as objects)', () => {
    expect(
      parseOutcomeMetaEvent({
        updates: [{ outcomeSettled: { outcome: 27121 } }, { questionSettled: { question: 820 } }],
      }),
    ).toEqual([{ outcomeSettled: 27121 }, { questionSettled: 820 }]);
  });

  it('accepts the documented shape (bare array, settled ids as numbers)', () => {
    expect(parseOutcomeMetaEvent([{ outcomeSettled: 27121 }, { questionSettled: 820 }])).toEqual([
      { outcomeSettled: 27121 },
      { questionSettled: 820 },
    ]);
  });

  it('passes created outcomes and updated questions through', () => {
    const q = {
      question: 820,
      name: 'May CPI year-over-year',
      description: '…',
      fallbackOutcome: 10217,
      namedOutcomes: [10218],
      settledNamedOutcomes: [],
    };
    expect(
      parseOutcomeMetaEvent({ updates: [{ outcomeCreated: btcDaily }, { questionUpdated: q }] }),
    ).toEqual([{ outcomeCreated: btcDaily }, { questionUpdated: q }]);
  });

  it('drops anything malformed instead of throwing', () => {
    expect(parseOutcomeMetaEvent(null)).toEqual([]);
    expect(parseOutcomeMetaEvent({ updates: 'x' })).toEqual([]);
    expect(parseOutcomeMetaEvent([{ outcomeSettled: 'abc' }, { somethingElse: 1 }, 7])).toEqual([]);
  });
});

describe('Catalogue expiry', () => {
  const at = (iso: string) => () => Date.parse(iso);
  const nextDay: OutcomeSpecLike = {
    ...btcDaily,
    outcome: 27153,
    description:
      'class:priceBinary|underlying:BTC|expiry:20261121-0300|targetPrice:62452|period:1d',
  };
  const withBoth = (now: () => number) => {
    const c = new Catalogue({ now });
    c.reset({ outcomes: [btcDaily, nextDay, hawks], questions: [] }, templates);
    return c;
  };

  it('keeps the stable key on the current market until it expires, then moves it', () => {
    expect(withBoth(at('2026-11-20T02:00:00Z')).byKey('rb:BTC:1d')?.outcome).toBe(27121);
    expect(withBoth(at('2026-11-20T03:05:00Z')).byKey('rb:BTC:1d')?.outcome).toBe(27153);
  });

  it('hides expired markets from browsing and search but still resolves held ones by id', () => {
    const c = withBoth(at('2026-11-20T03:05:00Z'));
    expect(c.all().map((m) => m.outcome)).not.toContain(27121);
    expect(c.search('btc').map((m) => m.outcome)).not.toContain(27121);
    expect(c.byOutcome(27121)).toBeDefined();
  });
});

describe('the captured testnet catalogue', () => {
  const all = buildCatalogue(
    outcomeMetaFixture as unknown as OutcomeMetaLike,
    templatesFixture as unknown as OutcomeTemplateLike[],
  );

  it('contains the recurring BTC daily and no fallback or raw template titles', () => {
    expect(all.find((m) => m.key === 'rb:BTC:1d')?.recurring).toEqual({
      underlying: 'BTC',
      period: '1d',
    });
    for (const m of all) {
      expect(m.title).not.toMatch(/Fallback|template:|\{|\}/);
      expect(m.short.length).toBeLessThanOrEqual(28);
      expect(m.sides).toHaveLength(2);
    }
  });

  it('gives every market a unique key', () => {
    expect(new Set(all.map((m) => m.key)).size).toBe(all.length);
  });
});
