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

import { viewerKind, pdfNeedsNewTab } from '../components/AttachmentViewer.js';

describe('inline viewer', () => {
  it('opens pictures and PDF, downloads everything else', () => {
    expect(viewerKind('image/png')).toBe('image');
    expect(viewerKind('image/jpeg; name=a.jpg')).toBe('image');
    expect(viewerKind('application/pdf')).toBe('pdf');
    expect(viewerKind('application/octet-stream', 'scan.PDF')).toBe('pdf');
    expect(viewerKind('image/svg+xml')).toBeNull();
    expect(viewerKind('application/zip', 'a.zip')).toBeNull();
  });
  it('sends PDF to its own tab on iPhone and iPad', () => {
    expect(pdfNeedsNewTab('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5)).toBe(true);
    expect(pdfNeedsNewTab('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(pdfNeedsNewTab('Mozilla/5.0 (Windows NT 10.0)', 0)).toBe(false);
  });
  it('the inline address adds inline=1 next to the account', () => {
    setActiveHandle('acct1');
    expect(api.getAttachmentUrl('INBOX', 3, '2', { inline: true })).toMatch(/attachments\/2\?account=acct1&inline=1$/);
    expect(api.getAttachmentUrl('INBOX', 3, '2')).toMatch(/attachments\/2\?account=acct1$/);
    setActiveHandle(null);
  });
});
