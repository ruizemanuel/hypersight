import type { AlertRule, Settings } from '@hypersight/protocol';

export type MarketHit = { key: string; title: string; short: string; expiresAt: number | null };
export type HistoryEntry = { ts: number; kind: string; proposalId: string; summary: string };
export type Status = {
  mode: string;
  network: string;
  connected: boolean;
  latency: { sttMs?: number; intentMs?: number; execMs?: number };
};
export type SettingsPatch = {
  risk?: Partial<Settings['risk']>;
  presets?: Partial<Settings['presets']>;
};

/** `ws://host:8787/ws` → `http://host:8787` (the API lives on the same server as the socket). */
export function httpBaseFromWs(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  return u.origin;
}

/** Typed client for the companion API (bearer token, JSON). */
export function createCompanionApi(baseUrl: string, token: string) {
  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }
  return {
    status: () => call<Status>('/status'),
    settings: () => call<Settings>('/settings'),
    saveSettings: (patch: SettingsPatch) =>
      call<Settings>('/settings', { method: 'PUT', body: patch }),
    searchMarkets: (q: string) => call<MarketHit[]>(`/markets?q=${encodeURIComponent(q)}`),
    watch: () => call<string[]>('/watch'),
    addWatch: (key: string) => call<string[]>('/watch', { method: 'POST', body: { key } }),
    removeWatch: (key: string) =>
      call<string[]>(`/watch/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    rules: () => call<AlertRule[]>('/rules'),
    saveRule: (rule: AlertRule) =>
      call<AlertRule>(`/rules/${encodeURIComponent(rule.id)}`, { method: 'PUT', body: rule }),
    deleteRule: (id: string) =>
      call<{ ok: true }>(`/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    history: (limit = 50) => call<HistoryEntry[]>(`/history?limit=${limit}`),
  };
}

export type CompanionApi = ReturnType<typeof createCompanionApi>;
