import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectConsent } from '../components/ConnectConsent.js';
import { ConnectionsPanel } from '../components/ConnectionsPanel.js';
import { isSafeReturnUrl, parseConnectHash } from '../services/connect.js';
import { setActiveHandle } from '../services/api.js';

const ID = 'abcdefghijklmnopqrstuv';
const A1 = { handle: 'aaaaaaaaaaaa', email: 'om@delpat.in', name: 'om' };
const A2 = { handle: 'bbbbbbbbbbbb', email: 'asha@delpat.in', name: 'asha' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Call {
  url: string;
  method: string;
  account: string | null;
  body: Record<string, unknown> | undefined;
}

function server(
  opts: {
    accounts?: unknown[];
    request?: Record<string, unknown> | 404;
    consent?: (body: Record<string, unknown>) => Response;
    signIn?: unknown;
  } = {}
) {
  const calls: Call[] = [];
  let signedIn = opts.accounts ?? [A1];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init.method || 'GET', account: headers.get('X-Mailloom-Account'), body });
    if (url.endsWith('/auth/accounts')) return json({ accounts: signedIn });
    if (url.endsWith('/auth/connect')) {
      signedIn = [opts.signIn ?? A1];
      return json({ account: opts.signIn ?? A1 });
    }
    if (url.includes('/oauth/requests?')) {
      if (opts.request === 404) return json({ code: 'REQUEST_NOT_FOUND', error: 'gone' }, 404);
      return json(
        opts.request ?? {
          client_name: 'Work OS',
          label: 'Delpat',
          scopes: ['read', 'organise', 'send'],
          redirect_host: 'os.example',
          expires_at: new Date().toISOString()
        }
      );
    }
    if (url.endsWith('/oauth/consent')) {
      return opts.consent ? opts.consent(body!) : json({ redirect: 'https://os.example/api/mail/callback?code=c&state=s&iss=i' });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
  setActiveHandle(null);
});

describe('connect links', () => {
  it('parses only #/connect/<id>', () => {
    expect(parseConnectHash(`#/connect/${ID}`)).toBe(ID);
    expect(parseConnectHash(`#/connect/${ID}/`)).toBe(ID);
    expect(parseConnectHash('#/connect/')).toBeNull();
    expect(parseConnectHash('#/connect/short')).toBeNull();
    const blob = `${'a'.repeat(300)}.${'b'.repeat(43)}`;
    expect(parseConnectHash(`#/connect/${blob}`)).toBe(blob);
    expect(parseConnectHash(`#/connect/${'a'.repeat(2500)}`)).toBeNull();
    expect(parseConnectHash(`#/m/${ID}`)).toBeNull();
    expect(parseConnectHash(`#/connect/${ID}?x=1`)).toBeNull();
  });
  it('only returns to https, or http on this computer', () => {
    expect(isSafeReturnUrl('https://os.example/cb?code=1')).toBe(true);
    expect(isSafeReturnUrl('http://localhost:4000/cb')).toBe(true);
    expect(isSafeReturnUrl('http://os.example/cb')).toBe(false);
    expect(isSafeReturnUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeReturnUrl('//evil.example')).toBe(false);
  });
});

describe('ConnectConsent', () => {
  it('shows the client, the mailbox, three ticks with read locked on, the password field and both buttons', async () => {
    server();
    render(<ConnectConsent requestId={ID} navigate={vi.fn()} />);
    await screen.findByText(/wants to read, move and send mail as/);
    expect(screen.getByText('Work OS', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('Delpat')).toBeTruthy();
    expect(screen.getByText(/Organisation:/).className).toMatch(/text-ink-3/);
    expect(screen.getByText(/Only allow this if you just clicked Connect in Work OS yourself/)).toBeTruthy();
    expect(screen.getByText('om@delpat.in')).toBeTruthy();
    const read = screen.getByLabelText(/Read and search mail/) as HTMLInputElement;
    const organise = screen.getByLabelText(/Move, flag/) as HTMLInputElement;
    const send = screen.getByLabelText(/Send, reply/) as HTMLInputElement;
    expect([read.checked, organise.checked, send.checked]).toEqual([true, true, true]);
    expect(read.disabled).toBe(true);
    expect(screen.getByRole('checkbox', { name: /read and search mail, always on/i })).toBe(read);
    expect(screen.getByRole('checkbox', { name: /move, flag/i })).toBe(organise);
    expect(screen.getByRole('checkbox', { name: /send/i })).toBe(send);
    expect(organise.disabled).toBe(false);
    expect(screen.getByLabelText(/Your mailbox password/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.queryByText(/Connect which mailbox/)).toBeNull();
    expect(screen.getByText(/go back to os\.example/)).toBeTruthy();
  });

  it('Allow needs a password, sends the ticked scopes as this mailbox, and goes to the returned address', async () => {
    const user = userEvent.setup();
    const { calls } = server();
    const navigate = vi.fn();
    render(<ConnectConsent requestId={ID} navigate={navigate} />);
    const allow = (await screen.findByRole('button', { name: 'Allow' })) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    await user.click(screen.getByLabelText(/Send, reply/));
    await user.type(screen.getByLabelText(/Your mailbox password/), 'secret-pw');
    await user.click(allow);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://os.example/api/mail/callback?code=c&state=s&iss=i'));
    const post = calls.find((c) => c.url.endsWith('/oauth/consent'))!;
    expect(post.method).toBe('POST');
    expect(post.account).toBe(A1.handle);
    expect(post.body).toEqual({ request_id: ID, allow: true, scopes: ['read', 'organise'], password: 'secret-pw' });
  });

  it('Cancel sends allow false with no password and goes back', async () => {
    const user = userEvent.setup();
    const { calls } = server({ consent: () => json({ redirect: 'https://os.example/api/mail/callback?error=access_denied&state=s&iss=i' }) });
    const navigate = vi.fn();
    render(<ConnectConsent requestId={ID} navigate={navigate} />);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate.mock.calls[0]![0]).toContain('error=access_denied');
    expect(calls.find((c) => c.url.endsWith('/oauth/consent'))!.body).toEqual({ request_id: ID, allow: false });
  });

  it('a wrong password shows the message, clears the field and stays on the screen', async () => {
    const user = userEvent.setup();
    server({ consent: () => json({ code: 'WRONG_PASSWORD', error: 'That password is not right.' }, 401) });
    const navigate = vi.fn();
    render(<ConnectConsent requestId={ID} navigate={navigate} />);
    await user.type(await screen.findByLabelText(/Your mailbox password/), 'nope');
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/not right/);
    expect(navigate).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Your mailbox password/) as HTMLInputElement).value).toBe('');
  });

  it('never opens an address that is not https (or local http)', async () => {
    const user = userEvent.setup();
    server({ consent: () => json({ redirect: 'javascript:alert(1)' }) });
    const navigate = vi.fn();
    render(<ConnectConsent requestId={ID} navigate={navigate} />);
    await user.type(await screen.findByLabelText(/Your mailbox password/), 'pw');
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await screen.findByRole('alert');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('asks which mailbox when several are signed in, and answers as the chosen one', async () => {
    const user = userEvent.setup();
    setActiveHandle(A1.handle);
    const { calls } = server({ accounts: [A1, A2] });
    const navigate = vi.fn();
    render(<ConnectConsent requestId={ID} navigate={navigate} />);
    await screen.findByText('Connect which mailbox?');
    expect((screen.getByLabelText(A1.email) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByLabelText(A2.email));
    await waitFor(() => expect(screen.getByText(A2.email, { selector: 'strong' })).toBeTruthy());
    await user.type(screen.getByLabelText(/Your mailbox password/), 'pw');
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(calls.find((c) => c.url.endsWith('/oauth/consent'))!.account).toBe(A2.handle);
    expect(calls.filter((c) => c.url.includes('/oauth/requests?')).map((c) => c.account)).toEqual([A1.handle, A2.handle]);
  });

  it('signs in first when nobody is signed in, then shows the consent screen', async () => {
    const user = userEvent.setup();
    server({ accounts: [] });
    render(<ConnectConsent requestId={ID} navigate={vi.fn()} />);
    await screen.findByText('Sign in to continue connecting.');
    await user.type(await screen.findByLabelText(/Email Address/), A1.email);
    await user.type(screen.getByLabelText(/^Password/), 'pw');
    await user.click(screen.getByRole('button', { name: /Sign In to Mailbox/ }));
    await screen.findByText(/wants to read, move and send mail as/);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  });

  it('shows only the permissions that were asked for', async () => {
    server({ request: { client_name: 'Work OS', label: null, scopes: ['read', 'send'], redirect_host: 'os.example', expires_at: '' } });
    render(<ConnectConsent requestId={ID} navigate={vi.fn()} />);
    await screen.findByText(/wants to read and send mail as/);
    expect(screen.queryByLabelText(/Move, flag/)).toBeNull();
    expect(screen.getByText('Work OS', { selector: 'strong' })).toBeTruthy();
  });

  it('says so when the request expired', async () => {
    server({ request: 404 });
    render(<ConnectConsent requestId={ID} navigate={vi.fn()} />);
    await screen.findByText(/expired or was already answered/);
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });
});

describe('Connections list', () => {
  it('shows a Connect key as "Work OS (Delpat), connected 16 Nov" and a hand-made key as created', async () => {
    const base = {
      email: 'om@delpat.in',
      scopes: ['read'],
      last_used_at: null,
      revoked_at: null,
      broken_at: null,
      broken_reason: null,
      status: 'active'
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/connections/keys')) {
          return json({
            agent_api_enabled: true,
            keys: [
              { ...base, id: 'k1', prefix: 'mlk_aaaaaaaa', name: 'Work OS', client_id: 'work-os', label: 'Delpat', created_at: '2026-11-16T10:00:00.000Z' },
              { ...base, id: 'k2', prefix: 'mlk_bbbbbbbb', name: 'My script', client_id: null, label: null, created_at: '2026-11-10T10:00:00.000Z' }
            ]
          });
        }
        return json({ entries: [] });
      })
    );
    render(<ConnectionsPanel embedded email="om@delpat.in" onClose={() => undefined} />);
    await screen.findByText((_, el) => el?.tagName === 'DIV' && /^Work OS \(Delpat\), connected 16 Nov/.test(el.textContent ?? ''));
    expect(screen.getByText(/^Created /)).toBeTruthy();
  });
});
