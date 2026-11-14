import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const sendEmail = vi.fn();
vi.mock('../services/api.js', () => ({
  api: {
    sendEmail: (...a: unknown[]) => sendEmail(...a),
    saveDraft: vi.fn(async () => ({ success: true, uid: 1, folder: 'Drafts' })),
    deleteDraft: vi.fn(async () => ({ success: true }))
  }
}));

import { ComposerModal } from '../components/ComposerModal.js';
import { getSignatureForAccount, saveSignatureForAccount } from '../services/signatures.js';

beforeAll(() => {
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
});
beforeEach(() => {
  localStorage.clear();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true });
});
afterEach(cleanup);

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function renderComposer(extra: Partial<React.ComponentProps<typeof ComposerModal>> = {}) {
  const requestConfirm = vi.fn();
  render(
    <ComposerModal
      isOpen
      onClose={() => {}}
      onSentSuccess={() => {}}
      requestConfirm={requestConfirm}
      accountEmail="a@delpat.test"
      initialTo={['b@delpat.test']}
      {...extra}
    />
  );
  return { requestConfirm };
}

describe('composer with the rich editor', () => {
  it('puts the signature (with its logo) above the quoted original', () => {
    saveSignatureForAccount('a@delpat.test', { enabled: true, html: `<p>Rahul</p><p><img src="${PNG}" alt="Delpat logo"></p>` });
    renderComposer({ initialHtml: '<p>On Monday, Sam wrote:</p><blockquote><p>old words</p></blockquote>' });
    const html = screen.getByRole('textbox', { name: 'Message' }).innerHTML;
    const logo = html.indexOf('Delpat logo');
    const quote = html.indexOf('<blockquote');
    expect(logo).toBeGreaterThan(-1);
    expect(quote).toBeGreaterThan(logo);
    expect(html.indexOf('Rahul')).toBeLessThan(quote);
  });

  it('an old four-field signature is carried over as rich text', () => {
    localStorage.setItem(
      'mailloom_sig_a@delpat.test',
      JSON.stringify({ name: 'Rahul', designation: 'Ops', phone: '123', website: 'delpat.in', customText: '', enabled: true })
    );
    const sig = getSignatureForAccount('a@delpat.test');
    expect(sig.enabled).toBe(true);
    expect(sig.html).toBe('<p>Rahul<br>Ops<br>123 | delpat.in</p>');
  });

  it('sends rich mail as html (the picture stays in the text, no attachment files) and no separate text', async () => {
    saveSignatureForAccount('a@delpat.test', { enabled: true, html: `<p>Rahul</p><p><img src="${PNG}" alt="logo"></p>` });
    renderComposer();
    await userEvent.setup().click(screen.getByRole('button', { name: /^send/i }));
    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    const payload = sendEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.text).toBeUndefined();
    expect(String(payload.html)).toContain(`<img src="${PNG}"`);
    expect(String(payload.html)).toContain('Rahul');
    expect(payload.files).toEqual([]);
  });

  it('Plain text switch: no confirmation when there is nothing to lose, then sends text only', async () => {
    const { requestConfirm } = renderComposer();
    const u = userEvent.setup();
    await u.click(screen.getByRole('textbox', { name: 'Message' }));
    await u.keyboard('just words');
    await u.click(screen.getByRole('button', { name: 'More composer options' }));
    await u.click(screen.getByRole('menuitem', { name: 'Plain text' }));
    expect(requestConfirm).not.toHaveBeenCalled();
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.value).toBe('just words');
    await u.click(screen.getByRole('button', { name: /^send/i }));
    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    const payload = sendEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.html).toBeUndefined();
    expect(payload.text).toBe('just words');
  });

  it('Plain text switch asks first when pictures or formatting would be lost', async () => {
    saveSignatureForAccount('a@delpat.test', { enabled: true, html: `<p><img src="${PNG}" alt="logo"></p>` });
    const { requestConfirm } = renderComposer();
    const u2 = userEvent.setup();
    await u2.click(screen.getByRole('button', { name: 'More composer options' }));
    await u2.click(screen.getByRole('menuitem', { name: 'Plain text' }));
    expect(requestConfirm).toHaveBeenCalledTimes(1);
    expect(requestConfirm.mock.calls[0][0].message).toMatch(/pictures will be removed/);
    expect(screen.getByRole('textbox', { name: 'Message' }).tagName).not.toBe('TEXTAREA');
    act(() => requestConfirm.mock.calls[0][0].onConfirm());
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).tagName).toBe('TEXTAREA');
  });

  it('a plain-text draft reopens as plain text; a rich draft reopens in the editor with its picture', () => {
    renderComposer({ isDraft: true, initialBody: 'plain draft' });
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('plain draft');
    cleanup();
    renderComposer({ isDraft: true, initialBody: 'x', initialHtml: `<p>rich <strong>draft</strong></p><img src="${PNG}">` });
    const html = screen.getByRole('textbox', { name: 'Message' }).innerHTML;
    expect(html).toContain('<strong>draft</strong>');
    expect(html).toContain('data:image/png;base64');
  });

  it('refuses to send when pictures and attachments exceed the limit', async () => {
    const big = 'A'.repeat(Math.ceil((11 * 1024 * 1024 * 4) / 3));
    renderComposer({ initialHtml: `<p>x</p><img src="data:image/png;base64,${big}">` });
    await userEvent.setup().click(screen.getByRole('button', { name: /^send/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/pictures and attachments together/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('composer footer and chips', () => {
  it('recipient chips show the name and its initials, with the address on hover', () => {
    renderComposer({ initialTo: ['priya@delpat.test'], replyMeta: { names: { 'priya@delpat.test': 'Priya Shah' } } });
    const chip = screen.getByTitle('priya@delpat.test');
    expect(chip.textContent).toContain('Priya Shah');
    expect(chip.textContent).toContain('PS');
  });

  it('keeps Templates, Signature and Plain text in one menu and the bottom bar on one row', async () => {
    renderComposer();
    const send = screen.getByRole('button', { name: /^send/i });
    expect(send.parentElement!.className).toMatch(/flex-nowrap/);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'More composer options' }));
    for (const n of ['Templates', 'Signature', 'Plain text']) {
      expect(screen.getByRole('menuitem', { name: new RegExp(n) })).toBeTruthy();
    }
  });
});
