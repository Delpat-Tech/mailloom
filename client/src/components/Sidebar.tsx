import { folderLabel } from '../services/folderName.js';
import React, { useState, useRef, useEffect } from 'react';
import {
  Inbox,
  Send,
  FileText,
  Trash2,
  AlertOctagon,
  Archive,
  Star,
  Folder,
  PenSquare,
  LogOut,
  ChevronUp,
  UserPlus,
  Check,
  X,
  Download,
  Bell,
  BellRing,
  KeyRound,
  Clock,
  RefreshCw,
  Settings2
} from 'lucide-react';
import type { MailboxFolder, UserAccount, StoredAccountProfile } from '../types.js';
import { Logo } from './Logo.js';
import { ThemePicker } from './ThemePicker.js';
import { PicturesSetting } from './PicturesSetting.js';
import { TagSwatch } from './LabelChip.js';
import type { Label } from '../services/labels.js';
import { STARRED_PATH, SNOOZED_PATH, labelPath } from '../services/views.js';
import { clockTime } from '../services/time.js';
import { KeyHint } from './KeyHint.js';

interface SidebarProps {
  account: UserAccount;
  folders: MailboxFolder[];
  selectedFolder: string;
  onSelectFolder: (path: string) => void;
  onOpenComposer: () => void;
  onLogout: () => void;
  savedAccounts?: StoredAccountProfile[];
  onSwitchAccount?: (email: string) => void;
  onAddAccount?: () => void;
  onRemoveAccount?: (email: string) => void;
  canInstall?: boolean;
  onInstallApp?: () => void;
  notificationPermission?: NotificationPermission;
  onRequestNotifications?: () => void;
  onCloseMobileSidebar?: () => void;
  onOpenConnections?: () => void;
  /** "Load pictures automatically" was changed: open messages are fetched again. */
  onPicturesChange?: (on: boolean) => void;
  /** Opens notification settings (push while closed). Replaces the plain permission button. */
  onOpenNotifications?: () => void;
  /** Labels with counts, shown under the folders. */
  labels?: Label[];
  onManageLabels?: () => void;
  /** When the folder list and messages were last refreshed. */
  syncedAt?: Date | null;
}

const KIND_ORDER = ['Inbox', 'Drafts', 'Sent', 'Archive', 'Junk', 'Trash'];

/** Special folders first in a fixed order, the rest alphabetical; children follow their parent. */
export function orderFolders(folders: MailboxFolder[]): MailboxFolder[] {
  const rank = (f: MailboxFolder) => {
    const i = f.specialUse ? KIND_ORDER.indexOf(f.specialUse) : -1;
    return i === -1 ? KIND_ORDER.length : i;
  };
  const byParent = new Map<string, MailboxFolder[]>();
  const paths = new Set(folders.map((f) => f.path));
  for (const f of folders) {
    const key = f.parentPath && paths.has(f.parentPath) ? f.parentPath : '';
    byParent.set(key, [...(byParent.get(key) || []), f]);
  }
  const out: MailboxFolder[] = [];
  const walk = (key: string) => {
    const kids = (byParent.get(key) || []).slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    for (const k of kids) {
      out.push(k);
      walk(k.path);
    }
  };
  walk('');
  return out;
}

const ViewButton: React.FC<{
  path: string;
  label: string;
  icon: React.ReactNode;
  selected: string;
  onSelect: (path: string) => void;
  count?: number;
}> = ({ path, label, icon, selected, onSelect, count }) => {
  const on = selected === path;
  return (
    <button
      type="button"
      onClick={() => onSelect(path)}
      aria-current={on ? 'page' : undefined}
      className={`t-fast w-full flex items-center gap-3 pl-3 pr-3 min-h-[44px] lg:min-h-[36px] rounded text-sm ${
        on ? 'bg-rail-on text-rail-on-ink font-extrabold' : 'font-semibold hover:bg-rail-hi hover:text-rail-hov-ink'
      }`}
    >
      {icon}
      <span className="truncate flex-1 text-left">{label}</span>
      {!!count && <span className="text-xs tabular-nums font-bold">{count}</span>}
    </button>
  );
};

/** The number beside a folder: unread, except Drafts (how many drafts there are). */
export function folderCount(folder: Pick<MailboxFolder, 'specialUse' | 'unreadCount' | 'totalCount'>): number {
  return folder.specialUse === 'Drafts' ? folder.totalCount : folder.unreadCount;
}

/** What a screen reader says for a folder: the same number as on screen, with the right word. */
export function folderAria(folder: Pick<MailboxFolder, 'name' | 'specialUse' | 'unreadCount' | 'totalCount'>): string {
  const name = folderLabel(folder);
  const n = folderCount(folder);
  if (n <= 0) return name;
  return folder.specialUse === 'Drafts' ? `${name}, ${n} ${n === 1 ? 'draft' : 'drafts'}` : `${name}, ${n} unread`;
}

export const labelUnread = (l: { unread?: number; count: number }): number => l.unread ?? l.count;

const UTILITY =
  'w-full flex items-center gap-3 px-3 min-h-[44px] lg:min-h-[32px] rounded text-[13.5px] font-semibold hover:bg-rail-hi hover:text-rail-hov-ink transition-colors';

export const Sidebar: React.FC<SidebarProps> = ({
  account,
  folders,
  selectedFolder,
  onSelectFolder,
  onOpenComposer,
  onLogout,
  savedAccounts = [],
  onSwitchAccount,
  onAddAccount,
  onRemoveAccount,
  canInstall = false,
  onInstallApp,
  notificationPermission = 'default',
  onRequestNotifications,
  onCloseMobileSidebar,
  onOpenConnections,
  onPicturesChange,
  onOpenNotifications,
  labels = [],
  onManageLabels,
  syncedAt
}) => {
  const [showAccountSwitcher, setShowAccountSwitcher] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setShowAccountSwitcher(false);
      }
    };
    if (showAccountSwitcher) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showAccountSwitcher]);

  const orderedFolders = orderFolders(folders);

  // The folders and labels scroll on their own, between Write and the footer. A fade (not a hard cut)
  // shows at an edge only when there is more to scroll to on that side.
  const navRef = useRef<HTMLElement>(null);
  const [fade, setFade] = useState({ top: 0, bottom: 0 });
  const measureFade = React.useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    const top = el.scrollTop > 2 ? 18 : 0;
    const bottom = el.scrollHeight - el.clientHeight - el.scrollTop > 2 ? 24 : 0;
    setFade((f) => (f.top === top && f.bottom === bottom ? f : { top, bottom }));
  }, []);
  useEffect(() => {
    measureFade();
    const el = navRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measureFade);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measureFade, folders.length, labels.length]);

  const getFolderIcon = (f: MailboxFolder) => {
    switch (f.specialUse) {
      case 'Inbox':
        return <Inbox className="w-4 h-4 shrink-0" />;
      case 'Sent':
        return <Send className="w-4 h-4 shrink-0" />;
      case 'Drafts':
        return <FileText className="w-4 h-4 shrink-0" />;
      case 'Trash':
        return <Trash2 className="w-4 h-4 shrink-0" />;
      case 'Junk':
        return <AlertOctagon className="w-4 h-4 shrink-0" />;
      case 'Archive':
        return <Archive className="w-4 h-4 shrink-0" />;
      default:
        if (f.name.toLowerCase() === 'starred') return <Star className="w-4 h-4 shrink-0" />;
        return <Folder className="w-4 h-4 shrink-0" />;
    }
  };

  return (
    <div className="w-56 bg-rail text-rail-2 flex flex-col h-full min-h-0 overflow-hidden select-none lg:cut-rail pb-[env(safe-area-inset-bottom)]">
      {/* App branding */}
      <div className="pl-5 pr-3 pt-5 flex items-center justify-between min-h-[44px] shrink-0">
        <div className="flex items-center gap-2.5 font-extrabold text-rail-ink text-[19px] tracking-tight leading-none">
          <Logo className="shrink-0" />
          Mailloom
          {account.isDemo && (
            <span className="text-[11px] font-bold bg-pill text-pill-ink px-1.5 py-0.5 rounded-[3px]">Demo</span>
          )}
        </div>
        {onCloseMobileSidebar && (
          <button
            type="button"
            onClick={onCloseMobileSidebar}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-rail-2 hover:text-rail-hov-ink hover:bg-rail-hi rounded transition-colors lg:hidden"
            title="Close folders"
            aria-label="Close folders"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Primary compose action */}
      <div className="mx-4 mt-6 mb-5 shrink-0 [@media(max-height:800px)]:mt-4 [@media(max-height:800px)]:mb-3">
        <button
          onClick={onOpenComposer}
          aria-keyshortcuts="C"
          className="w-full cut-tr flex items-center gap-2 bg-wr-bg hover:bg-wr-hov text-wr-ink font-extrabold text-[14.5px] pl-3.5 pr-3 min-h-[44px] transition-colors"
        >
          <PenSquare className="w-4 h-4" strokeWidth={2.2} aria-hidden="true" />
          <span>Write</span>
          <KeyHint keys="C" className="ml-auto !border-current !bg-transparent !text-inherit opacity-85" />
        </button>
      </div>

      {/* Folders navigation */}
      <nav
        ref={navRef}
        aria-label="Folders"
        onScroll={measureFade}
        style={{ ["--fade-top" as string]: `${fade.top}px`, ["--fade-bottom" as string]: `${fade.bottom}px` }}
        className="rail-scroll flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 pb-3 space-y-px"
      >
        {orderedFolders
          .filter((f) => f.name.toLowerCase() !== 'snoozed')
          .map((folder) => {
          const isSelected = selectedFolder.toLowerCase() === folder.path.toLowerCase();
          return (
            <React.Fragment key={folder.path}>
            <button
              onClick={() => onSelectFolder(folder.path)}
              style={{ paddingLeft: `${0.75 + (folder.depth || 0) * 1}rem` }}
              title={folder.path}
              aria-current={isSelected ? 'page' : undefined}
              aria-label={folderAria(folder)}
              className={`w-full flex items-center justify-between pr-3 min-h-[44px] lg:min-h-[36px] rounded text-sm transition-colors ${
                isSelected
                  ? 'bg-rail-on text-rail-on-ink font-extrabold'
                  : 'font-semibold hover:bg-rail-hi hover:text-rail-hov-ink'
              }`}
            >
              <div className="flex items-center gap-3 truncate">
                {getFolderIcon(folder)}
                <span className="truncate">{folderLabel(folder)}</span>
              </div>
              {(() => {
                // Unread everywhere; Drafts shows how many drafts there are (read and unread mean nothing there).
                const n = folderCount(folder);
                return n > 0 ? (
                  <span
                    className={`text-xs tabular-nums font-bold ${
                      isSelected && folder.unreadCount > 0 ? 'bg-pill text-pill-ink px-[7px] py-px rounded-[3px]' : ''
                    }`}
                  >
                    {n}
                  </span>
                ) : null;
              })()}
            </button>
            {folder.specialUse === 'Inbox' && (
              <>
                <ViewButton path={STARRED_PATH} label="Starred" icon={<Star className="w-4 h-4 shrink-0" />} selected={selectedFolder} onSelect={onSelectFolder} />
                <ViewButton path={SNOOZED_PATH} label="Snoozed" icon={<Clock className="w-4 h-4 shrink-0" />} selected={selectedFolder} onSelect={onSelectFolder} />
              </>
            )}
            </React.Fragment>
          );
        })}

        {(labels.length > 0 || onManageLabels) && (
          <div className="pt-3">
            <div className="flex items-center justify-between pl-5 pr-1 pb-1">
              <h2 className="text-xs font-bold text-rail-2">Labels</h2>
              {onManageLabels && (
                <button
                  type="button"
                  onClick={onManageLabels}
                  aria-label="Manage labels"
                  title="Manage labels"
                  className="t-fast min-h-[44px] min-w-[44px] lg:min-h-[28px] lg:min-w-[28px] grid place-items-center rounded hover:bg-rail-hi hover:text-rail-hov-ink"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {labels.map((l) => {
              const path = labelPath(l.id);
              const on = selectedFolder === path;
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => onSelectFolder(path)}
                  aria-current={on ? 'page' : undefined}
                  aria-label={labelUnread(l) > 0 ? `Label ${l.name}, ${labelUnread(l)} unread` : `Label ${l.name}`}
                  className={`t-fast w-full flex items-center justify-between pl-3 pr-3 min-h-[44px] lg:min-h-[32px] rounded text-[13.5px] ${
                    on ? 'bg-rail-on text-rail-on-ink font-extrabold' : 'font-semibold hover:bg-rail-hi hover:text-rail-hov-ink'
                  }`}
                >
                  <span className="flex items-center gap-3 truncate">
                    <TagSwatch colour={l.colour} />
                    <span className="truncate">{l.name}</span>
                  </span>
                  {labelUnread(l) > 0 && <span className="text-xs font-bold tabular-nums">{labelUnread(l)}</span>}
                </button>
              );
            })}
          </div>
        )}
      </nav>

      {/* App utilities: install and notifications */}
      <div className="px-2 py-2 space-y-px shrink-0">
        {canInstall && onInstallApp && (
          <button type="button" onClick={onInstallApp} aria-label="Install desktop app" className={`${UTILITY} [@media(max-height:780px)]:hidden`}>
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>Install desktop app</span>
          </button>
        )}

        {onOpenNotifications && !account.isDemo ? (
          <button type="button" onClick={onOpenNotifications} className={UTILITY}>
            {notificationPermission === 'granted' ? (
              <BellRing className="w-4 h-4 text-rail-ok" aria-hidden="true" />
            ) : (
              <Bell className="w-4 h-4" aria-hidden="true" />
            )}
            <span>Notifications</span>
          </button>
        ) : onRequestNotifications && notificationPermission !== 'granted' ? (
          <button type="button" onClick={onRequestNotifications} aria-label="Allow notifications" className={UTILITY}>
            <Bell className="w-4 h-4" aria-hidden="true" />
            <span>Allow notifications</span>
          </button>
        ) : (
          <div className="flex items-center gap-3 px-3 min-h-[32px] text-[13px]">
            <BellRing className="w-4 h-4 text-rail-ok" aria-hidden="true" />
            <span>Notifications on</span>
          </div>
        )}
      </div>

      {/* Account block and multi-account switcher */}
      <div className="px-5 pt-3.5 pb-4 border-t border-rail-line relative shrink-0" ref={accountMenuRef}>
        {showAccountSwitcher && (
          <div
            role="group"
            aria-label="Connected accounts"
            className="absolute bottom-full left-3 right-3 mb-2 bg-surface text-ink border border-line rounded shadow-xl p-2 z-50 flex flex-col gap-1"
          >
            <div className="px-2.5 py-1.5 text-xs font-bold text-ink-3 border-b border-line flex items-center justify-between">
              <span>Connected accounts</span>
              <span>{savedAccounts.length} / 3</span>
            </div>

            <div className="max-h-48 overflow-y-auto space-y-0.5 py-1">
              {savedAccounts.map((savedAcc) => {
                const isActive = savedAcc.email.toLowerCase() === account.email.toLowerCase();
                return (
                  <div
                    key={savedAcc.email}
                    className={`flex items-center justify-between rounded text-xs transition-colors ${
                      isActive ? 'bg-sel text-sel-ink' : 'text-ink-2 hover:bg-hover'
                    }`}
                  >
                    <button
                      type="button"
                      aria-current={isActive ? 'true' : undefined}
                      aria-label={`${isActive ? 'Current account' : 'Switch to'} ${savedAcc.name || savedAcc.email}, ${savedAcc.email}${
                        savedAcc.unreadCount ? `, ${savedAcc.unreadCount} unread` : ''
                      }`}
                      onClick={() => {
                        if (!isActive && onSwitchAccount) {
                          onSwitchAccount(savedAcc.email);
                          setShowAccountSwitcher(false);
                        }
                      }}
                      className="flex-1 min-w-0 min-h-[44px] flex items-center gap-2 px-2.5 py-2 text-left"
                    >
                      <div className="w-7 h-7 cut-av bg-av1 text-white text-[11px] font-extrabold flex items-center justify-center shrink-0">
                        {(savedAcc.name || savedAcc.email).charAt(0).toUpperCase()}
                      </div>
                      <div className="truncate text-left">
                        <div className="font-bold truncate">{savedAcc.name || savedAcc.email}</div>
                        <div className="text-[11px] text-ink-3 truncate">{savedAcc.email}</div>
                      </div>
                    </button>

                    <div className="flex items-center gap-1.5 shrink-0 mr-1">
                      {savedAcc.unreadCount && savedAcc.unreadCount > 0 ? (
                        <span className="text-[11px] bg-pill text-pill-ink font-bold px-1.5 rounded-[3px]">
                          {savedAcc.unreadCount}
                        </span>
                      ) : null}
                      {isActive ? (
                        <Check className="w-3.5 h-3.5 text-act mr-1.5" aria-hidden="true" />
                      ) : (
                        onRemoveAccount && (
                          <button
                            type="button"
                            onClick={() => onRemoveAccount(savedAcc.email)}
                            className="min-h-[44px] min-w-[44px] flex items-center justify-center hover:text-warn-ink hover:bg-warn-bg rounded transition-colors text-ink-3"
                            title="Remove account"
                            aria-label={`Remove account ${savedAcc.email}`}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <ThemePicker />
            <PicturesSetting handle={account.handle} onChange={onPicturesChange} />

            {/* Actions */}
            <div className="border-t border-line pt-1 flex flex-col gap-0.5">
              {onAddAccount && savedAccounts.length < 3 && (
                <button
                  type="button"
                  onClick={() => {
                    setShowAccountSwitcher(false);
                    onAddAccount();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 min-h-[44px] rounded text-xs text-act hover:bg-hover font-bold transition-colors"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  <span>Add Another Mailbox</span>
                </button>
              )}
              {onOpenConnections && !account.isDemo && (
                <button
                  type="button"
                  onClick={() => {
                    setShowAccountSwitcher(false);
                    onOpenConnections();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 min-h-[44px] rounded text-xs text-ink-2 hover:bg-hover font-semibold transition-colors"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>Connections</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowAccountSwitcher(false);
                  onLogout();
                }}
                className="w-full flex items-center gap-2 px-2.5 min-h-[44px] rounded text-xs text-warn-ink hover:bg-warn-bg font-semibold transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Disconnect Active Account</span>
              </button>
            </div>
          </div>
        )}

        {syncedAt && (
          <div className="flex items-center gap-2 text-xs mb-3" role="status">
            <RefreshCw className="w-4 h-4 text-rail-ok shrink-0" aria-hidden="true" />
            <span>Synced at {clockTime(syncedAt)}</span>
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowAccountSwitcher(!showAccountSwitcher)}
          aria-expanded={showAccountSwitcher}
          aria-label={`Accounts. Signed in as ${account.email}`}
          className="w-full min-h-[44px] flex items-center justify-between rounded hover:bg-rail-hi transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2.5 truncate">
            <div className="w-8 h-8 cut-av bg-unread text-pill-ink text-[13px] font-extrabold flex items-center justify-center shrink-0">
              {(account.name || account.email).charAt(0).toUpperCase()}
            </div>
            <div className="truncate text-left">
              <div className="text-[13px] font-bold text-rail-ink truncate">{account.name || account.email}</div>
              <div className="text-xs truncate">{account.email}</div>
            </div>
          </div>
          <ChevronUp className={`w-4 h-4 shrink-0 transition-transform ${showAccountSwitcher ? 'rotate-180' : ''}`} />
        </button>
      </div>
    </div>
  );
};
