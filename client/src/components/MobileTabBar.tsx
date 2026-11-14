import React from 'react';
import { Inbox, PenSquare, Search, Star, Menu } from 'lucide-react';

export type PhoneTab = 'write' | 'inbox' | 'starred' | 'search' | 'folders';

interface Props {
  active: PhoneTab | null;
  onSelect: (tab: PhoneTab) => void;
}

const ITEMS: { key: PhoneTab; label: string; Icon: typeof Inbox }[] = [
  { key: 'write', label: 'Write', Icon: PenSquare },
  { key: 'inbox', label: 'Inbox', Icon: Inbox },
  { key: 'starred', label: 'Starred', Icon: Star },
  { key: 'search', label: 'Search', Icon: Search },
  { key: 'folders', label: 'Folders', Icon: Menu }
];

/** Phone bottom bar: Write, Inbox, Starred, Search, Folders. Compose is always one tap away. */
export const MobileTabBar: React.FC<Props> = ({ active, onSelect }) => (
  <nav
    aria-label="Quick navigation"
    className="md:hidden shrink-0 grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
  >
    {ITEMS.map(({ key, label, Icon }) => {
      const on = active === key;
      return (
        <button
          key={key}
          type="button"
          onClick={() => onSelect(key)}
          aria-current={on ? 'page' : undefined}
          className={`t-fast min-h-[56px] grid justify-items-center content-center gap-[3px] text-[11px] font-bold ${
            on ? 'text-ink' : 'text-ink-3'
          }`}
        >
          <Icon className={`w-[22px] h-[22px] ${on ? 'text-act' : ''}`} strokeWidth={on ? 2.2 : 1.8} aria-hidden="true" />
          {label}
        </button>
      );
    })}
  </nav>
);
