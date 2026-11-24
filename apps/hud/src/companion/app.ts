import type { AlertRule, Settings } from '@hypersight/protocol';
import type { CompanionApi } from './api';
import { buildRule, describeRule, type RuleForm } from './rules';
import { button, field, fmtMs, fmtTime, h, section } from './views';

const STATUS_REFRESH_MS = 5000;

/**
 * Phone-side setup screen: status, watchlist, presets, risk limits, alert rules and history.
 * Setup only — every action on the glasses works without it.
 */
export function mountCompanion(
  root: HTMLElement,
  api: CompanionApi,
): { setLink(text: string): void } {
  root.classList.add('companion');
  root.replaceChildren();
  const toast = h('div', { class: 'toast', role: 'status' });
  const say = (text: string) => {
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  };
  const fail = (what: string) => (err: unknown) =>
    say(`Couldn't ${what}${err instanceof Error ? ` (${err.message})` : ''}`);

  // Status
  const link = h('span', { id: 'status' }, 'Connecting…');
  const mode = h('span', { class: 'badge' }, 'TESTNET');
  const latency = h('p', { class: 'muted' }, 'Voice → text — · intent — · execution —');
  const refreshStatus = () =>
    api
      .status()
      .then((s) => {
        mode.textContent = s.mode === 'paper' ? 'PAPER' : 'TESTNET';
        latency.textContent = `Voice → text ${fmtMs(s.latency.sttMs)} · intent ${fmtMs(s.latency.intentMs)} · execution ${fmtMs(s.latency.execMs)}`;
      })
      .catch(() => {
        latency.textContent = 'Server unreachable';
      });

  // Watchlist
  const watchList = h('ul', { class: 'list' });
  const results = h('ul', { class: 'list results' });
  const renderWatch = (keys: string[]) => {
    renderOddsMarkets(keys);
    watchList.replaceChildren(
      ...keys.map((k) =>
        h(
          'li',
          {},
          h('span', {}, k),
          button(
            'Remove',
            () => void api.removeWatch(k).then(renderWatch, fail('remove')),
            'ghost',
          ),
        ),
      ),
      ...(keys.length === 0 ? [h('li', { class: 'muted' }, 'Nothing watched yet')] : []),
    );
  };
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  const search = h('input', {
    type: 'search',
    placeholder: 'Search markets (btc, fed, hawks…)',
    oninput: (ev: Event) => {
      const q = (ev.target as HTMLInputElement).value.trim();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (!q) return results.replaceChildren();
        void api.searchMarkets(q).then(
          (hits) =>
            results.replaceChildren(
              ...hits.map((m) =>
                h(
                  'li',
                  {},
                  h('span', {}, m.short, h('small', {}, m.title)),
                  button('Add', () => void api.addWatch(m.key).then(renderWatch, fail('add'))),
                ),
              ),
            ),
          fail('search'),
        );
      }, 250);
    },
  });

  // Presets and risk limits
  const presetsBox = h('div', { class: 'fields' });
  const riskBox = h('div', { class: 'fields' });
  const nums = (s: string) =>
    s
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
  const renderSettings = (s: Settings) => {
    const outcome = field('Outcome buys ($)', s.presets.outcomeUsd.join(', '), {
      type: 'text',
      hint: 'Up to 3 amounts',
    });
    const open = field('Perp opens ($)', s.presets.openUsd.join(', '), { type: 'text' });
    const close = field(
      'Close presets (%)',
      s.presets.closeFractions.map((f) => f * 100).join(', '),
      { type: 'text' },
    );
    const lev = field('Default leverage', String(s.presets.defaultLeverage), { step: '1' });
    presetsBox.replaceChildren(
      outcome.row,
      open.row,
      close.row,
      lev.row,
      button(
        'Save presets',
        () =>
          void api
            .saveSettings({
              presets: {
                outcomeUsd: nums(outcome.input.value),
                openUsd: nums(open.input.value),
                closeFractions: nums(close.input.value).map((p) => p / 100),
                defaultLeverage: Number(lev.input.value),
              },
            })
            .then((next) => {
              renderSettings(next);
              say('Presets saved — the glasses update now');
            }, fail('save presets')),
      ),
    );
    const maxOrder = field('Max per order ($)', String(s.risk.maxOrderUsd));
    const maxDaily = field('Max per day ($)', String(s.risk.maxDailyUsd));
    const maxLev = field('Max leverage', String(s.risk.maxLeverage), { step: '1' });
    const coins = field('Allowed perps', s.risk.allowedCoins.join(', '), { type: 'text' });
    riskBox.replaceChildren(
      maxOrder.row,
      maxDaily.row,
      maxLev.row,
      coins.row,
      button(
        'Save limits',
        () =>
          void api
            .saveSettings({
              risk: {
                maxOrderUsd: Number(maxOrder.input.value),
                maxDailyUsd: Number(maxDaily.input.value),
                maxLeverage: Number(maxLev.input.value),
                allowedCoins: coins.input.value
                  .split(/[,\s]+/)
                  .filter(Boolean)
                  .map((c) => c.toUpperCase()),
              },
            })
            .then((next) => {
              renderSettings(next);
              say('Limits saved');
            }, fail('save limits')),
      ),
    );
  };

  // Rules
  const rulesList = h('ul', { class: 'list' });
  let rulesNow: AlertRule[] = [];
  const liqPct = field('Warn when closer than (%)', '10');
  const renderRules = (rules: AlertRule[]) => {
    rulesNow = rules;
    const liq = rules.find((r) => r.kind === 'liqDistance');
    if (liq && document.activeElement !== liqPct.input) {
      liqPct.input.value = String(liq.params.pct ?? 10);
    }
    rulesList.replaceChildren(
      ...rules.map((r) => {
        const toggle = h('input', {
          type: 'checkbox',
          checked: r.enabled,
          onchange: (ev: Event) =>
            void api
              .saveRule({ ...r, enabled: (ev.target as HTMLInputElement).checked })
              .then(() => api.rules().then(renderRules), fail('update the rule')),
        });
        return h(
          'li',
          {},
          h('label', { class: 'rule' }, toggle, h('span', {}, describeRule(r))),
          button(
            'Delete',
            () =>
              void api.deleteRule(r.id).then(() => api.rules().then(renderRules), fail('delete')),
            'ghost',
          ),
        );
      }),
    );
  };
  const saveRule = (form: RuleForm, what: string, current?: AlertRule) => {
    const built = buildRule(form, current);
    if ('error' in built) return say(built.error);
    void api.saveRule(built.rule).then(
      () => {
        say(`${what} saved`);
        return api.rules().then(renderRules);
      },
      fail(`save the ${what.toLowerCase()}`),
    );
  };
  const select = (label: string, options: [value: string, text: string][]) => {
    const el = h('select', {}, ...options.map(([value, text]) => h('option', { value }, text)));
    return { row: h('label', { class: 'field' }, h('span', {}, label), el), el };
  };

  // Price alert
  const coin = field('Coin', 'ETH', { type: 'text' });
  const px = field('Price', '');
  const dir = select('When', [
    ['above', 'above'],
    ['below', 'below'],
  ]);
  const addPrice = button('Add price alert', () =>
    saveRule(
      {
        kind: 'price',
        coin: coin.input.value,
        px: px.input.value,
        dir: dir.el.value === 'below' ? 'below' : 'above',
      },
      'Price alert',
    ),
  );

  // PnL alert, with the quick action the alert offers (always behind a confirm on the glasses)
  const pnlCoin = field('Coin', 'ETH', { type: 'text' });
  const pnlPct = field('PnL move (%)', '5', { hint: 'Negative for a loss' });
  const pnlAction = select('Then offer', [
    ['half', 'take half'],
    ['close', 'close all'],
    ['none', 'nothing'],
  ]);
  const addPnl = button('Add PnL alert', () => {
    const action = pnlAction.el.value;
    saveRule(
      {
        kind: 'pnl',
        coin: pnlCoin.input.value,
        pct: pnlPct.input.value,
        action: action === 'close' || action === 'none' ? action : 'half',
      },
      'PnL alert',
    );
  });

  // Odds move on a watched market
  const oddsMarket = select('Market', []);
  const oddsPoints = field('Moves (pts)', '8', { step: '1' });
  const oddsMinutes = field('Within (min)', '10', { step: '1' });
  const renderOddsMarkets = (keys: string[]) =>
    oddsMarket.el.replaceChildren(
      ...(keys.length === 0
        ? [h('option', { value: '' }, 'Watch a market first')]
        : keys.map((k) => h('option', { value: k }, k))),
    );
  const addOdds = button('Add odds alert', () =>
    saveRule(
      {
        kind: 'odds',
        marketKey: oddsMarket.el.value,
        points: oddsPoints.input.value,
        minutes: oddsMinutes.input.value,
      },
      'Odds alert',
    ),
  );

  // Liquidation distance (edits the existing warning)
  const saveLiq = button('Save', () =>
    saveRule(
      { kind: 'liq', pct: liqPct.input.value },
      'Liquidation warning',
      rulesNow.find((r) => r.kind === 'liqDistance'),
    ),
  );

  // History
  const historyList = h('ul', { class: 'list history' });
  const renderHistory = () =>
    void api
      .history(30)
      .then(
        (rows) =>
          historyList.replaceChildren(
            ...rows.map((e) =>
              h('li', {}, h('small', {}, `${fmtTime(e.ts)} · ${e.kind}`), h('span', {}, e.summary)),
            ),
            ...(rows.length === 0 ? [h('li', { class: 'muted' }, 'No orders yet')] : []),
          ),
        fail('load history'),
      );

  root.append(
    h('header', {}, h('h1', {}, 'HyperSight'), mode),
    section('Status', h('p', {}, link), latency),
    section('Watchlist', watchList, search, results),
    section('Quick actions', presetsBox),
    section('Risk limits', riskBox),
    section(
      'Alerts',
      rulesList,
      h('h3', {}, 'Price'),
      h('div', { class: 'inline' }, coin.row, dir.row, px.row),
      addPrice,
      h('h3', {}, 'PnL'),
      h('div', { class: 'inline' }, pnlCoin.row, pnlPct.row, pnlAction.row),
      addPnl,
      h('h3', {}, 'Odds move'),
      h('div', { class: 'inline' }, oddsMarket.row, oddsPoints.row, oddsMinutes.row),
      addOdds,
      h('h3', {}, 'Liquidation'),
      h('div', { class: 'inline' }, liqPct.row),
      saveLiq,
    ),
    section('History', historyList, button('Refresh', renderHistory, 'ghost')),
    h('p', { class: 'muted foot' }, 'Testnet only · the agent wallet cannot withdraw funds'),
    toast,
  );

  void refreshStatus();
  setInterval(() => void refreshStatus(), STATUS_REFRESH_MS);
  void api.watch().then(renderWatch, fail('load the watchlist'));
  void api.settings().then(renderSettings, fail('load settings'));
  void api.rules().then(renderRules, fail('load alerts'));
  renderHistory();

  return {
    setLink(text: string) {
      link.textContent = text;
    },
  };
}
