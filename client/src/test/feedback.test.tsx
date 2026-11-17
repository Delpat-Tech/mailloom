import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FeedbackSheet } from '../components/FeedbackSheet.js';
import { AccountMenu } from '../components/AccountMenu.js';
import { AppSection } from '../components/settings/AppSection.js';
import { setActiveHandle } from '../services/api.js';
import { clearClientErrors, recordClientError, recentClientErrors } from '../services/feedback.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  setActiveHandle('h1');
  clearClientErrors();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Report a problem form', () => {
  it('needs "What happened?" before it sends anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<FeedbackSheet view="Inbox" onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    expect(screen.getByRole('alert').textContent).toMatch(/what happened/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('labels its fields and lists exactly what the technical details contain', async () => {
    recordClientError('Could not load messages');
    const user = userEvent.setup();
    render(<FeedbackSheet view="Inbox" onClose={() => {}} />);
    expect(screen.getByLabelText(/What happened/)).toBeTruthy();
    expect(screen.getByLabelText(/What did you expect/)).toBeTruthy();
    expect(screen.queryByLabelText(/screenshot/i)).toBeNull();
    const box = screen.getByRole('checkbox', { name: /Include technical details/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await user.click(screen.getByText('What is sent'));
    const text = document.querySelector('dl')!.textContent || '';
    for (const label of ['App version', 'Browser and system', 'Screen', 'Opened as', 'Current view: Inbox', 'Time', 'Recent errors: Could not load messages']) {
      expect(text).toContain(label);
    }
  });

  it('sends the report with details, then thanks the person', async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, body: init.body as string });
      return json({ success: true });
    }));
    const user = userEvent.setup();
    render(<FeedbackSheet view="Inbox" onClose={() => {}} />);
    await user.type(screen.getByLabelText(/What happened/), 'The list is empty');
    await user.type(screen.getByLabelText(/What did you expect/), 'My mail');
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/the Mailloom team has it/));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/feedback$/);
    expect(calls[0]!.method).toBe('POST');
    const payload = JSON.parse(calls[0]!.body);
    expect(payload.what).toBe('The list is empty');
    expect(payload.expected).toBe('My mail');
    expect(payload.details.view).toBe('Inbox');
    expect(payload).not.toHaveProperty('to');
  });

  it('leaves the details out when the box is off', async () => {
    let body: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      body = init.body as string;
      return json({ success: true });
    }));
    const user = userEvent.setup();
    render(<FeedbackSheet view="Inbox" onClose={() => {}} />);
    await user.type(screen.getByLabelText(/What happened/), 'Broken');
    await user.click(screen.getByRole('checkbox', { name: /Include technical details/ }));
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(body).toBeTruthy());
    expect(JSON.parse(body!)).not.toHaveProperty('details');
  });

  it('shows a refusal from the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'You have sent 5 reports in the last hour. Try again in about 10 minutes.' }, 429)));
    const user = userEvent.setup();
    render(<FeedbackSheet view="Inbox" onClose={() => {}} />);
    await user.type(screen.getByLabelText(/What happened/), 'x');
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/5 reports in the last hour/));
  });

  it('closes on Escape and the Cancel button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<FeedbackSheet view="Inbox" onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('entry points', () => {
  const menuProps = (over = {}) => ({
    label: 'Tester',
    email: 'tester@delpat.test',
    accounts: [{ handle: 'h1', email: 'tester@delpat.test', name: 'Tester', lastActive: 2 }],
    onSwitch: vi.fn(),
    onAdd: vi.fn(),
    onSettings: vi.fn(),
    onSignOut: vi.fn(),
    ...over
  });

  it('the avatar menu shows "Report a problem" only when it is switched on', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AccountMenu {...menuProps()} />);
    await user.click(screen.getByRole('button', { name: /Account menu/ }));
    expect(screen.queryByRole('menuitem', { name: /Report a problem/ })).toBeNull();
    unmount();

    const onFeedback = vi.fn();
    render(<AccountMenu {...menuProps({ onFeedback })} />);
    await user.click(screen.getByRole('button', { name: /Account menu/ }));
    const menu = screen.getByRole('menu', { name: 'Account menu' });
    const items = Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((i) => i.textContent?.trim());
    expect(items.indexOf('Report a problem')).toBe(items.indexOf('Settings') + 1);
    await user.click(within(menu).getByRole('menuitem', { name: /Report a problem/ }));
    expect(onFeedback).toHaveBeenCalled();
  });

  it('Settings > App shows the row only when it is switched on', () => {
    const { unmount } = render(<AppSection onOpenShortcuts={() => {}} />);
    expect(screen.queryByRole('button', { name: /Report a problem/ })).toBeNull();
    unmount();
    const onReport = vi.fn();
    render(<AppSection onOpenShortcuts={() => {}} onReport={onReport} />);
    fireEvent.click(screen.getByRole('button', { name: /Report a problem/ }));
    expect(onReport).toHaveBeenCalled();
  });

  it('keeps only the last five error messages', () => {
    for (let i = 1; i <= 7; i++) recordClientError(`error ${i}`);
    expect(recentClientErrors()).toEqual(['error 3', 'error 4', 'error 5', 'error 6', 'error 7']);
  });
});
