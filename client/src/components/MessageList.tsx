import { Presence } from './Presence.js';
import React, { useState, useRef, useLayoutEffect, useEffect, useMemo } from 'react';
import {
  Search,
  RotateCw,
  Star,
  Paperclip,
  Check,
  X,
  Trash2,
  Mail,
  MailOpen,
  Inbox,
  SlidersHorizontal,
  ShieldAlert,
  ShieldCheck,
  Undo2,
  PenSquare,
  Pencil,
  Archive,
  Clock,
  AlertTriangle
} from 'lucide-react';
import { rowTime, untilText, dayBucket, groupHeader } from '../services/time.js';
import { avatarClass, initialsOf } from '../services/avatar.js';
import type { MessageHeader, SpecialUseFolder } from '../types.js';
import type { SearchFilterParams, ListFilter } from '../services/api.js';
import type { Label } from '../services/labels.js';
import { LabelChip } from './LabelChip.js';
import { SnoozeMenu } from './SnoozeMenu.js';
import { SkeletonRows, useAfterDelay } from './Skeleton.js';

interface MessageListProps {
  folderName: string;
  messages: MessageHeader[];
  totalMessages: number;
  selectedUid: number | null;
  onSelectMessage: (uid: number) => void;
  selectedUids: Set<number>;
  onToggleSelectUid: (uid: number, e?: { shiftKey?: boolean; stopPropagation?: () => void }) => void;
  onSelectAll: () => void;
  onToggleFlag: (uid: number, flag: 'isSeen' | 'isFlagged', e?: React.MouseEvent) => void;
  onRefresh: () => void;
  isLoading: boolean;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  filters?: SearchFilterParams;
  onFiltersChange?: (filters: SearchFilterParams) => void;
  onBatchDelete: () => void;
  onBatchMarkRead: (isSeen: boolean) => void;
  onBatchSpam?: () => void;
  /** Trash: move the selected messages back to the Inbox. */
  onBatchRestore?: () => void;
  /** Junk: move the selected messages back to the Inbox. */
  onBatchNotSpam?: () => void;
  /** Start a new message (floating button on small screens). */
  onCompose?: () => void;
  /** False while the list is hidden behind the message on a phone; its scroll position is kept. */
  isVisible?: boolean;
  /** More messages exist than are shown: the list loads the next ones as you scroll. */
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  /** Phone: the account avatar in the top bar opens the folder drawer. */
  onOpenMobileSidebar?: () => void;
  accountLabel?: string;
  onClearSelection?: () => void;
  /** Set in views that span folders (Starred, Snoozed, a label), for the empty message. */
  viewKind?: 'starred' | 'snoozed' | 'label';
  /** False until the first answer for this folder: no count and no "empty" message yet. */
  countReady?: boolean;
  folderKind?: SpecialUseFolder;
  /** Empty Trash / Junk (the caller asks for confirmation). */
  onEmptyFolder?: () => void;
  /** Filter tabs (hidden in views that span folders). */
  filter?: ListFilter;
  onFilterChange?: (f: ListFilter) => void;
  /** Unread count shown on the Unread tab. */
  unreadCount?: number;
  labels?: Label[];
  /** Rows that are leaving (archive, delete, snooze, move): they fade and collapse. */
  leavingUids?: Set<number>;
  onArchive?: (uid: number, mailbox?: string) => void;
  onSnooze?: (uid: number, until: Date, mailbox?: string) => void;
}

const TOUCH = 'min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center';

/** What an empty list says: why it is empty and what would appear there. */
export function emptyState(o: {
  searchTerm?: string;
  hasFilters?: boolean;
  filter?: ListFilter;
  folderKind?: SpecialUseFolder;
  viewKind?: 'starred' | 'snoozed' | 'label';
  folderName: string;
}): { title: string; hint: string; action?: 'clear-search' | 'clear-filters' } {
  const q = (o.searchTerm || '').trim();
  if (q) return { title: `No mail matches "${q.length > 40 ? q.slice(0, 39) + '…' : q}"`, hint: 'Check the spelling, or try fewer words.', action: 'clear-search' };
  if (o.hasFilters) return { title: 'No mail matches these filters', hint: 'Try widening the dates or removing a filter.', action: 'clear-filters' };
  if (o.viewKind === 'starred') return { title: 'Nothing starred yet', hint: 'Star a message and it will appear here.' };
  if (o.viewKind === 'snoozed') return { title: 'Nothing snoozed', hint: 'Mail you snooze waits here and comes back to your inbox at the time you pick.' };
  if (o.viewKind === 'label') return { title: `No mail labelled "${o.folderName}"`, hint: 'Apply this label to a message and it will appear here.' };
  if (o.filter === 'unread') return { title: 'No unread mail', hint: 'Mail you have not read yet will appear here.' };
  if (o.filter === 'starred') return { title: 'No starred mail here', hint: 'Starred messages in this folder will appear here.' };
  if (o.filter === 'attachments') return { title: 'No mail with files here', hint: 'Messages that have attachments will appear here.' };
  switch (o.folderKind) {
    case 'Inbox': return { title: 'Your inbox is empty', hint: 'New mail will appear here.' };
    case 'Sent': return { title: 'No sent mail', hint: 'Mail you send will appear here.' };
    case 'Drafts': return { title: 'No drafts', hint: 'Messages you start writing are saved here.' };
    case 'Trash': return { title: 'Trash is empty', hint: 'Deleted mail stays here until you empty it.' };
    case 'Junk': return { title: 'No spam', hint: 'Mail marked as spam will appear here.' };
    case 'Archive': return { title: 'Nothing archived', hint: 'Mail you archive will appear here.' };
    default: return { title: `${o.folderName} is empty`, hint: 'Mail you move here will appear here.' };
  }
}

export function rowLabel(msg: MessageHeader, dateText: string): string {
  const parts = [
    msg.isSeen ? '' : 'Unread',
    `From ${msg.from.name || msg.from.address}`,
    msg.subject || '(No subject)',
    dateText,
    msg.isFlagged ? 'Starred' : '',
    msg.hasAttachments ? 'Has attachments' : ''
  ];
  return parts.filter(Boolean).join(', ');
}

const FILTER_TABS: { key: ListFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'starred', label: 'Starred' },
  { key: 'attachments', label: 'With files' }
];

interface RowController {
  check: (uid: number, e?: { shiftKey?: boolean; stopPropagation?: () => void }) => void;
  open: (uid: number) => void;
  focus: (uid: number) => void;
  flag: (uid: number, flag: 'isSeen' | 'isFlagged', e?: React.MouseEvent) => void;
  archive: (uid: number, mailbox?: string) => void;
  openSnooze: (uid: number) => void;
  closeSnooze: () => void;
  snooze: (uid: number, until: Date, mailbox?: string) => void;
}

interface RowProps {
  msg: MessageHeader;
  who: string;
  dateText: string;
  isSelected: boolean;
  isChecked: boolean;
  isUnread: boolean;
  tab: 0 | -1;
  isDraft: boolean;
  leaving: boolean;
  canArchive: boolean;
  labelMap: Map<string, Label>;
  snoozeOpen: boolean;
  ctl: RowController;
}

const QUICK =
  't-fast w-7 h-6 grid place-items-center rounded-[3px] bg-surface border border-line text-ink-2 hover:bg-hover hover:text-ink';

/** One row: avatar, three lines, chips. Memoised so that a change elsewhere does not redraw every row. */
const MessageRow = React.memo(function MessageRow({
  msg, who, dateText, isSelected, isChecked, isUnread, tab, isDraft, leaving, canArchive, labelMap, snoozeOpen, ctl
}: RowProps) {
  const bounce = msg.bounce;
  const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const rowLabels = (msg.labels ?? []).map((id) => labelMap.get(id)).filter((l): l is Label => !!l);
  const shownLabels = rowLabels.slice(0, 2);
  const snoozeBtn = useRef<HTMLButtonElement>(null);
  const slotW = msg.snoozedUntil ? 'w-[100px]' : 'w-[72px] [@media(hover:hover)]:w-[96px]';
  const pressed = useRef(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout>>();
  return (
    <li className="row-wrap list-none" data-leaving={leaving || undefined}>
      <div className="row-inner">
        <div
          onClick={(e) => {
            // A click anywhere on the row opens it, padding included. The avatar (selects), the star and the
            // quick actions are their own buttons and do their own thing.
            if ((e.target as HTMLElement).closest('button:not([data-row-open])')) return;
            if (pressed.current) {
              pressed.current = false;
              return;
            }
            ctl.open(msg.uid);
          }}
          className={`relative flex items-stretch border-b border-line t-fast cursor-pointer ${
            isSelected ? 'bg-sel cut-sel' : 'bg-surface hover:bg-hover'
          }`}
        >
          {isUnread && (
            <span
              className="absolute left-[5px] top-6 w-[7px] h-[7px] rounded-full bg-unread shadow-[0_0_0_1px_var(--dot-ring)] pointer-events-none"
              aria-hidden="true"
            />
          )}
          {/* The avatar is the select control: click it to tick (Shift for a range). */}
          <button
            type="button"
            tabIndex={tab}
            onClick={(e) => ctl.check(msg.uid, e)}
            aria-pressed={isChecked}
            aria-label={`Select message from ${who}`}
            className="pl-4 pr-3 pt-[13px] shrink-0 self-start"
          >
            <span
              className={`cut-av w-9 h-9 grid place-items-center text-[13px] font-extrabold tracking-wide text-white ${
                isChecked
                  ? 'bg-act !text-act-ink'
                  : bounce
                    ? 'bg-warn-bg !text-warn-ink'
                    : isDraft
                      ? 'bg-sheet !text-draft shadow-[inset_0_0_0_1px_var(--line-2)]'
                      : avatarClass(msg.from.address || who)
              }`}
              aria-hidden="true"
            >
              {isChecked ? (
                <Check className="w-4 h-4" strokeWidth={3} />
              ) : bounce ? (
                <AlertTriangle className="w-4 h-4" />
              ) : isDraft ? (
                <Pencil className="w-4 h-4" />
              ) : (
                initialsOf(who)
              )}
            </span>
          </button>

          {/* The whole summary is one button: Enter opens the message. A long press on a phone selects. */}
          <button
            type="button"
            data-row-open={msg.uid}
            tabIndex={tab}
            onPointerDown={(e) => {
              if (e.pointerType !== 'touch') return;
              pressed.current = false;
              clearTimeout(pressTimer.current);
              pressTimer.current = setTimeout(() => {
                pressed.current = true;
                ctl.check(msg.uid);
                navigator.vibrate?.(8);
              }, 500);
            }}
            onPointerUp={() => clearTimeout(pressTimer.current)}
            onPointerLeave={() => clearTimeout(pressTimer.current)}
            onPointerCancel={() => clearTimeout(pressTimer.current)}
            onContextMenu={(e) => {
              if (pressed.current) e.preventDefault();
            }}
            onFocus={() => ctl.focus(msg.uid)}
            aria-label={rowLabel(msg, dateText)}
            aria-current={isSelected ? 'true' : undefined}
            className="flex-1 min-w-0 py-[11px] max-lg:py-[9px] pr-1 text-left block"
          >
            <span className="min-w-0 flex-1 block">
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span
                    className={`truncate text-sm ${isUnread ? 'font-extrabold text-ink' : 'font-semibold text-ink-2'} ${
                      isSelected ? '!text-sel-ink' : ''
                    }`}
                  >
                    {bounce ? (
                      <span className="text-warn-ink font-extrabold">Not delivered</span>
                    ) : isDraft ? (
                      <span className="text-draft italic font-extrabold">Draft</span>
                    ) : (
                      who
                    )}
                  </span>
                  {!!msg.threadCount && msg.threadCount > 1 && (
                    <span
                      className="shrink-0 text-[11px] font-bold text-ink-3 border border-line-2 rounded-[3px] px-1 leading-[15px]"
                      title={`${msg.threadCount} messages in this conversation`}
                    >
                      {msg.threadCount}
                    </span>
                  )}
                </span>
                {/* The time itself is drawn in the shared slot below; this keeps its room. */}
                <span aria-hidden="true" className={`shrink-0 ${slotW}`} />
              </span>
              <span
                className={`block text-[13.5px] truncate mt-px ${isUnread ? 'font-bold text-ink' : 'font-medium text-ink'} ${
                  bounce ? '!text-warn-ink' : isSelected ? '!text-sel-ink' : ''
                }`}
              >
                {bounce ? (bounce.retryable ? `Could not deliver "${clip(bounce.originalSubject, 60)}" to ${clip(bounce.recipient, 40)}` : 'Delivery failed') : msg.subject || '(No subject)'}
              </span>
              <span className="block text-[13px] text-ink-3 truncate">
                {bounce ? (
                  bounce.reason
                ) : (
                  <>
                    {isDraft && msg.to.length > 0 && (
                      <span className="font-medium">To {msg.to.map((t) => t.name || t.address).join(', ')}. </span>
                    )}
                    {msg.snippet || 'No text content available'}
                  </>
                )}
              </span>
              {(msg.hasAttachments || shownLabels.length > 0) && (
                <span className="mt-[7px] flex items-center gap-1.5 flex-wrap">
                  {msg.hasAttachments && (
                    <span className="inline-flex items-center gap-1 h-[22px] pl-1.5 pr-2 border border-line-2 rounded-[3px] text-xs font-semibold text-ink-2">
                      <Paperclip className="w-[13px] h-[13px] shrink-0" aria-hidden="true" />
                      <span className="truncate max-w-[180px]">{msg.attachmentName || 'Attachment'}</span>
                    </span>
                  )}
                  {(msg.attachmentCount ?? 0) > 1 && (
                    <span className="text-xs font-bold text-ink-3">+{(msg.attachmentCount ?? 1) - 1}</span>
                  )}
                  {shownLabels.map((l) => (
                    <LabelChip key={l.id} label={l} />
                  ))}
                  {rowLabels.length > shownLabels.length && (
                    <span className="text-xs font-bold text-ink-3">+{rowLabels.length - shownLabels.length}</span>
                  )}
                </span>
              )}
            </span>
          </button>

          <button
            type="button"
            tabIndex={tab}
            onClick={(e) => ctl.flag(msg.uid, 'isFlagged', e)}
            aria-pressed={!!msg.isFlagged}
            aria-label={msg.isFlagged ? `Unstar message from ${who}` : `Star message from ${who}`}
            className="t-fast w-10 sm:w-8 shrink-0 flex items-start pt-[12px] justify-center text-ink-3 hover:text-star-line"
          >
            <Star className={`w-4 h-4 ${msg.isFlagged ? 'text-star-line fill-star' : 'stroke-[1.5]'}`} />
          </button>

          {/* Quick actions: fade in on hover or keyboard focus; the space is reserved by the time. */}
          {/* One slot, one fixed width: the time fades out as the quick actions fade in (and back). */}
          <div className={`row-slot absolute right-[44px] sm:right-[36px] top-[9px] max-lg:top-[7px] h-6 pointer-events-none ${slotW}`}>
            <span
              className={`row-time absolute inset-0 flex items-center justify-end text-xs tabular-nums whitespace-nowrap ${
                isUnread ? 'font-extrabold text-ink' : 'font-semibold text-ink-3'
              } ${bounce ? '!text-warn-ink' : ''}`}
            >
              {dateText}
            </span>
            <div className="row-quick absolute inset-0 flex justify-end items-center gap-0.5" data-open={snoozeOpen || undefined}>
              {canArchive && (
              <button
                type="button"
                tabIndex={tab}
                aria-label={`Archive message from ${who}`}
                title="Archive (E)"
                onClick={() => ctl.archive(msg.uid, msg.mailbox)}
                className={QUICK}
              >
                <Archive className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              tabIndex={tab}
              aria-label={isUnread ? `Mark message from ${who} as read` : `Mark message from ${who} as unread`}
              title={isUnread ? 'Mark as read' : 'Mark as unread (U)'}
              onClick={(e) => ctl.flag(msg.uid, 'isSeen', e)}
              className={QUICK}
            >
              {isUnread ? <MailOpen className="w-3.5 h-3.5" /> : <Mail className="w-3.5 h-3.5" />}
            </button>
            <button
              ref={snoozeBtn}
              type="button"
              tabIndex={tab}
              aria-label={`Snooze message from ${who}`}
              aria-haspopup="dialog"
              aria-expanded={snoozeOpen}
              aria-keyshortcuts="H"
              title="Snooze (H)"
              onClick={() => (snoozeOpen ? ctl.closeSnooze() : ctl.openSnooze(msg.uid))}
              className={QUICK}
            >
              <Clock className="w-3.5 h-3.5" />
            </button>
            </div>
          </div>
          <Presence show={snoozeOpen}>
          {snoozeOpen && (
            <SnoozeMenu
              anchor={snoozeBtn}
              onClose={(refocus) => {
                ctl.closeSnooze();
                if (refocus) snoozeBtn.current?.focus();
              }}
              onPick={(until) => ctl.snooze(msg.uid, until, msg.mailbox)}
            />
          )}
          </Presence>
        </div>
      </div>
    </li>
  );
});

export const MessageList: React.FC<MessageListProps> = ({
  folderName,
  messages,
  totalMessages,
  selectedUid,
  onSelectMessage,
  selectedUids,
  onToggleSelectUid,
  onSelectAll,
  onToggleFlag,
  onRefresh,
  isLoading,
  searchTerm,
  onSearchChange,
  filters = {},
  onFiltersChange,
  onBatchDelete,
  onBatchMarkRead,
  onBatchSpam,
  onBatchRestore,
  onBatchNotSpam,
  onCompose,
  isVisible = true,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  onOpenMobileSidebar,
  accountLabel,
  onClearSelection,
  viewKind,
  countReady = true,
  folderKind,
  onEmptyFolder,
  filter = 'all',
  onFilterChange,
  unreadCount = 0,
  labels = [],
  leavingUids,
  onArchive,
  onSnooze
}) => {
  const [showFilters, setShowFilters] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const sentinelRef = useRef<HTMLLIElement>(null);
  // The Search tab and the "/" key ask for the search box (open on a phone, then focus).
  useEffect(() => {
    const open = () => {
      setSearchOpen(true);
      setTimeout(() => document.querySelector<HTMLInputElement>('[data-search-input]')?.focus(), 30);
    };
    window.addEventListener('mailloom:search', open);
    return () => window.removeEventListener('mailloom:search', open);
  }, []);
  const scrollerRef = useRef<HTMLUListElement>(null);
  const savedScroll = useRef(0);
  // Roving focus: one row is in the Tab order; arrow keys move between rows.
  const [activeUid, setActiveUid] = useState<number | null>(null);
  const rowUid = messages.some((m) => m.uid === activeUid)
    ? activeUid
    : messages.some((m) => m.uid === selectedUid)
    ? selectedUid
    : messages[0]?.uid ?? null;

  // Coming back from a message on a phone: same scroll position, focus on the row that was open.
  const wasVisible = useRef(isVisible);
  useLayoutEffect(() => {
    if (isVisible && !wasVisible.current && scrollerRef.current) {
      scrollerRef.current.scrollTop = savedScroll.current;
    }
  }, [isVisible]);
  useEffect(() => {
    const cameBack = isVisible && !wasVisible.current;
    wasVisible.current = isVisible;
    if (!cameBack || selectedUid === null) return;
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-row-open="${selectedUid}"]`);
    el?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

  const onRowKeyDown = (e: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (!target.hasAttribute('data-row-open')) return;
    const rows = Array.from(scrollerRef.current?.querySelectorAll<HTMLElement>('[data-row-open]') || []);
    const i = rows.indexOf(target);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : rows.length - 1;
    const el = rows[Math.max(0, Math.min(rows.length - 1, next))];
    el.focus();
    setActiveUid(Number(el.getAttribute('data-row-open')));
  };

  // Rows under day headers: Today, Yesterday, This week, Earlier.
  const groups = useMemo(() => {
    const now = new Date();
    const out: { key: string; title: string; sub: string; items: MessageHeader[] }[] = [];
    let cur: { bucket: string; items: MessageHeader[] } | null = null;
    const raw: { bucket: ReturnType<typeof dayBucket>; items: MessageHeader[] }[] = [];
    for (const m of messages) {
      const b = dayBucket(m.date, now);
      if (!cur || cur.bucket !== b) {
        cur = { bucket: b, items: [] };
        raw.push(cur as { bucket: ReturnType<typeof dayBucket>; items: MessageHeader[] });
      }
      cur.items.push(m);
    }
    raw.forEach((g, i) => {
      const h = groupHeader(g.bucket, g.items.map((m) => new Date(m.date)));
      out.push({ key: `${g.bucket}-${i}`, ...h, items: g.items });
    });
    return out;
  }, [messages]);

  // Scrolling near the end loads the next page.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || isLoadingMore || isLoading || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore?.();
      },
      { root: scrollerRef.current, rootMargin: '300px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, isLoadingMore, isLoading, messages.length, onLoadMore]);

  const allSelected = messages.length > 0 && messages.every((m) => selectedUids.has(m.uid));

  const hasActiveFilters = Boolean(
    filters.from || filters.to || filters.subject || filters.since || filters.before
  );

  const formatMessageDate = (dateString: string) => rowTime(dateString);

  const latest = useRef({ onToggleSelectUid, onSelectMessage, onToggleFlag, onArchive, onSnooze });
  latest.current = { onToggleSelectUid, onSelectMessage, onToggleFlag, onArchive, onSnooze };
  const ctl = useMemo<RowController>(
    () => ({
      check: (uid, e) => latest.current.onToggleSelectUid(uid, e),
      open: (uid) => {
        setActiveUid(uid);
        latest.current.onSelectMessage(uid);
      },
      focus: (uid) => setActiveUid(uid),
      flag: (uid, flag, e) => latest.current.onToggleFlag(uid, flag, e),
      archive: (uid, mailbox) => latest.current.onArchive?.(uid, mailbox),
      openSnooze: (uid) => setSnoozeUid(uid),
      closeSnooze: () => setSnoozeUid(null),
      snooze: (uid, until, mailbox) => {
        setSnoozeUid(null);
        latest.current.onSnooze?.(uid, until, mailbox);
      }
    }),
    []
  );
  const empty = emptyState({ searchTerm, hasFilters: hasActiveFilters, filter, folderKind, viewKind, folderName });
  const showSkeleton = useAfterDelay((isLoading || !countReady) && messages.length === 0, 150);
  const labelMap = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const [snoozeUid, setSnoozeUid] = useState<number | null>(null);
  const canArchive = !!onArchive && folderKind !== 'Archive' && folderKind !== 'Drafts' && folderKind !== 'Sent';

  const FIELD =
    'w-full bg-surface border border-line rounded px-2 py-1 min-h-[44px] sm:min-h-0 text-base sm:text-xs text-ink focus:outline-none focus:border-act';

  return (
    <section
      aria-label="Message list"
      className="w-full flex-shrink-0 bg-surface md:border-r border-line flex flex-col h-full select-none relative"
    >
      {/* Header & Search */}
      <div className="px-4 pt-3 pb-3 border-b border-line flex flex-col gap-2.5 max-lg:bg-rail max-lg:cut-phone max-lg:pt-2 max-lg:pb-5 max-lg:gap-2">
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-baseline gap-2 min-w-0">
            <h1 className="text-2xl max-lg:text-[22px] font-extrabold text-ink max-lg:text-rail-ink tracking-tight truncate">{folderName}</h1>
            <span className="text-[13px] font-semibold text-ink-3 max-lg:text-rail-2 shrink-0">
              {!countReady
                ? ''
                : unreadCount > 0
                  ? `${unreadCount} unread`
                  : `${totalMessages} ${totalMessages === 1 ? 'message' : 'messages'}`}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {(folderKind === 'Trash' || folderKind === 'Junk') && onEmptyFolder && totalMessages > 0 && (
              <button
                onClick={onEmptyFolder}
                title={`Permanently delete everything in ${folderName}`}
                className="px-2 py-1 min-h-[44px] sm:min-h-0 text-xs font-bold text-warn-ink hover:bg-warn-bg max-lg:bg-surface rounded transition-colors"
              >
                Empty {folderName}
              </button>
            )}
            <button
              onClick={onRefresh}
              disabled={isLoading}
              title="Refresh messages"
              aria-label="Refresh messages"
              className={`p-1.5 text-ink-2 max-lg:text-rail-ink hover:text-act max-lg:hover:text-rail-ink hover:bg-hover max-lg:hover:bg-rail-hi rounded transition-colors disabled:opacity-50 ${TOUCH}`}
            >
              <RotateCw className={`w-4 h-4 ${isLoading ? 'animate-spin motion-reduce:animate-none' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => setSearchOpen((o) => !o)}
              aria-label="Search messages"
              aria-expanded={searchOpen}
              className={`lg:hidden p-1.5 text-rail-ink hover:bg-rail-hi rounded ${TOUCH}`}
            >
              <Search className="w-4 h-4" />
            </button>
            {onOpenMobileSidebar && (
              <button
                type="button"
                onClick={onOpenMobileSidebar}
                aria-label="Open folders and account"
                title="Folders and account"
                className={`lg:hidden ${TOUCH}`}
              >
                <span
                  aria-hidden="true"
                  className={`cut-av w-8 h-8 grid place-items-center text-[12px] font-extrabold text-white ${avatarClass(accountLabel || 'me')}`}
                >
                  {initialsOf(accountLabel || '?')}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Search Bar & Filter Toggle */}
        <div role="search" className={`relative flex items-center ${searchOpen || searchTerm ? '' : 'max-lg:hidden'}`}>
          <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="text"
            aria-label="Search messages"
            data-search-input
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search mail"
            className="w-full bg-sheet border border-line text-ink placeholder:text-ink-3 text-base sm:text-[13px] rounded pl-9 pr-24 sm:pr-16 py-2 min-h-[44px] sm:min-h-[34px] focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus transition-colors"
          />
          <div className="absolute right-0 sm:right-2 top-1/2 -translate-y-1/2 flex items-center gap-0 sm:gap-1">
            {searchTerm && (
              <button
                onClick={() => onSearchChange('')}
                className={`text-base sm:text-xs text-ink-3 hover:text-ink-2 p-0.5 ${TOUCH}`}
                title="Clear search"
                aria-label="Clear search"
              >
                ×
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowFilters(!showFilters)}
              aria-expanded={showFilters}
              aria-label="Filter by sender, recipient, subject or date"
              className={`p-1 rounded transition-colors relative ${TOUCH} ${
                showFilters || hasActiveFilters
                  ? 'text-sel-ink bg-sel'
                  : 'text-ink-3 hover:text-ink-2 hover:bg-hover'
              }`}
              title="Filter by From, To, Subject, or Date"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              {hasActiveFilters && (
                <span className="w-1.5 h-1.5 rounded-full bg-unread absolute top-0.5 right-0.5 ring-1 ring-surface" />
              )}
            </button>
          </div>
        </div>

        {/* Expandable IMAP Filter Panel */}
        {showFilters && (
          <div className="bg-surface border border-line rounded p-2.5 flex flex-col gap-2 text-xs text-ink">
            <div className="flex items-center justify-between pb-1 border-b border-line">
              <span className="font-bold text-xs text-ink-2">
                Search filters
              </span>
              {hasActiveFilters && onFiltersChange && (
                <button
                  type="button"
                  onClick={() => onFiltersChange({})}
                  className="text-xs text-act hover:text-act font-bold min-h-[44px] sm:min-h-0 px-1"
                >
                  Clear All
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-2">
              <div>
                <label htmlFor="filter-from" className="block text-xs font-bold text-ink-2 mb-0.5">From</label>
                <input
                  id="filter-from"
                  type="text"
                  value={filters.from || ''}
                  onChange={(e) => onFiltersChange?.({ ...filters, from: e.target.value })}
                  placeholder="sender@domain.com"
                  className={FIELD}
                />
              </div>
              <div>
                <label htmlFor="filter-to" className="block text-xs font-bold text-ink-2 mb-0.5">To</label>
                <input
                  id="filter-to"
                  type="text"
                  value={filters.to || ''}
                  onChange={(e) => onFiltersChange?.({ ...filters, to: e.target.value })}
                  placeholder="recipient@domain.com"
                  className={FIELD}
                />
              </div>
            </div>

            <div>
              <label htmlFor="filter-subject" className="block text-xs font-bold text-ink-2 mb-0.5">Subject</label>
              <input
                id="filter-subject"
                type="text"
                value={filters.subject || ''}
                onChange={(e) => onFiltersChange?.({ ...filters, subject: e.target.value })}
                placeholder="Keywords in subject line..."
                className={FIELD}
              />
            </div>

            <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-2">
              <div>
                <label htmlFor="filter-since" className="block text-xs font-bold text-ink-2 mb-0.5">Since (Date)</label>
                <input
                  id="filter-since"
                  type="date"
                  value={filters.since || ''}
                  onChange={(e) => onFiltersChange?.({ ...filters, since: e.target.value })}
                  className={FIELD}
                />
              </div>
              <div>
                <label htmlFor="filter-before" className="block text-xs font-bold text-ink-2 mb-0.5">Before (Date)</label>
                <input
                  id="filter-before"
                  type="date"
                  value={filters.before || ''}
                  onChange={(e) => onFiltersChange?.({ ...filters, before: e.target.value })}
                  className={FIELD}
                />
              </div>
            </div>
          </div>
        )}

        {onFilterChange && (
          <div role="group" aria-label="Show" className="flex gap-1 flex-nowrap overflow-x-auto max-lg:-mx-1 max-lg:px-1">
            {FILTER_TABS.map((t) => {
              const on = (filter ?? 'all') === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={on}
                  aria-label={t.key === 'attachments' ? 'With files' : undefined}
                  onClick={() => onFilterChange(t.key)}
                  className={`t-fast shrink-0 min-h-[36px] sm:min-h-[28px] px-2.5 rounded-[3px] text-[12.5px] font-bold ${
                    on
                      ? 'bg-ink text-surface max-lg:bg-ph-on max-lg:text-ph-on-ink'
                      : 'text-ink-2 max-lg:text-rail-2 hover:bg-hover max-lg:hover:bg-rail-hi'
                  }`}
                >
                  {t.key === 'attachments' ? (
                    <>
                      <span aria-hidden="true" className="lg:hidden">Files</span>
                      <span aria-hidden="true" className="max-lg:hidden">With files</span>
                    </>
                  ) : (
                    t.label
                  )}
                  {t.key === 'unread' && unreadCount > 0 && (
                    <span className="ml-1.5 inline-block bg-pill text-pill-ink px-1.5 rounded-[3px] text-[11.5px] leading-4">
                      {unreadCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Batch Actions Toolbar */}
      {selectedUids.size > 0 && (
      <div
        role="toolbar"
        aria-label="Actions for selected messages"
        className="anim-rise px-4 py-1 border-b border-line bg-sel flex flex-wrap items-center justify-between gap-x-2 text-xs text-sel-ink"
      >
        <div className="flex items-center gap-1">
          <button
            onClick={onSelectAll}
            className={`text-ink-3 hover:text-ink p-0.5 rounded transition-colors ${TOUCH}`}
            title={allSelected ? 'Deselect all' : 'Select all'}
            aria-label={allSelected ? 'Deselect all messages' : 'Select all messages'}
            aria-pressed={allSelected}
          >
            <Check className={`w-4 h-4 ${allSelected ? 'text-act' : ''}`} strokeWidth={allSelected ? 3 : 2} />
          </button>
          <span className="font-bold" aria-live="polite">
            {selectedUids.size} selected
          </span>
          <button
            type="button"
            onClick={onClearSelection}
            title="Clear selection"
            aria-label="Clear selection"
            className={`p-1 rounded hover:bg-hover ${TOUCH}`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => onBatchMarkRead(true)}
              title="Mark as read"
              aria-label="Mark selected as read"
              className={`p-1 hover:bg-hover text-ink-2 hover:text-ink rounded transition-colors ${TOUCH}`}
            >
              <MailOpen className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onBatchMarkRead(false)}
              title="Mark as unread"
              aria-label="Mark selected as unread"
              className={`p-1 hover:bg-hover text-ink-2 hover:text-ink rounded transition-colors ${TOUCH}`}
            >
              <Mail className="w-3.5 h-3.5" />
            </button>
            {folderKind === 'Trash' && onBatchRestore && (
              <button
                onClick={onBatchRestore}
                title="Restore selected to Inbox"
                aria-label="Restore selected to Inbox"
                className={`p-1 hover:bg-sel text-ink-2 hover:text-sel-ink rounded transition-colors ${TOUCH}`}
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
            )}
            {folderKind === 'Junk' && onBatchNotSpam && (
              <button
                onClick={onBatchNotSpam}
                title="Not spam: move selected back to Inbox"
                aria-label="Not spam: move selected back to Inbox"
                className={`p-1 hover:bg-toast-bg text-ink-2 hover:text-ok-ink rounded transition-colors ${TOUCH}`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={onBatchDelete}
              title={folderKind === 'Trash' ? 'Delete selected forever' : 'Move selected to Trash'}
              aria-label={folderKind === 'Trash' ? 'Delete selected forever' : 'Move selected to Trash'}
              className={`p-1 hover:bg-warn-bg text-ink-2 hover:text-warn-ink rounded transition-colors ${TOUCH}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {onBatchSpam && folderKind !== 'Junk' && (
              <button
                onClick={onBatchSpam}
                title="Mark as Spam / Move to Junk"
                aria-label="Mark selected as spam"
                className={`p-1 hover:bg-caution-bg text-ink-2 hover:text-caution rounded transition-colors ${TOUCH}`}
              >
                <ShieldAlert className="w-3.5 h-3.5" />
              </button>
            )}
        </div>
      </div>
      )}

      {/* Message List Stream */}
      {(isLoading || !countReady) && messages.length === 0 ? (
        showSkeleton ? <SkeletonRows /> : <div className="flex-1" />
      ) : messages.length === 0 ? (
        <div className="flex-1 py-20 flex flex-col items-center justify-center text-ink-3 gap-2">
          <Inbox className="w-10 h-10 stroke-[1.4] text-ink-3" aria-hidden="true" />
          <span className="text-base font-extrabold text-ink text-center px-6">{empty.title}</span>
          <span className="text-[13px] text-ink-3 text-center px-8 max-w-[34ch]">{empty.hint}</span>
          {empty.action && (
            <button
              type="button"
              onClick={() => (empty.action === 'clear-search' ? onSearchChange('') : onFiltersChange?.({}))}
              className="t-fast mt-2 min-h-[44px] sm:min-h-[36px] px-4 rounded border border-line-2 bg-surface hover:bg-hover text-[13px] font-extrabold text-ink-2"
            >
              {empty.action === 'clear-search' ? 'Clear search' : 'Clear filters'}
            </button>
          )}
        </div>
      ) : (
        <ul
          ref={scrollerRef}
          aria-label={`${folderName} messages`}
          onKeyDown={onRowKeyDown}
          onScroll={(e) => {
            if (e.currentTarget.clientHeight > 0) savedScroll.current = e.currentTarget.scrollTop;
          }}
          className="flex-1 overflow-y-auto list-none m-0 p-0"
        >
          {groups.map((g) => (
            <React.Fragment key={g.key}>
              <li role="presentation" className="flex items-baseline gap-2 pt-4 pb-1.5 pl-16 pr-5 bg-surface list-none">
                <b className="text-[13px] font-extrabold text-ink">{g.title}</b>
                {g.sub && <span className="text-xs font-medium text-ink-3">{g.sub}</span>}
              </li>
              {g.items.map((msg) => {
                const isSelected = selectedUid === msg.uid;
                const isChecked = selectedUids.has(msg.uid);
                const isUnread = !msg.isSeen;
                const tab = rowUid === msg.uid ? 0 : -1;
                const dateText = msg.snoozedUntil ? untilText(msg.snoozedUntil) : formatMessageDate(msg.date);
                const who = msg.from.name || msg.from.address;
                const isDraft = folderKind === 'Drafts';

                return (
                  <MessageRow
                    key={`${msg.mailbox ?? ''}:${msg.uid}`}
                    msg={msg}
                    who={who}
                    dateText={dateText}
                    isSelected={isSelected}
                    isChecked={isChecked}
                    isUnread={isUnread}
                    tab={tab}
                    isDraft={isDraft}
                    leaving={!!leavingUids?.has(msg.uid)}
                    canArchive={canArchive}
                    labelMap={labelMap}
                    snoozeOpen={snoozeUid === msg.uid}
                    ctl={ctl}
                  />
                );
              })}
            </React.Fragment>
          ))}
          {(hasMore || isLoadingMore) && (
            <li ref={sentinelRef} className="list-none px-4 py-3 text-center text-xs font-semibold text-ink-3">
              {isLoadingMore ? (
                'Loading more...'
              ) : (
                <button type="button" onClick={onLoadMore} className="t-fast min-h-[44px] px-3 rounded hover:bg-hover text-ink-2 font-bold">
                  Load more
                </button>
              )}
            </li>
          )}
        </ul>
      )}

      {/* New Message: always reachable on small screens (the sidebar is hidden there) */}
      {onCompose && (
        <button
          type="button"
          onClick={onCompose}
          aria-label="New message"
          title="New message"
          className="lg:hidden cut-tr absolute right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 h-[52px] pl-4 pr-5 gap-2 bg-act hover:bg-act-hov text-act-ink font-extrabold text-[15px] flex items-center justify-center transition-colors"
        >
          <PenSquare className="w-5 h-5" strokeWidth={2.2} aria-hidden="true" />
          <span>Write</span>
        </button>
      )}
    </section>
  );
};
