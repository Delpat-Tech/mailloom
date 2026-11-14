import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PasswordInput } from '../components/PasswordInput.js';
import { ConnectModal } from '../components/ConnectModal.js';
import {
  pullOffset,
  pullReaches,
  isDownwardPull,
  PULL_THRESHOLD,
  PULL_MAX
} from '../hooks/usePullToRefresh.js';

afterEach(cleanup);

describe('PasswordInput', () => {
  it('toggles type and label, without submitting', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <label htmlFor="p">Pw</label>
        <PasswordInput id="p" defaultValue="secret" />
      </form>
    );
    const input = screen.getByLabelText('Pw') as HTMLInputElement;
    const btn = screen.getByRole('button', { name: 'Show password' });
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(input.type).toBe('password');
    await user.click(btn);
    expect(input.type).toBe('text');
    const hide = screen.getByRole('button', { name: 'Hide password' });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(input);
    await user.click(hide);
    expect(input.type).toBe('password');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is reachable and operable by keyboard', async () => {
    const user = userEvent.setup();
    render(<PasswordInput aria-label="Pw" />);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show password' }));
    await user.keyboard('{Enter}');
    expect((screen.getByLabelText('Pw') as HTMLInputElement).type).toBe('text');
  });

  it('hides again when resetSignal changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PasswordInput aria-label="Pw" resetSignal={0} />);
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    rerender(<PasswordInput aria-label="Pw" resetSignal={1} />);
    expect((screen.getByLabelText('Pw') as HTMLInputElement).type).toBe('password');
  });

  it('sign-in form has the toggle and the alert sits inside the form', () => {
    render(<ConnectModal onConnected={vi.fn()} reauthEmail="a@delpat.in" />);
    expect(screen.getByRole('button', { name: 'Show password' })).toBeTruthy();
    expect(screen.getByRole('alert').closest('form')).toBeTruthy();
  });
});

describe('pull-to-refresh logic', () => {
  it('rubber-bands and caps the offset', () => {
    expect(pullOffset(-5)).toBe(0);
    expect(pullOffset(40)).toBeLessThan(40);
    expect(pullOffset(1000)).toBeLessThanOrEqual(PULL_MAX);
    expect(pullOffset(200)).toBeGreaterThan(pullOffset(100));
  });
  it('triggers only past the threshold', () => {
    expect(pullReaches(PULL_THRESHOLD)).toBe(false);
    expect(pullReaches(PULL_THRESHOLD * 1.6)).toBe(true);
  });
  it('reads sideways and upward moves as not a pull', () => {
    expect(isDownwardPull(2, 20)).toBe(true);
    expect(isDownwardPull(30, 12)).toBe(false);
    expect(isDownwardPull(0, -20)).toBe(false);
    expect(isDownwardPull(0, 3)).toBe(false);
  });
});
