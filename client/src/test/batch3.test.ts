import { describe, it, expect, vi, afterEach } from 'vitest';
import { request, ApiError } from '../services/api.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function hangingFetch() {
  return vi.fn((_url: string, init: RequestInit) =>
    new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })
  );
}

describe('request timeouts', () => {
  it('gives up after 20 s with a plain retry message', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const p = request('/mailboxes').catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_001);
    const err = (await p) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toMatch(/try again/i);
  });

  it('allows 120 s for uploads and sends', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    let settled = false;
    const p = request('/messages/send', { method: 'POST', body: new FormData() }).catch((e) => {
      settled = true;
      return e;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(((await p) as ApiError).code).toBe('TIMEOUT');
  });
});

import { BUILT_IN_TEMPLATES, fillTemplateVariables, findPlaceholder } from '../services/templates.js';

describe('built-in templates', () => {
  it('hold no made-up data: every variable is an empty {{placeholder}}', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      for (const v of t.variables) expect(v.defaultValue).toBeUndefined();
      const text = `${t.subject}\n${t.body}`;
      expect(text).not.toMatch(/\d{4}|₹|https?:|@|Vadodara|Akash|Rohan|Verma|Alex/);
      for (const v of t.variables) expect(text).toContain(`{{${v.key}}}`);
    }
  });

  it('an empty field keeps its placeholder; a filled one is replaced', () => {
    const t = BUILT_IN_TEMPLATES[0]!;
    const out = fillTemplateVariables(t, { candidate_name: 'Sam', role: '  ' });
    expect(out.body).toContain('Dear Sam,');
    expect(out.subject).toBe('Job offer: {{role}}');
    expect(findPlaceholder(out.body)).toBe('{{role}}');
    expect(findPlaceholder('all filled in')).toBeNull();
  });
});

import { api, setActiveHandle } from '../services/api.js';
import { getLoadPictures, setLoadPictures } from '../services/settings.js';

describe('load pictures automatically', () => {
  function urlOfDetail(opts: { showImages?: boolean } = {}): Promise<string> {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ uid: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return api.getMessageDetail('INBOX', 1, opts).then(() => (fetchMock.mock.calls[0] as unknown as [string])[0]);
  }

  it('asks for images=auto by default, nothing when switched off, images=1 for Show images', async () => {
    setActiveHandle('acct1');
    expect(getLoadPictures('acct1')).toBe(true);
    expect(await urlOfDetail()).toContain('images=auto');
    expect(await urlOfDetail({ showImages: true })).toContain('images=1');
    setLoadPictures('acct1', false);
    expect(getLoadPictures('acct1')).toBe(false);
    expect(await urlOfDetail()).not.toContain('images=');
    setLoadPictures('acct1', true);
    setActiveHandle(null);
  });
});
