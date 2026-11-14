import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageViewer, toolbarLevel } from '../components/MessageViewer.js';
import type { ParsedEmailMessage } from '../types.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const msg = {
  uid: 1,
  id: '<1@x>',
  subject: 'Hello',
  from: { name: 'A', address: 'a@x.test' },
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  references: [],
  date: '2026-01-01T10:00:00Z',
  flags: [],
  isSeen: true,
  isFlagged: false,
  html: '<p>hi</p>',
  text: 'hi',
  attachments: [],
  blockedImages: 0
} as unknown as ParsedEmailMessage;

/** Pretend the toolbar is `w` px wide. */
function mockToolbarWidth(w: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.getAttribute('role') === 'toolbar' ? w : 0;
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

function renderViewer() {
  return render(
    <MessageViewer
      folderPath="INBOX"
      message={msg}
      isLoading={false}
      onToggleFlag={vi.fn()}
      onDelete={vi.fn()}
      onMove={vi.fn()}
      onMarkSpam={vi.fn()}
      onReply={vi.fn()}
      onForward={vi.fn()}
      folders={[]}
    />
  );
}

/** Is the element displayed at the sm breakpoint and up? (jsdom has no CSS, so read the classes.) */
function shownFromSm(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const c = n.classList;
    if (c.contains('hidden') && !c.contains('sm:contents') && !c.contains('sm:flex') && !c.contains('sm:block') && !c.contains('sm:inline')) return false;
    if (c.contains('sm:hidden')) return false;
  }
  return true;
}

// Window width -> room the viewer gets: window minus the 256 px sidebar and the list (360 px from lg up).
const viewerWidth = (win: number) => (win >= 1024 ? win - 256 - 360 : win - 360);

describe('message toolbar', () => {
  it('picks a level from the toolbar width', () => {
    expect(toolbarLevel(0)).toBe('full');
    expect(toolbarLevel(1200)).toBe('full');
    expect(toolbarLevel(800)).toBe('full');
    expect(toolbarLevel(700)).toBe('mid');
    expect(toolbarLevel(408)).toBe('tight');
  });

  for (const win of [800, 1024, 1280]) {
    it(`at a ${win} px window the main actions stay, the rest sits under More, nothing is squeezed`, () => {
      const w = viewerWidth(win);
      mockToolbarWidth(w);
      renderViewer();
      const bar = screen.getByRole('toolbar', { name: 'Message actions' });
      for (const name of ['Reply', 'Reply all', 'Forward', 'Move to Trash', 'Move to folder', 'More actions']) {
        expect(screen.getByRole('button', { name })).toBeTruthy();
      }
      // Secondary buttons are hidden at this width (moved under More), not squeezed in.
      for (const name of ['HTML', 'Plain Text', 'Print message']) {
        expect(shownFromSm(screen.getByRole('button', { name, hidden: true }))).toBe(false);
      }
      // Every button that is shown refuses to shrink below 32 px and never wraps its text.
      for (const b of bar.querySelectorAll('button')) {
        if (!shownFromSm(b)) continue;
        expect(b.className).toMatch(/min-w-(8|\[44px\])/);
        expect(b.className).toMatch(/min-h-(8|\[44px\])/);
        expect(b.className).toMatch(/shrink-0/);
        expect(b.className).toMatch(/whitespace-nowrap/);
      }
    });
  }

  it('shows everything on a wide toolbar and no always-on More button', () => {
    mockToolbarWidth(1100);
    renderViewer();
    const more = screen.getByRole('button', { name: 'More actions' });
    expect(more.parentElement!.classList.contains('sm:hidden')).toBe(true);
    expect(shownFromSm(screen.getByRole('button', { name: 'Plain Text' }))).toBe(true);
  });
});
