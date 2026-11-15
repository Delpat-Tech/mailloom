import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage, type SettingsPageProps } from '../components/settings/SettingsPage.js';
import { AccountMenu } from '../components/AccountMenu.js';
import { parseSettingsHash, settingsHash, SECTIONS, type SectionId } from '../components/settings/sections.js';
import { useAccountSettings } from '../hooks/useAccountSettings.js';
import { loadSettings } from '../services/settingsSync.js';
import { setActiveHandle, api } from '../services/api.js';
import { splitSignatureHtml, composeSignatureHtml } from '../services/signatures.js';
import type { AccountSettings } from '../services/accountSettings.js';

const DEFAULTS: AccountSettings = {
  version: 1,
  loadPictures: true,
  signature: { html: '<p>Asha</p>', logo: null },
  templates: [],
  theme: 'system',
  defaultReply: 'reply'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** A tiny settings server: GET and PATCH /settings with versions, plus a message request that records its URL. */
function stubServer(start: Partial<AccountSettings> = {}) {
  let doc: AccountSettings = { ...DEFAULTS, ...start };
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/settings') && method === 'GET') return json(doc);
    if (url.endsWith('/settings') && method === 'PATCH') {
      const { version, importLocal, ...rest } = body as { version: number; importLocal?: Record<string, unknown> } & Record<string, unknown>;
      if (version !== doc.version) return json({ code: 'VERSION_CONFLICT', error: 'Settings changed elsewhere.' }, 409);
      doc = { ...doc, ...(rest as Partial<AccountSettings>), version: doc.version + 1 };
      if (importLocal) doc = { ...doc, ...(importLocal as Partial<AccountSettings>) };
      return json(doc);
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, get doc() { return doc; } };
}

function stubMedia(desktop: boolean, touchOnly = false) {
  window.matchMedia = vi.fn((q: string) => ({
    matches: q.includes('min-width: 1024px') ? desktop : q.includes('hover: none') ? touchOnly : false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  setActiveHandle('h1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setActiveHandle(null);
  document.documentElement.removeAttribute('data-theme');
});

const account = { handle: 'h1', email: 'tester@delpat.test', name: 'Tester' };
const accounts = [{ handle: 'h1', email: 'tester@delpat.test', name: 'Tester', lastActive: 2 }];

function baseProps(over: Partial<SettingsPageProps> = {}): SettingsPageProps {
  return {
    section: null,
    onSection: () => undefined,
    onClose: () => undefined,
    settings: DEFAULTS,
    loadError: null,
    onUpdate: async () => undefined,
    account,
    accounts,
    onSwitchAccount: () => undefined,
    onRemoveAccount: () => undefined,
    onAddAccount: () => undefined,
    onSignOut: () => undefined,
    labels: [{ id: '1', name: 'Client', colour: 'blue', count: 0 }],
    onRenameLabel: () => undefined,
    onRecolourLabel: () => undefined,
    onDeleteLabel: () => undefined,
    onCreateLabel: () => undefined,
    onMoveLabel: () => undefined,
    requestConfirm: () => undefined,
    notificationPerm: 'default',
    onOpenShortcuts: () => undefined,
    ...over
  };
}

/** Holds the open section like the app does, so clicks move between screens. */
const Host: React.FC<{ start?: SectionId | null; onClose?: () => void; props?: Partial<SettingsPageProps> }> = ({ start = null, onClose = () => undefined, props }) => {
  const [section, setSection] = useState<SectionId | null>(start);
  return <SettingsPage {...baseProps({ section, onSection: setSection, onClose, ...props })} />;
};

describe('Settings sections and links', () => {
  it('has the seven sections in the agreed order', () => {
    expect(SECTIONS.map((s) => s.title)).toEqual(['General', 'Writing', 'Notifications', 'Labels', 'Accounts', 'Connections', 'App']);
  });
  it('reads #/settings/<section> and ignores everything else', () => {
    expect(parseSettingsHash('#/settings/labels')).toBe('labels');
    expect(parseSettingsHash('#/settings')).toBe('general');
    expect(parseSettingsHash('#/settings/nonsense')).toBe('general');
    expect(parseSettingsHash('#/m/abc')).toBeNull();
    expect(parseSettingsHash('')).toBeNull();
    expect(settingsHash('writing')).toBe('#/settings/writing');
  });
});

describe('Settings on a phone', () => {
  beforeEach(() => stubMedia(false));

  it('shows the list with a one-line summary, opens a section, and goes back one step at a time', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Host onClose={onClose} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    for (const s of SECTIONS) expect(screen.getByRole('button', { name: new RegExp(`^${s.title}`) })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Writing/ }).textContent).toMatch(/Signature on, 0 templates/);

    await user.click(screen.getByRole('button', { name: /^Writing/ }));
    expect(screen.getByRole('heading', { level: 1, name: 'Writing' })).toBeTruthy();
    // Back arrow: section -> list.
    await user.click(screen.getByRole('button', { name: 'Back to Settings' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    // Escape: section -> list -> out.
    await user.click(screen.getByRole('button', { name: /^General/ }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    // The list's own back arrow closes Settings too.
    await user.click(screen.getByRole('button', { name: 'Close Settings' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('gives every phone control a touch target of at least 44 px', async () => {
    render(<Host start="general" />);
    for (const el of [...screen.getAllByRole('button'), ...screen.getAllByRole('switch'), ...screen.getAllByRole('radio')]) {
      expect(el.className).toMatch(/min-h-\[(44|56|64)px\]/);
    }
  });
});

describe('Settings on a desktop', () => {
  beforeEach(() => stubMedia(true));

  it('shows sections on the left and the content on the right; switching sections and Escape work', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Host onClose={onClose} />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('button')).toHaveLength(7);
    // General is open by default.
    expect(screen.getByRole('heading', { level: 2, name: 'General' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page');
    await user.click(within(nav).getByRole('button', { name: 'Accounts' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Accounts' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Accounts' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getAllByText('tester@delpat.test').length).toBeGreaterThan(0);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens Labels with the existing manager (add, rename, recolour, reorder, delete controls)', async () => {
    render(<Host start="labels" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Labels' })).toBeTruthy();
    expect(screen.getByLabelText('Name of label Client')).toBeTruthy();
    expect(screen.getByLabelText('New label name')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete label Client' })).toBeTruthy();
  });

  it('the Theme control sets the theme for this device and hides nothing it should show', async () => {
    const user = userEvent.setup();
    render(<Host start="general" />);
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('mailloom.theme')).toBe('dark');
    await user.click(screen.getByRole('radio', { name: 'System' }));
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(localStorage.getItem('mailloom.theme')).toBe('system');
  });

  it('shows the keyboard shortcuts row, and hides it on a touch-only device', async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(<Host start="general" props={{ onOpenShortcuts: open }} />);
    await user.click(screen.getByRole('button', { name: /Keyboard shortcuts/ }));
    expect(open).toHaveBeenCalled();
    unmount();
    stubMedia(true, true);
    render(<Host start="general" />);
    expect(screen.queryByRole('button', { name: /Keyboard shortcuts/ })).toBeNull();
  });

  it('App shows the version and the iPhone steps are not shown on a desktop', () => {
    render(<Host start="app" />);
    expect(screen.getByTestId('app-version').textContent).toBeTruthy();
    expect(screen.getByRole('button', { name: /Check for update/ })).toBeTruthy();
    expect(screen.queryByText(/Add to Home Screen/)).toBeNull();
  });
});

describe('Avatar menu', () => {
  const menuProps = (over = {}) => ({
    label: 'Tester',
    email: 'tester@delpat.test',
    accounts: [
      { handle: 'h1', email: 'tester@delpat.test', name: 'Tester', lastActive: 2 },
      { handle: 'h2', email: 'colleague@delpat.test', lastActive: 1 }
    ],
    onSwitch: vi.fn(),
    onAdd: vi.fn(),
    onSettings: vi.fn(),
    onSignOut: vi.fn(),
    ...over
  });

  it('opens from the avatar with the accounts, Add mailbox, Settings and Sign out, and nothing else', async () => {
    const p = menuProps();
    const user = userEvent.setup();
    render(<AccountMenu {...p} />);
    await user.click(screen.getByRole('button', { name: /Account menu/ }));
    const menu = screen.getByRole('menu', { name: 'Account menu' });
    const items = Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((i) => i.textContent?.trim());
    expect(items).toHaveLength(5);
    expect(items[0]).toContain('tester@delpat.test');
    expect(items[1]).toContain('colleague@delpat.test');
    expect(items.slice(2)).toEqual(['Add mailbox', 'Settings', 'Sign out of this device']);
    expect(within(menu).getByRole('menuitemradio', { name: /Tester/ }).getAttribute('aria-checked')).toBe('true');
    expect(within(menu).getByRole('menuitemradio', { name: /colleague/ }).getAttribute('aria-checked')).toBe('false');

    await user.click(within(menu).getByRole('menuitemradio', { name: /colleague/ }));
    expect(p.onSwitch).toHaveBeenCalledWith('colleague@delpat.test');
  });

  it('Settings, Add mailbox and Sign out call their handlers; Add mailbox is hidden at three mailboxes', async () => {
    const p = menuProps();
    const user = userEvent.setup();
    const { unmount } = render(<AccountMenu {...p} />);
    for (const [name, fn] of [['Settings', p.onSettings], ['Add mailbox', p.onAdd], ['Sign out of this device', p.onSignOut]] as const) {
      await user.click(screen.getByRole('button', { name: /Account menu/ }));
      await user.click(screen.getByRole('menuitem', { name }));
      expect(fn).toHaveBeenCalledTimes(1);
    }
    unmount();
    const three = menuProps({
      accounts: ['a', 'b', 'c'].map((x, i) => ({ handle: x, email: `${x}@delpat.test`, lastActive: i }))
    });
    render(<AccountMenu {...three} email="a@delpat.test" />);
    await user.click(screen.getByRole('button', { name: /Account menu/ }));
    expect(screen.queryByRole('menuitem', { name: 'Add mailbox' })).toBeNull();
  });

  it('closes with Escape', async () => {
    const user = userEvent.setup();
    render(<AccountMenu {...menuProps()} />);
    await user.click(screen.getByRole('button', { name: /Account menu/ }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});

describe('Moving the browser settings to the server (importLocal)', () => {
  const store = (sig: object | null) => {
    if (sig) localStorage.setItem('mailloom_sig_tester@delpat.test', JSON.stringify(sig));
  };

  it('sends importLocal once when the server version is 0, with the signature, logo, templates and pictures choice', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    store({ html: `<p>Asha Rao</p><p><img src="${png}" alt="logo"></p>`, enabled: true });
    localStorage.setItem(
      'mailloom_custom_templates',
      JSON.stringify([{ id: 'custom-1', name: 'Quote', category: 'Custom', subject: 'Quote {{x}}', body: 'Hello\n\nBye', variables: [], isCustom: true }])
    );
    localStorage.setItem('mailloom_load_pictures_v1', JSON.stringify({ h1: false }));
    const server = stubServer({ version: 0, signature: { html: '', logo: null } });
    const s = await loadSettings('tester@delpat.test', 'h1');
    const patches = server.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body!.version).toBe(0);
    const imp = patches[0]!.body!.importLocal as { signature: { html: string; logo: string }; templates: { id: string; name: string; html: string }[]; loadPictures: boolean };
    expect(imp.signature.logo).toBe(png);
    expect(imp.signature.html).toBe('<p>Asha Rao</p>');
    expect(imp.templates).toHaveLength(1);
    expect(imp.templates[0]).toMatchObject({ id: 'custom-1', name: 'Quote', html: '<p>Hello</p><p>Bye</p>' });
    expect(imp.loadPictures).toBe(false);
    expect(s.version).toBe(1);
  });

  it('does not import anything when the server already has settings (version above 0)', async () => {
    store({ html: '<p>Old local</p>', enabled: true });
    const server = stubServer({ version: 3 });
    const s = await loadSettings('tester@delpat.test', 'h1');
    expect(server.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    expect(s.signature.html).toBe('<p>Asha</p>');
  });

  it('keeps going without the logo when the server refuses the import', async () => {
    store({ html: '<p>Hi</p><img src="data:image/png;base64,AAAA">', enabled: true });
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method || 'GET';
        const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        calls.push({ url, method, body });
        if (method === 'GET') return json({ ...DEFAULTS, version: 0 });
        const imp = body!.importLocal as { signature?: { logo?: string } };
        if (imp.signature && 'logo' in imp.signature) return json({ code: 'INVALID_SETTINGS', error: 'logo is too large' }, 400);
        return json({ ...DEFAULTS, version: 1 });
      })
    );
    const s = await loadSettings('tester@delpat.test', 'h1');
    expect(s.version).toBe(1);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  it('turns an old inline logo into a separate logo', () => {
    const r = splitSignatureHtml('<p>A</p><p><img src="data:image/png;base64,AAAA" alt="x"></p>');
    expect(r.logo).toBe('data:image/png;base64,AAAA');
    expect(r.html).toBe('<p>A</p>');
    expect(composeSignatureHtml(r)).toContain('<img src="data:image/png;base64,AAAA"');
    expect(composeSignatureHtml({ html: '', logo: null })).toBe('');
  });
});

describe('Load pictures automatically', () => {
  const Harness: React.FC = () => {
    const st = useAccountSettings('h1', 'tester@delpat.test');
    return (
      <SettingsPage
        {...baseProps({ section: 'general', settings: st.settings, loadError: st.loadError, onUpdate: st.update })}
      />
    );
  };

  it('is a switch; turning it off sends PATCH loadPictures and message requests stop asking for pictures', async () => {
    stubMedia(true);
    const server = stubServer({ loadPictures: true });
    const user = userEvent.setup();
    render(<Harness />);
    const sw = await screen.findByRole('switch', { name: 'Load pictures automatically' });
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByText(/senders cannot see your location or device/)).toBeTruthy();

    await api.getMessageDetail('INBOX', 1);
    expect(server.calls.at(-1)!.url).toContain('images=auto');

    await user.click(sw);
    await waitFor(() => expect(server.calls.some((c) => c.method === 'PATCH' && c.body!.loadPictures === false)).toBe(true));
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
    await api.getMessageDetail('INBOX', 1);
    expect(server.calls.at(-1)!.url).not.toContain('images=');

    await user.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    await api.getMessageDetail('INBOX', 1);
    expect(server.calls.at(-1)!.url).toContain('images=auto');
  });

  it('puts the switch back and says so when the server refuses', async () => {
    stubMedia(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit = {}) =>
        (init.method || 'GET') === 'GET' ? json(DEFAULTS) : json({ code: 'INVALID_SETTINGS', error: 'nope' }, 400)
      )
    );
    const user = userEvent.setup();
    render(<Harness />);
    const sw = await screen.findByRole('switch', { name: 'Load pictures automatically' });
    await user.click(sw);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });
});

describe('Writing', () => {
  it('lists own templates and read-only starters, copies a starter, and deletes with a confirmation', async () => {
    stubMedia(true);
    const onUpdate = vi.fn(async () => undefined);
    const requestConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <Host
        start="writing"
        props={{
          onUpdate,
          requestConfirm,
          settings: { ...DEFAULTS, templates: [{ id: 't1', name: 'Quote follow-up', subject: 'Quote', html: '<p>Hi {{name}}</p>' }] }
        }}
      />
    );
    expect(screen.getByText('Quote follow-up')).toBeTruthy();
    expect(screen.getByText('Starters')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Delete template Job Offer Letter/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Copy Job Offer Letter to my templates/ }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    const copied = (onUpdate.mock.calls[0] as unknown as [{ templates: { name: string }[] }])[0].templates;
    expect(copied).toHaveLength(2);
    expect(copied[0]!.name).toBe('Job Offer Letter');

    await user.click(screen.getByRole('button', { name: 'Delete template Quote follow-up' }));
    expect(requestConfirm).toHaveBeenCalledTimes(1);
    expect(requestConfirm.mock.calls[0]![0]).toMatchObject({ danger: true });
    expect(onUpdate).toHaveBeenCalledTimes(1); // nothing is deleted until confirmed
    requestConfirm.mock.calls[0]![0].onConfirm();
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect((onUpdate.mock.calls[1] as unknown as [{ templates: unknown[] }])[0].templates).toEqual([]);
  });

  it('saves the signature and a logo, and shows a live preview', async () => {
    stubMedia(true);
    const onUpdate = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<Host start="writing" props={{ onUpdate, settings: { ...DEFAULTS, signature: { html: '<p>Asha</p>', logo: null } } }} />);
    const preview = screen.getByRole('group', { name: 'Signature preview' });
    expect(preview.textContent).toContain('Asha');
    expect(screen.getByRole('button', { name: 'Save signature' }).hasAttribute('disabled')).toBe(true);

    const file = new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' });
    const input = screen.getByLabelText('Choose a logo picture') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(within(preview).getByRole('img')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Remove logo' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save signature' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    const arg = (onUpdate.mock.calls[0] as unknown as [{ signature: { html: string; logo: string } }])[0];
    expect(arg.signature.html).toContain('Asha');
    expect(arg.signature.logo).toMatch(/^data:image\/png;base64,/);
  });
});

describe('Accounts', () => {
  it('lists mailboxes, switches, removes with a confirmation, and signs out of this device', async () => {
    stubMedia(true);
    const props = {
      accounts: [
        { handle: 'h1', email: 'tester@delpat.test', name: 'Tester', lastActive: 2 },
        { handle: 'h2', email: 'colleague@delpat.test', lastActive: 1 }
      ],
      onSwitchAccount: vi.fn(),
      onRemoveAccount: vi.fn(),
      onSignOut: vi.fn(),
      onAddAccount: vi.fn(),
      requestConfirm: vi.fn()
    };
    const user = userEvent.setup();
    render(<Host start="accounts" props={props} />);
    await user.click(screen.getByRole('button', { name: 'Switch to colleague@delpat.test' }));
    expect(props.onSwitchAccount).toHaveBeenCalledWith('colleague@delpat.test');
    await user.click(screen.getByRole('button', { name: 'Remove colleague@delpat.test' }));
    expect(props.requestConfirm).toHaveBeenCalledTimes(1);
    expect(props.onRemoveAccount).not.toHaveBeenCalled();
    props.requestConfirm.mock.calls[0]![0].onConfirm();
    expect(props.onRemoveAccount).toHaveBeenCalledWith('colleague@delpat.test');
    await user.click(screen.getByRole('button', { name: 'Add mailbox' }));
    expect(props.onAddAccount).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sign out of this device' }));
    expect(props.onSignOut).toHaveBeenCalled();
  });
});
