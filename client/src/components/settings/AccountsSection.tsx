import React from 'react';
import { Check, LogOut, UserPlus, X } from 'lucide-react';
import type { StoredAccountProfile } from '../../types.js';
import type { ConfirmRequest } from '../ConfirmDialog.js';
import { avatarClass, initialsOf } from '../../services/avatar.js';
import { MAX_MAILBOXES } from '../AccountMenu.js';
import { BTN, BTN_DANGER, Card } from './ui.js';

interface Props {
  email: string;
  accounts: StoredAccountProfile[];
  onSwitch: (email: string) => void;
  onRemove: (email: string) => void;
  onAdd: () => void;
  onSignOut: () => void;
  requestConfirm: (r: ConfirmRequest) => void;
}

export const AccountsSection: React.FC<Props> = ({ email, accounts, onSwitch, onRemove, onAdd, onSignOut, requestConfirm }) => (
  <div className="space-y-6">
    <Card>
      <ul className="list-none m-0 p-0 divide-y divide-line" aria-label="Signed-in mailboxes">
        {accounts.map((a) => {
          const current = a.email.toLowerCase() === email.toLowerCase();
          return (
            <li key={a.email} className="flex items-center gap-2 py-2">
              <button
                type="button"
                disabled={current}
                aria-current={current ? 'true' : undefined}
                aria-label={current ? `${a.name || a.email}, current mailbox` : `Switch to ${a.name || a.email}`}
                onClick={() => onSwitch(a.email)}
                className="t-fast flex-1 min-w-0 min-h-[56px] flex items-center gap-3 text-left rounded hover:bg-hover disabled:hover:bg-transparent -mx-2 px-2"
              >
                <span
                  aria-hidden="true"
                  className={`cut-av w-9 h-9 grid place-items-center shrink-0 text-[13px] font-extrabold text-white ${avatarClass(a.name || a.email)}`}
                >
                  {initialsOf(a.name || a.email)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-bold text-ink truncate">{a.name || a.email}</span>
                  {a.name && <span className="block text-[13px] text-ink-3 truncate">{a.email}</span>}
                </span>
                {current ? (
                  <span className="inline-flex items-center gap-1 text-[13px] font-bold text-act shrink-0">
                    <Check className="w-4 h-4" aria-hidden="true" /> Current
                  </span>
                ) : (
                  !!a.unreadCount && (
                    <span className="text-[11px] bg-pill text-pill-ink font-bold px-1.5 rounded-[3px] shrink-0">{a.unreadCount}</span>
                  )
                )}
              </button>
              {!current && (
                <button
                  type="button"
                  aria-label={`Remove ${a.email}`}
                  title="Remove"
                  onClick={() =>
                    requestConfirm({
                      title: `Remove ${a.email}?`,
                      message:
                        'You are signed out of this mailbox on this device. Your mail is not touched, and other devices stay signed in.',
                      confirmLabel: 'Remove mailbox',
                      danger: true,
                      onConfirm: () => onRemove(a.email)
                    })
                  }
                  className="t-fast min-h-[44px] min-w-[44px] grid place-items-center rounded text-ink-3 hover:text-warn-ink hover:bg-warn-bg"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>

    <div>
      {accounts.length < MAX_MAILBOXES ? (
        <button type="button" className={BTN} onClick={onAdd}>
          <UserPlus className="w-4 h-4" aria-hidden="true" /> Add mailbox
        </button>
      ) : (
        <p className="text-[13px] text-ink-3">
          You can be signed in to {MAX_MAILBOXES} mailboxes at once. Remove one to add another.
        </p>
      )}
    </div>

    <div className="rounded border border-line bg-surface p-4 sm:p-5">
      <div className="text-[14.5px] font-bold text-ink">Sign out of this device</div>
      <p className="mt-0.5 mb-3 text-[13px] text-ink-3">
        Signs {email} out here. Other devices stay signed in. Notifications for it stop on this device.
      </p>
      <button type="button" className={BTN_DANGER} onClick={onSignOut}>
        <LogOut className="w-4 h-4" aria-hidden="true" /> Sign out of this device
      </button>
    </div>
  </div>
);
