import React, { useState } from 'react';
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
  ShieldAlert
} from 'lucide-react';
import { format, isToday, isThisYear } from 'date-fns';
import type { MessageHeader } from '../types.js';
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
  page: number;
  limit: number;
  onPageChange: (page: number) => void;
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
  page,
  limit,
  onPageChange
}) => {
  const [showFilters, setShowFilters] = useState(false);
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

  return (
    <div className="w-[380px] lg:w-[420px] xl:w-[460px] flex-shrink-0 bg-white border-r border-slate-200 flex flex-col h-full select-none">
      {/* Header & Search */}
      <div className="p-3.5 border-b border-slate-100 flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-slate-800 tracking-tight">{folderName}</h1>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
              {totalMessages}
            </span>
          </div>
          <button
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh messages"
            className="p-1.5 text-slate-400 hover:text-sky-600 hover:bg-sky-50 rounded-lg transition-colors disabled:opacity-50"
          >
            <RotateCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-sky-600' : ''}`} />
          </button>
        </div>

        {/* Search Bar & Filter Toggle */}
        <div className="relative flex items-center">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search sender, subject or snippet..."
            className="w-full bg-slate-50 border border-slate-200 text-slate-800 placeholder-slate-400 text-xs rounded-lg pl-9 pr-16 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 transition-all"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {searchTerm && (
              <button
                onClick={() => onSearchChange('')}
                className="text-xs text-slate-400 hover:text-slate-600 p-0.5"
                title="Clear search"
              >
                ×
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowFilters(!showFilters)}
              className={`p-1 rounded transition-colors relative ${
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
                  className="text-[11px] text-sky-600 hover:text-sky-700 font-medium"
                >
                  Clear All
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 uppercase mb-0.5">From</label>
                <input
                  type="text"
                  value={filters.from || ''}
                  onChange={(e) => onFiltersChange?.({ ...filters, from: e.target.value })}
                  placeholder="sender@domain.com"
                  className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-xs text-slate-800 focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 uppercase mb-0.5">To</label>
                <input
                  type="text"
                  value={filters.to || ''}
                  onChange={(e) => onFiltersChange?.({ ...filters, to: e.target.value })}
                  placeholder="recipient@domain.com"
                  className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-xs text-slate-800 focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase mb-0.5">Subject</label>
              <input
                type="text"
                value={filters.subject || ''}
                onChange={(e) => onFiltersChange?.({ ...filters, subject: e.target.value })}
                placeholder="Keywords in subject line..."
                className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-xs text-slate-800 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 uppercase mb-0.5">Since (Date)</label>
                <input
                  type="date"
                  value={filters.since || ''}
                  onChange={(e) => onFiltersChange?.({ ...filters, since: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded px-1.5 py-1 text-xs text-slate-800 focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 uppercase mb-0.5">Before (Date)</label>
                <input
                  type="date"
                  value={filters.before || ''}
                  onChange={(e) => onFiltersChange?.({ ...filters, before: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded px-1.5 py-1 text-xs text-slate-800 focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Batch Actions Toolbar */}
      <div className="px-3 py-2 border-b border-slate-100 bg-slate-50/70 flex items-center justify-between text-xs text-slate-600">
        <div className="flex items-center gap-2">
          <button
            onClick={onSelectAll}
            className="text-slate-500 hover:text-slate-800 p-0.5 rounded transition-colors"
            title={allSelected ? 'Deselect all' : 'Select all'}
          >
            {allSelected ? (
              <CheckSquare className="w-4 h-4 text-sky-600" />
            ) : someSelected ? (
              <MinusSquare className="w-4 h-4 text-sky-600" />
            ) : (
              <Square className="w-4 h-4 text-slate-400" />
            )}
          </button>
          <span className="font-medium text-slate-500">
            {selectedUids.size > 0 ? `${selectedUids.size} selected` : 'Select'}
          </span>
        </div>

        {selectedUids.size > 0 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onBatchMarkRead(true)}
              title="Mark as read"
              className="p-1 hover:bg-slate-200/70 text-slate-600 hover:text-slate-900 rounded transition-colors"
            >
              <MailOpen className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onBatchMarkRead(false)}
              title="Mark as unread"
              className="p-1 hover:bg-slate-200/70 text-slate-600 hover:text-slate-900 rounded transition-colors"
            >
              <Mail className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onBatchDelete}
              title="Delete selected"
              className="p-1 hover:bg-red-50 text-slate-600 hover:text-red-600 rounded transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {onBatchSpam && (
              <button
                onClick={onBatchSpam}
                title="Mark as Spam / Move to Junk"
                className="p-1 hover:bg-amber-50 text-slate-600 hover:text-amber-600 rounded transition-colors"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Message List Stream */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
        {isLoading && messages.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-slate-400 gap-3">
            <RotateCw className="w-6 h-6 animate-spin text-sky-500" />
            <span className="text-xs font-medium">Fetching messages...</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-slate-400 gap-2">
            <Inbox className="w-10 h-10 stroke-1 text-slate-300" />
            <span className="text-sm font-semibold text-slate-600">No messages found</span>
            <span className="text-xs text-slate-400">This mailbox folder is currently empty</span>
          </div>
        ) : (
          messages.map((msg) => {
            const isSelected = selectedUid === msg.uid;
            const isChecked = selectedUids.has(msg.uid);
            const isUnread = !msg.isSeen;

            return (
              <div
                key={msg.uid}
                onClick={() => onSelectMessage(msg.uid)}
                className={`relative px-3.5 py-3 flex gap-3 cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-sky-50/80 border-l-4 border-l-sky-600'
                    : isUnread
                    ? 'bg-white hover:bg-slate-50'
                    : 'bg-slate-50/40 hover:bg-slate-100/60'
                }`}
              >
                {/* Checkbox & Star Controls */}
                <div className="flex flex-col items-center justify-between pt-0.5 shrink-0 gap-2">
                  <button
                    onClick={(e) => onToggleSelectUid(msg.uid, e)}
                    className="text-slate-400 hover:text-slate-600 p-0.5"
                  >
                    {isChecked ? (
                      <CheckSquare className="w-3.5 h-3.5 text-sky-600" />
                    ) : (
                      <Square className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    onClick={(e) => onToggleFlag(msg.uid, 'isFlagged', e)}
                    className="p-0.5 text-slate-300 hover:text-amber-500 transition-colors"
                  >
                    <Star
                      className={`w-3.5 h-3.5 ${
                        msg.isFlagged ? 'text-amber-500 fill-amber-500' : 'stroke-[1.5]'
                      }`}
                    />
                  </button>
                </div>

                {/* Email Content Summary */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <div className="flex items-center gap-1.5 truncate">
                      {isUnread && (
                        <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" title="Unread" />
                      )}
                      <span
                        className={`truncate text-xs ${
                          isUnread ? 'font-bold text-slate-900' : 'font-semibold text-slate-700'
                        }`}
                      >
                        {msg.from.name || msg.from.address}
                      </span>
                    </div>
                    <span className="text-[11px] text-slate-400 shrink-0 font-medium">
                      {formatMessageDate(msg.date)}
                    </span>
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
                    {msg.hasAttachments && (
                      <span title="Has attachments">
                        <Paperclip className="w-3 h-3 text-slate-400 shrink-0" />
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination Footer */}
      <div className="px-3.5 py-2.5 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between text-xs text-slate-500 font-medium">
        <span>
          Page {page} of {totalPages}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || isLoading}
            className="p-1 hover:bg-slate-200/60 rounded disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages || isLoading}
            className="p-1 hover:bg-slate-200/60 rounded disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
