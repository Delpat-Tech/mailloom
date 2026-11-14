import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationsPanel } from '../components/NotificationsPanel.js';
import { takeOpenTargetFromHash } from '../services/push.js';

const PUBLIC_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const ENDPOINT = 'https://web.push.apple.com/QFakeEndpoint';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const device = (over: Record<string, unknown> = {}) => ({
  id: 'dev1',
  label: 'iPhone',
  show_details: false,
  quiet: false,
  created_at: new Date().toISOString(),
  last_push_at: null,
  disabled_at: null,
  disabled_reason: null,
  status: 'on',
  ...over
});

/** A fake server: push config, devices, and the subscribe call. */
function stubServer(opts: { enabled?: boolean; registered?: ReturnType<typeof device> | null } = {}) {
  const calls: Call[] = [];
  let registered = opts.registered ?? null;
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/push/config')) return json({ enabled: opts.enabled ?? true, public_key: PUBLIC_KEY, max_devices: 10 });
    if (url.endsWith('/push/devices') && method === 'GET') return json({ devices: registered ? [registered] : [] });
    if (url.endsWith('/push/device')) return json({ device: registered });
    if (url.endsWith('/push/subscribe')) {
      registered = device({ show_details: (body as { show_details: boolean }).show_details });
      return json({ device: registered }, 201);
    }
    if (url.includes('/push/devices/') && method === 'DELETE') {
      registered = null;
      return json({ deleted: true });
    }
    return json({ error: 'unexpected' }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

/** A browser with service worker + push, and a PushManager that hands out a fake subscription. */
function stubBrowserPush(opts: { existing?: boolean; ua?: string; standalone?: boolean } = {}) {
  let sub: Record<string, unknown> | null = null;
  const makeSub = () => ({
    endpoint: ENDPOINT,
    options: { applicationServerKey: null },
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } }),
    unsubscribe: vi.fn(async () => {
      sub = null;
      return true;
    })
  });
  if (opts.existing) sub = makeSub();
  const pushManager = {
    getSubscription: vi.fn(async () => sub),
    subscribe: vi.fn(async () => {
      sub = makeSub();
      return sub;
    })
  };
  const reg = { pushManager };
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'userAgent', { value: opts.ua ?? 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', configurable: true });
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { getRegistration: vi.fn(async () => reg), register: vi.fn(), ready: Promise.resolve(reg), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    configurable: true
  });
  vi.stubGlobal('PushManager', function PushManager() {});
  const NotificationStub = Object.assign(function Notification() {}, {
    permission: 'default' as NotificationPermission,
    requestPermission: vi.fn(async () => {
      NotificationStub.permission = 'granted';
      return 'granted' as NotificationPermission;
    })
  });
  vi.stubGlobal('Notification', NotificationStub);
  window.matchMedia = vi.fn().mockReturnValue({ matches: !!opts.standalone }) as unknown as typeof window.matchMedia;
  return { pushManager, NotificationStub };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  window.location.hash = '';
});

describe('NotificationsPanel', () => {
  it('explains what is stored and turns on with the password, details off by default', async () => {
    const user = userEvent.setup();
    const calls = stubServer();
    const { pushManager, NotificationStub } = stubBrowserPush();
    render(<NotificationsPanel email="a@delpat.in" otherAccounts={0} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeTruthy();
    await waitFor(() => screen.getByText('What is stored'));
    expect(screen.getByText(/keeps\s+your mailbox password, encrypted/)).toBeTruthy();
    expect(screen.getByText(/Turning notifications off here, or signing out on this device, deletes it/)).toBeTruthy();
    const details = screen.getByRole('checkbox', { name: /Show sender and subject/ }) as HTMLInputElement;
    expect(details.checked).toBe(false);

    await user.type(screen.getByLabelText('Mailbox password'), 'secret-pw');
    await user.click(screen.getByRole('button', { name: /Turn on notifications for this device/ }));

    await waitFor(() => screen.getByText(/On for this device/));
    expect(NotificationStub.requestPermission).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const sub = calls.find((c) => c.url.endsWith('/push/subscribe'))!;
    expect(sub.body).toMatchObject({ password: 'secret-pw', show_details: false, quiet: false, subscription: { endpoint: ENDPOINT } });
  });

  it('turning off deletes the device on the server and drops the browser subscription', async () => {
    const user = userEvent.setup();
    const calls = stubServer({ registered: device() });
    stubBrowserPush({ existing: true });
    render(<NotificationsPanel email="a@delpat.in" otherAccounts={0} onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Turn off on this device' }));
    await waitFor(() => screen.getByText(/The saved password was deleted/));
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/push/devices/dev1'))).toBe(true);
    expect(screen.getByRole('button', { name: /Turn on notifications for this device/ })).toBeTruthy();
  });

  it('on iPhone Safari outside the home-screen app, explains how to install', async () => {
    stubServer();
    stubBrowserPush({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1' });
    render(<NotificationsPanel email="a@delpat.in" otherAccounts={0} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText(/Add Mailloom to your Home Screen first/));
    expect(screen.queryByLabelText('Mailbox password')).toBeNull();
  });

  it('says so when the server has push turned off', async () => {
    stubServer({ enabled: false });
    stubBrowserPush();
    render(<NotificationsPanel email="a@delpat.in" otherAccounts={0} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText(/not set up on this server yet/));
    expect(screen.queryByLabelText('Mailbox password')).toBeNull();
  });

  it('shows why notifications stopped', async () => {
    stubServer({ registered: device({ status: 'stopped', disabled_at: new Date().toISOString(), disabled_reason: 'mail server refused the saved password' }) });
    stubBrowserPush({ existing: true });
    render(<NotificationsPanel email="a@delpat.in" otherAccounts={0} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText(/no longer accepts the saved password/));
    expect(screen.getByLabelText('Mailbox password')).toBeTruthy();
  });
});

describe('notification tap target', () => {
  it('reads and removes the #open fragment', () => {
    window.location.hash = '#open=' + encodeURIComponent(JSON.stringify({ mailbox: 'a@delpat.in', folder: 'INBOX', uid: 42 }));
    expect(takeOpenTargetFromHash()).toEqual({ mailbox: 'a@delpat.in', folder: 'INBOX', uid: 42 });
    expect(window.location.hash).toBe('');
    window.location.hash = '#open=not-json';
    expect(takeOpenTargetFromHash()).toBeNull();
  });
});
