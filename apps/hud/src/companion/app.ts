import type { AlertRule, Settings } from '@hypersight/protocol';
import type { CompanionApi, TelegramChat, WatchedMarket } from './api';
import { buildRule, describeRule, type RuleForm } from './rules';
import { button, field, fmtMs, fmtTime, h, section } from './views';

const STATUS_REFRESH_MS = 5000;

/**
 * Phone-side setup screen: status, watchlist, presets, risk limits, alert rules, Telegram chats
 * and history.
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
        tg.enabled = s.telegram !== null && s.telegram !== undefined;
        tg.bot = s.telegram?.bot ?? null;
        renderTgHint();
        // Waiting for the first chat: it shows up as soon as the bot sees a message there.
        if (tg.enabled && tg.count === 0) loadChats();
        mode.textContent = s.mode === 'paper' ? 'PAPER' : 'TESTNET';
        latency.textContent = `Voice → text ${fmtMs(s.latency.sttMs)} · intent ${fmtMs(s.latency.intentMs)} · execution ${fmtMs(s.latency.execMs)}`;
      })
      .catch(() => {
        latency.textContent = 'Server unreachable';
      });

  // Watchlist
  const watchList = h('ul', { class: 'list' });
  const results = h('ul', { class: 'list results' });
  const renderWatch = (markets: WatchedMarket[]) => {
    renderOddsMarkets(markets);
    watchList.replaceChildren(
      ...markets.map((m) =>
        h(
          'li',
          {},
          h('span', {}, m.short, m.title !== m.short ? h('small', {}, m.title) : null),
          button(
            'Remove',
            () => void api.removeWatch(m.key).then(renderWatch, fail('remove')),
            'ghost',
          ),
        ),
      ),
      ...(markets.length === 0 ? [h('li', { class: 'muted' }, 'Nothing watched yet')] : []),
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
  const renderOddsMarkets = (markets: WatchedMarket[]) =>
    oddsMarket.el.replaceChildren(
      ...(markets.length === 0
        ? [h('option', { value: '' }, 'Watch a market first')]
        : markets.map((m) => h('option', { value: m.key }, m.short))),
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

  // Telegram: chats the bot is in; a followed chat's trade calls become glasses alerts.
  const tg = { enabled: true, bot: null as string | null, count: -1 };
  const tgHint = h('p', { class: 'muted' }, 'Loading chats…');
  const tgList = h('ul', { class: 'list' });
  const renderTgHint = () => {
    tgHint.textContent = !tg.enabled
      ? 'Telegram is off on this server (no bot token).'
      : tg.count === 0
        ? `Add @${tg.bot ?? 'the bot'} to a group, send a message, then follow it here.`
        : tg.count > 0
          ? 'Trade calls in followed chats reach the glasses sized from your quick actions — nothing runs until you confirm.'
          : 'Loading chats…';
  };
  const renderChats = (chats: TelegramChat[]) => {
    tg.count = chats.length;
    renderTgHint();
    tgList.replaceChildren(
      ...chats.map((c) => {
        const toggle = (label: string, key: 'follow' | 'replyFills') =>
          h(
            'label',
            { class: 'rule' },
            h('input', {
              type: 'checkbox',
              checked: c[key],
              onchange: (ev: Event) =>
                void api
                  .setTelegramChat(c.id, { [key]: (ev.target as HTMLInputElement).checked })
                  .then(loadChats, fail('update the chat')),
            }),
            h('span', {}, label),
          );
        return h(
          'li',
          {},
          h('span', {}, c.title, h('small', {}, c.type)),
          h(
            'div',
            { class: 'toggles' },
            toggle('Follow', 'follow'),
            toggle('Reply when filled', 'replyFills'),
          ),
        );
      }),
    );
  };
  const loadChats = () => void api.telegramChats().then(renderChats, fail('load Telegram chats'));

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
    section('Telegram', tgHint, tgList, button('Refresh', loadChats, 'ghost')),
    section('History', historyList, button('Refresh', renderHistory, 'ghost')),
    h('p', { class: 'muted foot' }, 'Testnet only · the agent wallet cannot withdraw funds'),
    toast,
  );

  void refreshStatus();
  setInterval(() => void refreshStatus(), STATUS_REFRESH_MS);
  void api.watch().then(renderWatch, fail('load the watchlist'));
  void api.settings().then(renderSettings, fail('load settings'));
  void api.rules().then(renderRules, fail('load alerts'));
  loadChats();
  renderHistory();

  return {
    setLink(text: string) {
      link.textContent = text;
    },
  };
}
