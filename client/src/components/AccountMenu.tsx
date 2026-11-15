import React, { useRef, useState } from 'react';
import { Check, LogOut, Settings, UserPlus } from 'lucide-react';
import { usePopover } from '../hooks/usePopover.js';
import { AnchoredPanel } from './AnchoredPanel.js';
import { Presence } from './Presence.js';
import { avatarClass, initialsOf } from '../services/avatar.js';
import type { StoredAccountProfile } from '../types.js';

export const MAX_MAILBOXES = 3;

export interface AccountMenuProps {
  /** Name (or address) of the signed-in mailbox, used for the avatar. */
  label: string;
  email: string;
  accounts: StoredAccountProfile[];
  onSwitch: (email: string) => void;
  onAdd: () => void;
  onSettings: () => void;
  onSignOut: () => void;
}

const ITEM =
  't-fast w-full min-h-[44px] px-3 flex items-center gap-3 text-left text-[14px] font-semibold text-ink-2 hover:bg-sel hover:text-sel-ink';

const Menu: React.FC<AccountMenuProps & { anchor: React.RefObject<HTMLElement>; onClose: (refocus: boolean) => void }> = ({
  email,
  accounts,
  onSwitch,
  onAdd,
  onSettings,
  onSignOut,
  anchor,
  onClose
}) => {
  const ref = useRef<HTMLDivElement>(null);
  usePopover(ref, onClose, anchor);
  const pick = (fn: () => void) => () => {
    onClose(false);
    fn();
  };
  return (
    <AnchoredPanel
      panelRef={ref}
      anchor={anchor}
      role="menu"
      aria-label="Account menu"
      className="anim-menu origin-tr w-72 max-w-[calc(100vw-1rem)] bg-surface text-ink border border-line rounded shadow-xl py-1.5 z-[80]"
    >
      <div className="px-3 pt-1 pb-1 text-xs font-bold text-ink-3">Mailboxes</div>
      {accounts.map((a) => {
        const current = a.email.toLowerCase() === email.toLowerCase();
        return (
          <button
            key={a.email}
            type="button"
            role="menuitemradio"
            aria-checked={current}
            onClick={pick(() => !current && onSwitch(a.email))}
            className={ITEM}
          >
            <span
              aria-hidden="true"
              className={`cut-av w-7 h-7 grid place-items-center shrink-0 text-[11px] font-extrabold text-white ${avatarClass(a.name || a.email)}`}
            >
              {initialsOf(a.name || a.email)}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate ${current ? 'font-extrabold text-ink' : ''}`}>{a.name || a.email}</span>
              {a.name && <span className="block truncate text-xs font-medium text-ink-3">{a.email}</span>}
            </span>
            {!current && !!a.unreadCount && (
              <span className="text-[11px] bg-pill text-pill-ink font-bold px-1.5 rounded-[3px]">{a.unreadCount}</span>
            )}
            {current && <Check className="w-4 h-4 text-act shrink-0" aria-hidden="true" />}
          </button>
        );
      })}
      <div className="my-1.5 border-t border-line" role="separator" />
      {accounts.length < MAX_MAILBOXES && (
        <button type="button" role="menuitem" onClick={pick(onAdd)} className={ITEM}>
          <UserPlus className="w-4 h-4 shrink-0" aria-hidden="true" />
          Add mailbox
        </button>
      )}
      <button type="button" role="menuitem" onClick={pick(onSettings)} className={ITEM}>
        <Settings className="w-4 h-4 shrink-0" aria-hidden="true" />
        Settings
      </button>
      <button type="button" role="menuitem" onClick={pick(onSignOut)} className={ITEM}>
        <LogOut className="w-4 h-4 shrink-0" aria-hidden="true" />
        Sign out of this device
      </button>
    </AnchoredPanel>
  );
};

/** The avatar at the top right: one small menu for switching mailbox, adding one, Settings and signing out. */
export const AccountMenu: React.FC<AccountMenuProps & { touchClass?: string }> = ({ touchClass = '', ...props }) => {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu. Signed in as ${props.email}`}
        title="Account"
        className={touchClass}
      >
        <span
          aria-hidden="true"
          className={`cut-av w-8 h-8 grid place-items-center text-[12px] font-extrabold text-white ${avatarClass(props.label || 'me')}`}
        >
          {initialsOf(props.label || '?')}
        </span>
      </button>
      <Presence show={open}>
        {open && (
          <Menu
            {...props}
            anchor={btn}
            onClose={(refocus) => {
              setOpen(false);
              if (refocus) btn.current?.focus();
            }}
          />
        )}
      </Presence>
    </>
  );
};
