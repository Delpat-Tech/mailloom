import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectModal } from '../components/ConnectModal.js';

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
});

describe('ConnectModal', () => {
  it('is a labelled modal dialog with linked field labels and focuses the email field', () => {
    render(<ConnectModal onConnected={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Mailloom Webmail' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByLabelText(/Email Address/)).toBe(document.activeElement);
    expect(screen.getByLabelText(/Password/)).toBeTruthy();
  });

  it('focuses the password when signing in again and Escape closes only when it can', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConnectModal onConnected={vi.fn()} isAddingAccount onCancel={onCancel} reauthEmail="a@delpat.in" />);
    expect(screen.getByLabelText(/Password/)).toBe(document.activeElement);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape when it is the only way in', async () => {
    const user = userEvent.setup();
    render(<ConnectModal onConnected={vi.fn()} />);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows a plain-language error for a technical failure', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Error: connect ECONNREFUSED 127.0.0.1:993' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    render(<ConnectModal onConnected={vi.fn()} />);
    await user.type(screen.getByLabelText(/Email Address/), 'a@delpat.in');
    await user.type(screen.getByLabelText(/Password/), 'secret');
    await user.click(screen.getByRole('button', { name: /Sign In to Mailbox/ }));
    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
    expect(alert.textContent).toMatch(/mail server is having trouble/i);
  });
});
