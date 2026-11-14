import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import {
  Search,
  RotateCw,
  Star,
  Paperclip,
  CheckSquare,
  Square,
  MinusSquare,
  Trash2,
  Mail,
  MailOpen,
  ChevronLeft,
  ChevronRight,
  Inbox,
  SlidersHorizontal,
  ShieldAlert,
  ShieldCheck,
  Undo2,
  PenSquare,
  Menu
} from 'lucide-react';
import { format, isToday, isThisYear } from 'date-fns';
import type { MessageHeader, SpecialUseFolder } from '../types.js';
import type { SearchFilterParams } from '../services/api.js';

interface MessageListProps {
  folderName: string;
  messages: MessageHeader[];
  totalMessages: number;
  selectedUid: number | null;
  onSelectMessage: (uid: number) => void;
  selectedUids: Set<number>;
  onToggleSelectUid: (uid: number, e: React.MouseEvent) => void;
  onSelectAll: () => void;
  onToggleFlag: (uid: number, flag: 'isSeen' | 'isFlagged', e: React.MouseEvent) => void;
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
  page: number;
  limit: number;
  onPageChange: (page: number) => void;
  onOpenMobileSidebar?: () => void;
  folderKind?: SpecialUseFolder;
  /** Empty Trash / Junk (the caller asks for confirmation). */
  onEmptyFolder?: () => void;
}

const TOUCH = 'min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center';

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
  page,
  limit,
  onPageChange,
  onOpenMobileSidebar,
  folderKind,
  onEmptyFolder
}) => {
  const [showFilters, setShowFilters] = useState(false);
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

  const allSelected = messages.length > 0 && messages.every((m) => selectedUids.has(m.uid));
  const someSelected = messages.some((m) => selectedUids.has(m.uid)) && !allSelected;

  const hasActiveFilters = Boolean(
    filters.from || filters.to || filters.subject || filters.since || filters.before
  );

  const totalPages = Math.max(1, Math.ceil(totalMessages / limit));

  const formatMessageDate = (dateString: string) => {
    try {
      const d = new Date(dateString);
      if (isNaN(d.getTime())) return '';
      if (isToday(d)) {
        return format(d, 'h:mm a');
      }
      if (isThisYear(d)) {
        return format(d, 'MMM d');
      }
      return format(d, 'MM/dd/yy');
    } catch {
      return '';
    }
  };

  const FIELD =
    'w-full bg-white border border-slate-200 rounded px-2 py-1 min-h-[44px] sm:min-h-0 text-base sm:text-xs text-slate-800 focus:outline-none focus:border-sky-500';

  return (
    <section
      aria-label="Message list"
      className="w-full flex-shrink-0 bg-white border-r border-slate-200 flex flex-col h-full select-none relative"
    >
      {/* Header & Search */}
      <div className="p-3.5 border-b border-slate-100 flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-2 min-w-0">
            {onOpenMobileSidebar && (
              <button
                onClick={onOpenMobileSidebar}
                className={`p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors lg:hidden ${TOUCH}`}
                title="Open folders"
                aria-label="Open folders"
              >
                <Menu className="w-5 h-5" />
              </button>
            )}
            <h1 className="text-lg font-bold text-slate-800 tracking-tight truncate">{folderName}</h1>
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 shrink-0"
              aria-label={`${totalMessages} messages`}
            >
              {totalMessages}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {(folderKind === 'Trash' || folderKind === 'Junk') && onEmptyFolder && totalMessages > 0 && (
              <button
                onClick={onEmptyFolder}
                title={`Permanently delete everything in ${folderName}`}
                className="px-2 py-1 min-h-[44px] sm:min-h-0 text-[11px] font-semibold text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                Empty {folderName}
              </button>
            )}
            <button
              onClick={onRefresh}
              disabled={isLoading}
              title="Refresh messages"
              aria-label="Refresh messages"
              className={`p-1.5 text-slate-400 hover:text-sky-600 hover:bg-sky-50 rounded-lg transition-colors disabled:opacity-50 ${TOUCH}`}
            >
              <RotateCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-sky-600' : ''}`} />
            </button>
          </div>
        </div>

        {/* Search Bar & Filter Toggle */}
        <div role="search" className="relative flex items-center">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            aria-label="Search messages"
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search sender, subject or snippet..."
            className="w-full bg-slate-50 border border-slate-200 text-slate-800 placeholder-slate-400 text-base sm:text-xs rounded-lg pl-9 pr-24 sm:pr-16 py-2 min-h-[44px] sm:min-h-0 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 transition-all"
          />
          <div className="absolute right-0 sm:right-2 top-1/2 -translate-y-1/2 flex items-center gap-0 sm:gap-1">
            {searchTerm && (
              <button
                onClick={() => onSearchChange('')}
                className={`text-base sm:text-xs text-slate-400 hover:text-slate-600 p-0.5 ${TOUCH}`}
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
                  ? 'text-sky-600 bg-sky-100/70'
                  : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
              }`}
              title="Filter by From, To, Subject, or Date"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              {hasActiveFilters && (
                <span className="w-1.5 h-1.5 rounded-full bg-sky-600 absolute top-0.5 right-0.5 ring-1 ring-white" />
              )}
            </button>
          </div>
        </div>

        {/* Expandable IMAP Filter Panel */}
        {showFilters && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 flex flex-col gap-2 text-xs">
            <div className="flex items-center justify-between pb-1 border-b border-slate-200">
              <span className="font-semibold text-[10px] text-slate-500 uppercase tracking-wider">
                IMAP Search Filters
              </span>
              {hasActiveFilters && onFiltersChange && (
                <button
                  type="button"
                  onClick={() => onFiltersChange({})}
                  className="text-[11px] text-sky-600 hover:text-sky-700 font-medium min-h-[44px] sm:min-h-0 px-1"
                >
                  Clear All
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-2">
              <div>
                <label htmlFor="filter-from" className="block text-[10px] font-semibold text-slate-400 uppercase mb-0.5">From</label>
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
                <label htmlFor="filter-to" className="block text-[10px] font-semibold text-slate-400 uppercase mb-0.5">To</label>
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
              <label htmlFor="filter-subject" className="block text-[10px] font-semibold text-slate-400 uppercase mb-0.5">Subject</label>
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
                <label htmlFor="filter-since" className="block text-[10px] font-semibold text-slate-400 uppercase mb-0.5">Since (Date)</label>
                <input
                  id="filter-since"
                  type="date"
                  value={filters.since || ''}
                  onChange={(e) => onFiltersChange?.({ ...filters, since: e.target.value })}
                  className={FIELD}
                />
              </div>
              <div>
                <label htmlFor="filter-before" className="block text-[10px] font-semibold text-slate-400 uppercase mb-0.5">Before (Date)</label>
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
      </div>

      {/* Batch Actions Toolbar */}
      <div
        role="toolbar"
        aria-label="Actions for selected messages"
        className="px-3 py-1 border-b border-slate-100 bg-slate-50/70 flex flex-wrap items-center justify-between gap-x-2 text-xs text-slate-600"
      >
        <div className="flex items-center gap-1">
          <button
            onClick={onSelectAll}
            className={`text-slate-500 hover:text-slate-800 p-0.5 rounded transition-colors ${TOUCH}`}
            title={allSelected ? 'Deselect all' : 'Select all'}
            aria-label={allSelected ? 'Deselect all messages' : 'Select all messages'}
            aria-pressed={allSelected}
          >
            {allSelected ? (
              <CheckSquare className="w-4 h-4 text-sky-600" />
            ) : someSelected ? (
              <MinusSquare className="w-4 h-4 text-sky-600" />
            ) : (
              <Square className="w-4 h-4 text-slate-400" />
            )}
          </button>
          <span className="font-medium text-slate-500" aria-live="polite">
            {selectedUids.size > 0 ? `${selectedUids.size} selected` : 'Select'}
          </span>
        </div>

        {selectedUids.size > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => onBatchMarkRead(true)}
              title="Mark as read"
              aria-label="Mark selected as read"
              className={`p-1 hover:bg-slate-200/70 text-slate-600 hover:text-slate-900 rounded transition-colors ${TOUCH}`}
            >
              <MailOpen className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onBatchMarkRead(false)}
              title="Mark as unread"
              aria-label="Mark selected as unread"
              className={`p-1 hover:bg-slate-200/70 text-slate-600 hover:text-slate-900 rounded transition-colors ${TOUCH}`}
            >
              <Mail className="w-3.5 h-3.5" />
            </button>
            {folderKind === 'Trash' && onBatchRestore && (
              <button
                onClick={onBatchRestore}
                title="Restore selected to Inbox"
                aria-label="Restore selected to Inbox"
                className={`p-1 hover:bg-sky-50 text-slate-600 hover:text-sky-700 rounded transition-colors ${TOUCH}`}
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
            )}
            {folderKind === 'Junk' && onBatchNotSpam && (
              <button
                onClick={onBatchNotSpam}
                title="Not spam: move selected back to Inbox"
                aria-label="Not spam: move selected back to Inbox"
                className={`p-1 hover:bg-emerald-50 text-slate-600 hover:text-emerald-700 rounded transition-colors ${TOUCH}`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={onBatchDelete}
              title={folderKind === 'Trash' ? 'Delete selected forever' : 'Move selected to Trash'}
              aria-label={folderKind === 'Trash' ? 'Delete selected forever' : 'Move selected to Trash'}
              className={`p-1 hover:bg-red-50 text-slate-600 hover:text-red-600 rounded transition-colors ${TOUCH}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {onBatchSpam && folderKind !== 'Junk' && (
              <button
                onClick={onBatchSpam}
                title="Mark as Spam / Move to Junk"
                aria-label="Mark selected as spam"
                className={`p-1 hover:bg-amber-50 text-slate-600 hover:text-amber-600 rounded transition-colors ${TOUCH}`}
              >
                <ShieldAlert className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Message List Stream */}
      {isLoading && messages.length === 0 ? (
        <div className="flex-1 py-20 flex flex-col items-center justify-center text-slate-400 gap-3" role="status">
          <RotateCw className="w-6 h-6 animate-spin text-sky-500" />
          <span className="text-xs font-medium">Fetching messages...</span>
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 py-20 flex flex-col items-center justify-center text-slate-400 gap-2">
          <Inbox className="w-10 h-10 stroke-1 text-slate-300" />
          <span className="text-sm font-semibold text-slate-600">No messages found</span>
          <span className="text-xs text-slate-400">This mailbox folder is currently empty</span>
        </div>
      ) : (
        <ul
          ref={scrollerRef}
          aria-label={`${folderName} messages`}
          onKeyDown={onRowKeyDown}
          onScroll={(e) => {
            if (e.currentTarget.clientHeight > 0) savedScroll.current = e.currentTarget.scrollTop;
          }}
          className="flex-1 overflow-y-auto divide-y divide-slate-100 list-none m-0 p-0"
        >
          {messages.map((msg) => {
            const isSelected = selectedUid === msg.uid;
            const isChecked = selectedUids.has(msg.uid);
            const isUnread = !msg.isSeen;
            const tab = rowUid === msg.uid ? 0 : -1;
            const dateText = formatMessageDate(msg.date);
            const who = msg.from.name || msg.from.address;

            return (
              <li
                key={msg.uid}
                className={`relative flex items-stretch transition-colors ${
                  isSelected
                    ? 'bg-sky-50/80 border-l-4 border-l-sky-600'
                    : isUnread
                    ? 'bg-white hover:bg-slate-50'
                    : 'bg-slate-50/40 hover:bg-slate-100/60'
                }`}
              >
                <button
                  type="button"
                  tabIndex={tab}
                  onClick={(e) => onToggleSelectUid(msg.uid, e)}
                  aria-pressed={isChecked}
                  aria-label={`Select message from ${who}`}
                  className="w-11 sm:w-9 shrink-0 flex items-center justify-center text-slate-400 hover:text-slate-600"
                >
                  {isChecked ? (
                    <CheckSquare className="w-3.5 h-3.5 text-sky-600" />
                  ) : (
                    <Square className="w-3.5 h-3.5" />
                  )}
                </button>

                {/* The whole summary is one button: Enter opens the message. */}
                <button
                  type="button"
                  data-row-open={msg.uid}
                  tabIndex={tab}
                  onClick={() => {
                    setActiveUid(msg.uid);
                    onSelectMessage(msg.uid);
                  }}
                  onFocus={() => setActiveUid(msg.uid)}
                  aria-label={rowLabel(msg, dateText)}
                  aria-current={isSelected ? 'true' : undefined}
                  className="flex-1 min-w-0 py-3 text-left"
                >
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <div className="flex items-center gap-1.5 truncate">
                      {isUnread && <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" aria-hidden="true" />}
                      <span
                        className={`truncate text-xs ${
                          isUnread ? 'font-bold text-slate-900' : 'font-semibold text-slate-700'
                        }`}
                      >
                        {who}
                      </span>
                    </div>
                    <span className="text-[11px] text-slate-400 shrink-0 font-medium">{dateText}</span>
                  </div>

                  <div
                    className={`text-xs truncate mb-1 ${
                      isUnread ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'
                    }`}
                  >
                    {msg.subject || '(No subject)'}
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-slate-500 truncate leading-relaxed">
                      {msg.snippet || 'No text content available'}
                    </p>
                    {msg.hasAttachments && <Paperclip className="w-3 h-3 text-slate-400 shrink-0" aria-hidden="true" />}
                  </div>
                </button>

                <button
                  type="button"
                  tabIndex={tab}
                  onClick={(e) => onToggleFlag(msg.uid, 'isFlagged', e)}
                  aria-pressed={!!msg.isFlagged}
                  aria-label={msg.isFlagged ? `Unstar message from ${who}` : `Star message from ${who}`}
                  className="w-11 sm:w-9 shrink-0 flex items-center justify-center text-slate-300 hover:text-amber-500 transition-colors"
                >
                  <Star
                    className={`w-3.5 h-3.5 ${msg.isFlagged ? 'text-amber-500 fill-amber-500' : 'stroke-[1.5]'}`}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Pagination Footer */}
      <div className="px-3.5 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] border-t border-slate-100 bg-slate-50/50 flex items-center justify-between text-xs text-slate-500 font-medium">
        <span>
          Page {page} of {totalPages}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || isLoading}
            aria-label="Previous page"
            className={`p-1 hover:bg-slate-200/60 rounded disabled:opacity-40 disabled:hover:bg-transparent ${TOUCH}`}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages || isLoading}
            aria-label="Next page"
            className={`p-1 hover:bg-slate-200/60 rounded disabled:opacity-40 disabled:hover:bg-transparent ${TOUCH}`}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* New Message: always reachable on small screens (the sidebar is hidden there) */}
      {onCompose && (
        <button
          type="button"
          onClick={onCompose}
          aria-label="New message"
          title="New message"
          className="lg:hidden absolute right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 h-14 w-14 rounded-full bg-sky-600 hover:bg-sky-500 text-white shadow-lg shadow-sky-900/30 flex items-center justify-center active:scale-95 transition-transform"
        >
          <PenSquare className="w-6 h-6" />
        </button>
      )}
    </section>
  );
};
