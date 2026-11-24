import type { AlertRule, Settings } from '@hypersight/protocol';
import type { CompanionApi } from './api';
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
  const renderWatch = (keys: string[]) =>
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
  const describeRule = (r: AlertRule): string => {
    const p = r.params;
    switch (r.kind) {
      case 'priceCross':
        return `${p.coin} ${p.dir === 'below' ? 'below' : 'above'} ${p.px}`;
      case 'oddsMove':
        return `${p.marketKey} moves ${p.points} pts`;
      case 'pnlPct':
        return `${p.coin} PnL ${p.pct}%`;
      case 'liqDistance':
        return `Liquidation closer than ${p.pct}%`;
      case 'fill':
        return 'Resting order filled';
      case 'settled':
        return 'Held outcome settled';
    }
  };
  const renderRules = (rules: AlertRule[]) =>
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
  const coin = field('Coin', 'ETH', { type: 'text' });
  const px = field('Price', '');
  const dir = h(
    'select',
    {},
    h('option', { value: 'above' }, 'above'),
    h('option', { value: 'below' }, 'below'),
  );
  const addRule = button('Add price alert', () => {
    const c = coin.input.value.trim().toUpperCase();
    const price = Number(px.input.value);
    if (!c || !(price > 0)) return say('Enter a coin and a price');
    const rule: AlertRule = {
      id: `price-${c}-${dir.value}-${price}`.slice(0, 64),
      kind: 'priceCross',
      params: { coin: c, px: price, dir: dir.value },
      cooldownMs: 600_000,
      enabled: true,
    };
    void api.saveRule(rule).then(() => api.rules().then(renderRules), fail('add the alert'));
  });

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
      h(
        'div',
        { class: 'inline' },
        coin.row,
        h('label', { class: 'field' }, h('span', {}, 'When'), dir),
        px.row,
      ),
      addRule,
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
