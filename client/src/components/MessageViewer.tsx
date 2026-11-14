import React, { useState, useRef, useEffect } from 'react';
import {
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Mail,
  Star,
  Download,
  FileText,
  Image as ImageIcon,
  FileArchive,
  File,
  Printer,
  ChevronDown,
  FolderInput,
  ShieldAlert,
  ShieldCheck,
  ArrowLeft,
  Undo2,
  Pencil,
  ImageOff,
  MoreHorizontal,
  Archive
} from 'lucide-react';
import { format } from 'date-fns';
import type { ParsedEmailMessage, MailboxFolder, EmailAttachment, SpecialUseFolder } from '../types.js';
import { api } from '../services/api.js';
import { useDialog } from '../hooks/useDialog.js';

// Never below 32 px, never wrapping or shrinking: the toolbar moves actions into "More" instead.
const TOUCH = 'min-h-[44px] min-w-[44px] sm:min-h-8 sm:min-w-8 flex items-center justify-center shrink-0 whitespace-nowrap';
const SMALL_BTN = 'min-h-8 min-w-8 flex items-center justify-center shrink-0 whitespace-nowrap';

export type ToolbarLevel = 'full' | 'mid' | 'tight';

/**
 * How much of the message toolbar fits in `width` px (the toolbar's own width, not the window's):
 * full = everything, mid = labelled main actions with the rest under More, tight = icon-only main actions.
 * An unknown width (0) counts as full.
 */
export function toolbarLevel(width: number): ToolbarLevel {
  if (!width || width >= 800) return 'full';
  if (width >= 520) return 'mid';
  return 'tight';
}

function useToolbarLevel(ref: React.RefObject<HTMLElement | null>, active: boolean): ToolbarLevel {
  const [level, setLevel] = useState<ToolbarLevel>('full');
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setLevel(toolbarLevel(el.getBoundingClientRect().width || el.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, active]);
  return level;
}

interface MenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

/** The "More" menu: the actions that do not fit on a phone toolbar. */
const MoreMenu: React.FC<{ items: MenuItem[]; always?: boolean }> = ({ items, always }) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const entries = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []);
    entries()[0]?.focus();
    const close = (refocus: boolean) => {
      setOpen(false);
      if (refocus) btnRef.current?.focus();
    };
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      } else if (e.key === 'Tab') {
        close(false);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = entries();
        const i = list.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[next]?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`relative shrink-0 ${always ? '' : 'sm:hidden'}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        title="More"
        className={`p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors ${TOUCH}`}
      >
        <MoreHorizontal className="w-5 h-5" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More actions"
          className="absolute right-0 mt-1 w-56 max-w-[calc(100vw-1rem)] bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 z-30"
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onSelect();
                btnRef.current?.focus();
              }}
              className="w-full min-h-[44px] text-left px-3 py-2 text-sm text-slate-700 hover:bg-sky-50 hover:text-sky-700 flex items-center gap-3"
            >
              {it.icon}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** Pick the folder to move the message to. */
const MoveDialog: React.FC<{
  open: boolean;
  folders: MailboxFolder[];
  currentFolder: string;
  onPick: (path: string) => void;
  onClose: () => void;
}> = ({ open, folders, currentFolder, onPick, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, { open, onEscape: onClose });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/50 p-0 sm:p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-xs max-h-[80vh] flex flex-col rounded-t-2xl sm:rounded-xl bg-white shadow-2xl"
      >
        <h2 id="move-title" className="px-4 pt-4 pb-2 text-base font-bold text-slate-900">
          Move to
        </h2>
        <div className="flex-1 overflow-y-auto px-2 pb-1">
          {folders
            .filter((f) => f.path.toLowerCase() !== currentFolder.toLowerCase())
            .map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => onPick(f.path)}
                className="w-full min-h-[44px] text-left px-3 py-2 text-sm text-slate-700 hover:bg-sky-50 hover:text-sky-700 rounded-lg"
              >
                <span className="truncate block">{f.name}</span>
              </button>
            ))}
        </div>
        <div className="p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-slate-100 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] sm:min-h-0 rounded-lg border border-slate-200 px-4 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

interface MessageViewerProps {
  folderPath: string;
  message: ParsedEmailMessage | null;
  isLoading: boolean;
  onToggleFlag: (uid: number, flag: 'isSeen' | 'isFlagged') => void;
  onDelete: (uid: number) => void;
  onMove: (uid: number, targetFolder: string) => void;
  onMarkSpam?: (uid: number) => void;
  /** Kind of the open folder (Trash, Junk, Drafts ...) */
  folderKind?: SpecialUseFolder;
  onRestore?: (uid: number) => void;
  onNotSpam?: (uid: number) => void;
  onEditDraft?: (message: ParsedEmailMessage) => void;
  /** Reload this message with remote images allowed. */
  onShowImages?: (uid: number) => void;
  isLoadingImages?: boolean;
  onReply: (message: ParsedEmailMessage, replyAll: boolean) => void;
  onForward: (message: ParsedEmailMessage) => void;
  folders: MailboxFolder[];
  onBackToList?: () => void;
}

export const MessageViewer: React.FC<MessageViewerProps> = ({
  folderPath,
  message,
  isLoading,
  onToggleFlag,
  onDelete,
  onMove,
  onMarkSpam,
  folderKind,
  onRestore,
  onNotSpam,
  onEditDraft,
  onShowImages,
  isLoadingImages,
  onReply,
  onForward,
  folders,
  onBackToList
}) => {
  const [showMove, setShowMove] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [viewMode, setViewMode] = useState<'html' | 'text'>('html');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const level = useToolbarLevel(toolbarRef, !!message && !isLoading);
  const full = level === 'full';
  const labels = level !== 'tight';

  // The mail document carries its own styles (built on the server). The frame has no scripts; it is
  // same-origin only so that we can read its height. Size it to the content: one page scroll, no inner box.
  const fitFrame = React.useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc?.documentElement) return;
    iframe.style.height = `${Math.max(60, doc.documentElement.scrollHeight)}px`;
  }, []);

  useEffect(() => {
    if (!message || viewMode !== 'html') return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    let observer: ResizeObserver | undefined;
    const attach = () => {
      fitFrame();
      const doc = iframe.contentDocument;
      if (!doc?.documentElement) return;
      observer?.disconnect();
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(fitFrame);
        observer.observe(doc.documentElement);
        if (doc.body) observer.observe(doc.body);
      }
    };
    iframe.addEventListener('load', attach);
    window.addEventListener('resize', fitFrame);
    if (iframe.contentDocument?.readyState === 'complete') attach();
    return () => {
      iframe.removeEventListener('load', attach);
      window.removeEventListener('resize', fitFrame);
      observer?.disconnect();
    };
  }, [message, viewMode, fitFrame]);

  const formatFileSize = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const getAttachmentIcon = (att: EmailAttachment) => {
    const type = att.contentType.toLowerCase();
    if (type.includes('pdf')) return <FileText className="w-5 h-5 text-red-500" />;
    if (type.includes('image')) return <ImageIcon className="w-5 h-5 text-emerald-500" />;
    if (type.includes('zip') || type.includes('tar') || type.includes('archive')) {
      return <FileArchive className="w-5 h-5 text-amber-500" />;
    }
    return <File className="w-5 h-5 text-sky-500" />;
  };

  const handlePrint = () => {
    window.print();
  };

  if (isLoading) {
    return (
      <section aria-label="Message" className="flex-1 bg-white flex flex-col items-center justify-center text-slate-400 gap-3 relative" role="status">
        {onBackToList && (
          <button
            onClick={onBackToList}
            aria-label="Back to message list"
            className={`absolute top-1 left-1 p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors md:hidden ${TOUCH}`}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <div className="w-8 h-8 rounded-full border-2 border-sky-500 border-t-transparent animate-spin" />
        <span className="text-xs font-medium">Loading message contents...</span>
      </section>
    );
  }

  if (!message) {
    return (
      <section aria-label="Message" className="flex-1 bg-slate-50/50 flex flex-col items-center justify-center p-8 text-center select-none relative">
        {onBackToList && (
          <button
            onClick={onBackToList}
            aria-label="Back to message list"
            className={`absolute top-1 left-1 p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors md:hidden ${TOUCH}`}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400 mb-4 shadow-inner">
          <Mail className="w-8 h-8 stroke-1" />
        </div>
        <h3 className="text-base font-bold text-slate-700 mb-1">Select an email</h3>
        <p className="text-xs text-slate-400 max-w-xs">
          Choose a message from the list to preview details, inspect attachments, or compose replies.
        </p>
      </section>
    );
  }

  const formattedDate = (() => {
    try {
      return format(new Date(message.date), 'EEEE, MMMM d, yyyy · h:mm a');
    } catch {
      return message.date;
    }
  })();

  const archiveFolder = folders.find((f) => f.specialUse === 'Archive');
  const ctx =
    folderKind === 'Trash' && onRestore
      ? { label: 'Restore to Inbox', short: 'Restore', run: () => onRestore(message.uid), icon: Undo2, tone: 'text-sky-700 hover:bg-sky-50 border-sky-200/60' }
      : folderKind === 'Junk' && onNotSpam
      ? { label: 'Not spam: move back to Inbox', short: 'Not spam', run: () => onNotSpam(message.uid), icon: ShieldCheck, tone: 'text-emerald-700 hover:bg-emerald-50 border-emerald-200/60' }
      : folderKind === 'Drafts' && onEditDraft
      ? { label: 'Continue writing this draft', short: 'Edit draft', run: () => onEditDraft(message), icon: Pencil, tone: 'text-sky-700 hover:bg-sky-50 border-sky-200/60' }
      : null;
  const contextAction = ctx ? (
    <button
      onClick={ctx.run}
      title={ctx.label}
      className={`flex items-center gap-1 px-2 py-1 min-h-8 text-xs rounded-lg transition-colors border shrink-0 whitespace-nowrap ${ctx.tone}`}
    >
      <ctx.icon className="w-3.5 h-3.5" />
      <span className="hidden md:inline font-medium">{ctx.short}</span>
      <span className="sr-only md:hidden">{ctx.short}</span>
    </button>
  ) : null;
  const contextActionWide = ctx ? (
    <button
      onClick={ctx.run}
      className={`flex items-center gap-2 px-3 min-h-[44px] text-sm font-medium rounded-lg transition-colors border ${ctx.tone}`}
    >
      <ctx.icon className="w-4 h-4" />
      <span>{ctx.short}</span>
    </button>
  ) : null;

  const moreItems: MenuItem[] = [
    {
      key: 'unread',
      label: 'Mark as unread',
      icon: <Mail className="w-4 h-4" />,
      onSelect: () => onToggleFlag(message.uid, 'isSeen')
    },
    {
      key: 'star',
      label: message.isFlagged ? 'Remove star' : 'Add star',
      icon: <Star className={`w-4 h-4 ${message.isFlagged ? 'text-amber-500 fill-amber-500' : ''}`} />,
      onSelect: () => onToggleFlag(message.uid, 'isFlagged')
    }
  ];
  if (archiveFolder && folderKind !== 'Archive') {
    moreItems.push({
      key: 'archive',
      label: 'Archive',
      icon: <Archive className="w-4 h-4" />,
      onSelect: () => onMove(message.uid, archiveFolder.path)
    });
  }
  if (onMarkSpam && folderKind !== 'Junk' && folderKind !== 'Drafts') {
    moreItems.push({
      key: 'spam',
      label: 'Mark as spam',
      icon: <ShieldAlert className="w-4 h-4 text-amber-600" />,
      onSelect: () => onMarkSpam(message.uid)
    });
  }
  if (message.html && message.text) {
    moreItems.push({
      key: 'format',
      label: viewMode === 'html' ? 'View as plain text' : 'View as HTML',
      icon: <FileText className="w-4 h-4" />,
      onSelect: () => setViewMode(viewMode === 'html' ? 'text' : 'html')
    });
  }
  moreItems.push({ key: 'print', label: 'Print', icon: <Printer className="w-4 h-4" />, onSelect: handlePrint });

  return (
    <section aria-labelledby="message-subject" className="flex-1 min-w-0 bg-white flex flex-col h-full overflow-hidden">
      {/* Top Action Toolbar: on a phone only the main actions show; the rest are under "More" */}
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Message actions"
        className="px-1 sm:px-6 py-1 sm:py-2.5 border-b border-slate-100 flex items-center justify-between bg-white shrink-0"
      >
        <div className="flex items-center gap-0 sm:gap-1 min-w-0 flex-nowrap">
          {onBackToList && (
            <button
              onClick={onBackToList}
              title="Back to list"
              aria-label="Back to message list"
              className={`text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors md:hidden sm:mr-1 ${TOUCH}`}
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={() => onReply(message, false)}
            title="Reply"
            aria-label="Reply"
            className={`gap-1.5 px-2 sm:px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors ${TOUCH}`}
          >
            <Reply className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            <span className={labels ? 'hidden sm:inline' : 'hidden'}>Reply</span>
          </button>
          <button
            onClick={() => onReply(message, true)}
            title="Reply All"
            aria-label="Reply all"
            className={`gap-1.5 px-2 sm:px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors ${TOUCH}`}
          >
            <ReplyAll className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            <span className={labels ? 'hidden sm:inline' : 'hidden'}>Reply All</span>
          </button>
          <button
            onClick={() => onForward(message)}
            title="Forward"
            aria-label="Forward"
            className={`gap-1.5 px-2 sm:px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors ${TOUCH}`}
          >
            <Forward className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            <span className={labels ? 'hidden sm:inline' : 'hidden'}>Forward</span>
          </button>

          <div className="hidden sm:block h-4 w-[1px] bg-slate-200 mx-1.5 shrink-0" />

          <button
            onClick={() => setShowMove(true)}
            aria-haspopup="dialog"
            className={`gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors ${TOUCH}`}
            title="Move to folder"
            aria-label="Move to folder"
          >
            <FolderInput className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            <ChevronDown className={`w-3 h-3 text-slate-400 ${labels ? 'hidden sm:block' : 'hidden'}`} />
          </button>

          <button
            onClick={() => onDelete(message.uid)}
            title={folderKind === 'Trash' ? 'Delete forever' : 'Move to Trash'}
            aria-label={folderKind === 'Trash' ? 'Delete forever' : 'Move to Trash'}
            className={`p-1.5 text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors sm:order-last ${TOUCH}`}
          >
            <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
          </button>

          {/* Wider screens: the rest of the actions stay on the toolbar */}
          <div className={full ? 'hidden sm:contents' : 'hidden'}>
            <button
              onClick={() => onToggleFlag(message.uid, 'isSeen')}
              title="Mark as unread"
              aria-label="Mark as unread"
              className={`p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors ${SMALL_BTN}`}
            >
              <Mail className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onToggleFlag(message.uid, 'isFlagged')}
              title={message.isFlagged ? 'Unstar' : 'Star'}
              aria-label={message.isFlagged ? 'Unstar' : 'Star'}
              aria-pressed={!!message.isFlagged}
              className={`p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors ${SMALL_BTN}`}
            >
              <Star
                className={`w-3.5 h-3.5 ${
                  message.isFlagged ? 'text-amber-500 fill-amber-500' : 'text-slate-400'
                }`}
              />
            </button>
            {contextAction}
            {onMarkSpam && folderKind !== 'Junk' && folderKind !== 'Drafts' && (
              <button
                onClick={() => onMarkSpam(message.uid)}
                title="Mark as Spam / Move to Junk"
                className="flex items-center gap-1 px-2 py-1 min-h-8 text-xs text-amber-700 hover:bg-amber-50 rounded-lg transition-colors border border-amber-200/50 shrink-0 whitespace-nowrap"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
                <span className="hidden md:inline font-medium">Spam</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className={full ? 'hidden sm:flex items-center gap-2' : 'hidden'}>
            {message.html && message.text && (
              <div role="group" aria-label="Message format" className="flex items-center bg-slate-100 p-0.5 rounded-lg text-[11px] font-medium text-slate-600">
                <button
                  onClick={() => setViewMode('html')}
                  aria-pressed={viewMode === 'html'}
                  className={`px-2 py-0.5 rounded ${
                    viewMode === 'html' ? 'bg-white shadow-sm font-semibold text-sky-700' : ''
                  }`}
                >
                  HTML
                </button>
                <button
                  onClick={() => setViewMode('text')}
                  aria-pressed={viewMode === 'text'}
                  className={`px-2 py-0.5 rounded ${
                    viewMode === 'text' ? 'bg-white shadow-sm font-semibold text-sky-700' : ''
                  }`}
                >
                  Plain Text
                </button>
              </div>
            )}
            <button
              onClick={handlePrint}
              title="Print message"
              aria-label="Print message"
              className={`p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors ${SMALL_BTN}`}
            >
              <Printer className="w-3.5 h-3.5" />
            </button>
          </div>
          <MoreMenu items={moreItems} always={!full} />
        </div>
      </div>

      {/* Phone: the one action this folder is mostly for (Restore, Not spam, Edit draft) */}
      {contextAction && (
        <div className={`${full ? 'sm:hidden' : ''} px-3 py-1 border-b border-slate-100 flex items-center gap-2 bg-white shrink-0`}>
          {contextActionWide}
        </div>
      )}

      <MoveDialog
        open={showMove}
        folders={folders}
        currentFolder={folderPath}
        onClose={() => setShowMove(false)}
        onPick={(path) => {
          setShowMove(false);
          onMove(message.uid, path);
        }}
      />

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 sm:px-8 py-4 sm:py-6 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {/* Subject Header */}
        <h2 id="message-subject" className="text-lg sm:text-xl font-bold text-slate-900 mb-4 tracking-tight leading-snug break-words">
          {message.subject || '(No subject)'}
        </h2>

        {/* Sender & Recipient Information */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between pb-4 border-b border-slate-100 mb-6 gap-2 sm:gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-sky-500 to-indigo-600 text-white font-bold text-sm flex items-center justify-center shrink-0 shadow-sm">
              {(message.from.name || message.from.address || '?').charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="font-bold text-sm text-slate-900 break-words">
                  {message.from.name || message.from.address}
                </span>
                <span className="text-xs text-slate-400 break-all">&lt;{message.from.address}&gt;</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 mt-0.5">
                <span>to</span>
                <span className="font-medium text-slate-700 break-words min-w-0">
                  {message.to.map((t) => t.name || t.address).join(', ')}
                </span>
                {(message.cc && message.cc.length > 0) || (message.bcc && message.bcc.length > 0) ? (
                  <button
                    onClick={() => setShowDetails(!showDetails)}
                    aria-expanded={showDetails}
                    className="text-sky-600 hover:underline text-[11px] ml-1 font-medium min-h-[44px] sm:min-h-0 px-1"
                  >
                    {showDetails ? 'Hide details' : 'Show details'}
                  </button>
                ) : null}
              </div>
              {showDetails && (
                <div className="mt-2 text-xs text-slate-500 bg-slate-50 p-2.5 rounded-lg border border-slate-200/60 space-y-1 break-words">
                  <div>
                    <span className="font-semibold text-slate-600">From:</span> {message.from.name}{' '}
                    &lt;{message.from.address}&gt;
                  </div>
                  <div>
                    <span className="font-semibold text-slate-600">To:</span>{' '}
                    {message.to.map((t) => `${t.name || ''} <${t.address}>`).join(', ')}
                  </div>
                  {message.cc && message.cc.length > 0 && (
                    <div>
                      <span className="font-semibold text-slate-600">Cc:</span>{' '}
                      {message.cc.map((t) => `${t.name || ''} <${t.address}>`).join(', ')}
                    </div>
                  )}
                  {message.bcc && message.bcc.length > 0 && (
                    <div>
                      <span className="font-semibold text-slate-600">Bcc:</span>{' '}
                      {message.bcc.map((t) => `${t.name || ''} <${t.address}>`).join(', ')}
                    </div>
                  )}
                  <div>
                    <span className="font-semibold text-slate-600">Date:</span> {formattedDate}
                  </div>
                </div>
              )}
            </div>
          </div>
          <span className="text-xs text-slate-400 font-medium shrink-0 pt-1">{formattedDate}</span>
        </div>

        {/* Attachments Section */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mb-6 p-4 bg-slate-50 rounded-xl border border-slate-200/80">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                Attachments ({message.attachments.length})
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {message.attachments.map((att) => {
                const downloadUrl = api.getAttachmentUrl(folderPath, message.uid, att.partId);
                return (
                  <a
                    key={att.partId}
                    href={downloadUrl}
                    download
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Download ${att.filename}, ${formatFileSize(att.size)}`}
                    className="flex items-center gap-3 p-3 min-h-[44px] bg-white rounded-lg border border-slate-200 hover:border-sky-300 hover:shadow-sm transition-all group"
                  >
                    <div className="p-2 bg-slate-50 rounded-lg group-hover:bg-sky-50 transition-colors">
                      {getAttachmentIcon(att)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-slate-800 truncate group-hover:text-sky-600 transition-colors">
                        {att.filename}
                      </div>
                      <div className="text-[11px] text-slate-400">{formatFileSize(att.size)}</div>
                    </div>
                    <Download className="w-4 h-4 text-slate-300 group-hover:text-sky-600 shrink-0 transition-colors" />
                  </a>
                );
              })}
            </div>
          </div>
        )}

        {/* Email Body */}
        <div className="email-body">
          {viewMode === 'html' && message.html && (message.blockedImages || 0) > 0 && onShowImages && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <ImageOff className="w-4 h-4 shrink-0" />
              <span className="flex-1">Images hidden to protect your privacy.</span>
              <button
                onClick={() => onShowImages(message.uid)}
                disabled={isLoadingImages}
                className="font-semibold text-sky-700 underline hover:text-sky-900 disabled:opacity-50 min-h-[44px] sm:min-h-0 px-1"
              >
                {isLoadingImages ? 'Loading...' : 'Show images'}
              </button>
            </div>
          )}
          {viewMode === 'html' && message.html ? (
            <iframe
              key={`${message.uid}-${message.blockedImages || 0}`}
              ref={iframeRef}
              title="Email body"
              srcDoc={message.html}
              sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              scrolling="no"
              className="w-full border-0 block"
              style={{ height: '120px' }}
            />
          ) : (
            <div className="whitespace-pre-wrap break-words font-sans text-sm text-slate-800 leading-relaxed bg-slate-50/40 p-4 rounded-xl border border-slate-100">
              {message.text || 'No text content available for this message.'}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
