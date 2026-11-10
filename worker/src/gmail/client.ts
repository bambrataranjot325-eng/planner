const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
/** The saved history cursor is too old for Gmail to replay. */
export class HistoryExpiredError extends Error {}

export interface GmailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listMessageIds(query: string, max: number): Promise<string[]>;
  listAddedSince(historyId: string): Promise<{ ids: string[]; historyId: string | null }>;
  getMessage(id: string): Promise<any>;
}

export function makeGmailApi(accessToken: string, opts: { baseDelayMs?: number; paceMs?: number } = {}): GmailApi {
  const baseDelay = opts.baseDelayMs ?? 5000;
  const pace = opts.paceMs ?? 150; // small gap between calls so a long backfill stays under Gmail's per-minute quota
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function get(path: string, params: Record<string, string | string[]> = {}): Promise<any> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
    }
    let last: GmailError | null = null;
    // Gmail answers 429, or 403 "Quota exceeded" / "rate limit", when calls come too fast. Wait and retry.
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await sleep(Math.min(baseDelay * 2 ** (attempt - 1), 60_000));
      else if (pace) await sleep(pace);
      let res: Response;
      try {
        res = await fetch(`${BASE}/${path}?${q}`, {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        last = new GmailError(0, `Gmail ${path.split('/')[0]} network error: ${(e as Error).message}`);
        continue;
      }
      if (res.ok) return res.json();
      const body: any = await res.json().catch(() => ({}));
      const message: string = body?.error?.message ?? '';
      last = new GmailError(res.status, `Gmail ${path.split('/')[0]} ${res.status}: ${message}`);
      const rateLimited = res.status === 429 || (res.status === 403 && /quota|rate limit/i.test(message));
      if (!rateLimited && res.status < 500) break;
    }
    throw last!;
  }

  return {
    async getProfile() {
      const p = await get('profile');
      return { emailAddress: p.emailAddress, historyId: String(p.historyId) };
    },
    async listMessageIds(query, max) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await get('messages', { q: query, maxResults: '100', ...(pageToken ? { pageToken } : {}) });
        for (const m of page.messages ?? []) ids.push(m.id);
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < max);
      return ids.slice(0, max);
    },
    async listAddedSince(historyId) {
      const ids = new Set<string>();
      let latest: string | null = null;
      let pageToken: string | undefined;
      try {
        do {
          const page = await get('history', {
            startHistoryId: historyId,
            historyTypes: 'messageAdded',
            labelId: 'INBOX',
            maxResults: '500',
            ...(pageToken ? { pageToken } : {}),
          });
          for (const h of page.history ?? []) {
            for (const a of h.messagesAdded ?? []) if (a.message?.id) ids.add(a.message.id);
          }
          if (page.historyId) latest = String(page.historyId);
          pageToken = page.nextPageToken;
        } while (pageToken);
      } catch (e) {
        if (e instanceof GmailError && e.status === 404) throw new HistoryExpiredError();
        throw e;
      }
      return { ids: [...ids], historyId: latest };
    },
    async getMessage(id) {
      try {
        return await get(`messages/${id}`, { format: 'full' });
      } catch (e) {
        if (e instanceof GmailError && e.status === 404) return null; // deleted since it was listed
        throw e;
      }
    },
  };
}
