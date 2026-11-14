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
  Archive,
  Clock,
  Tag,
  ChevronUp,
  AlertTriangle
} from 'lucide-react';
import { format } from 'date-fns';
import type { ParsedEmailMessage, MailboxFolder, EmailAttachment, SpecialUseFolder } from '../types.js';
import { api } from '../services/api.js';
import { useDialog } from '../hooks/useDialog.js';
import { avatarClass, initialsOf } from '../services/avatar.js';
import type { Label, LabelColour } from '../services/labels.js';
import { labelStates } from '../services/labels.js';
import type { ThreadInfo } from '../services/threads.js';
import type { BounceInfo } from '../types.js';
import { LabelChip } from './LabelChip.js';
import { LabelMenu } from './LabelMenu.js';
import { SnoozeMenu } from './SnoozeMenu.js';
import { ThreadView } from './ThreadView.js';
import { SkeletonReader } from './Skeleton.js';
import { KeyHint } from './KeyHint.js';

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
        className={`p-1.5 text-ink-2 hover:bg-hover rounded transition-colors ${TOUCH}`}
      >
        <MoreHorizontal className="w-5 h-5" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More actions"
          className="absolute right-0 mt-1 w-56 max-w-[calc(100vw-1rem)] bg-surface rounded shadow-xl border border-line py-1.5 z-30"
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
              className="w-full min-h-[44px] text-left px-3 py-2 text-sm font-semibold text-ink-2 hover:bg-sel hover:text-sel-ink flex items-center gap-3"
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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-scrim anim-scrim p-0 sm:p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-title"
        onClick={(e) => e.stopPropagation()}
        className="anim-dialog w-full sm:max-w-xs max-h-[80vh] flex flex-col rounded-t sm:rounded bg-surface shadow-2xl"
      >
        <h2 id="move-title" className="px-4 pt-4 pb-2 text-base font-extrabold text-ink">
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
                className="w-full min-h-[44px] text-left px-3 py-2 text-sm font-semibold text-ink-2 hover:bg-sel hover:text-sel-ink rounded"
              >
                <span className="truncate block">{f.name}</span>
              </button>
            ))}
        </div>
        <div className="p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-line flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] sm:min-h-0 rounded border border-line-2 px-4 py-1.5 text-xs font-bold text-ink-2 hover:bg-hover"
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
  /** One-click archive (hidden when there is no Archive folder or this is it). */
  onArchive?: (uid: number) => void;
  /** Snooze until a time (menu opened with H). */
  onSnooze?: (uid: number, until: Date) => void;
  labels?: Label[];
  /** Label ids on the open message (from its list row). */
  messageLabelIds?: string[];
  onToggleLabel?: (labelId: string, turnOn: boolean) => void;
  onCreateLabel?: (name: string, colour: LabelColour) => void;
  /** Which toolbar menu is open (controlled, so L and H can open them). */
  menu?: 'label' | 'snooze' | null;
  onMenuChange?: (m: 'label' | 'snooze' | null) => void;
  /** "3 of 120" with Newer and Older. */
  position?: { index: number; total: number } | null;
  onNewer?: () => void;
  onOlder?: () => void;
  thread?: ThreadInfo | null;
  /** Set when this message is a "not delivered" report. */
  bounce?: BounceInfo;
  onRetryBounce?: () => void;
  myAddress?: string;
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
  onBackToList,
  onArchive,
  onSnooze,
  labels: labelList = [],
  messageLabelIds = [],
  onToggleLabel,
  onCreateLabel,
  menu = null,
  onMenuChange,
  position,
  onNewer,
  onOlder,
  thread,
  bounce,
  onRetryBounce,
  myAddress
}) => {
  const [showMove, setShowMove] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [viewMode, setViewMode] = useState<'html' | 'text'>('html');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const level = useToolbarLevel(toolbarRef, !!message && !isLoading);
  const full = level === 'full';
  const labels = level !== 'tight';
  const labels_ = labels;

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

  // A small "file" badge: the extension on a cut-corner tile, coloured by kind.
  const attachmentBadge = (att: EmailAttachment) => {
    const type = att.contentType.toLowerCase();
    const ext = (att.filename.split('.').pop() || '').slice(0, 4).toUpperCase();
    const label = ext && ext.length <= 4 && att.filename.includes('.') ? ext : 'FILE';
    const tone =
      type.includes('pdf') ? 'bg-av4' : type.includes('image') ? 'bg-av3' : /zip|tar|archive/.test(type) ? 'bg-av5' : /sheet|csv|excel/.test(type) ? 'bg-av2' : 'bg-av1';
    return (
      <span
        aria-hidden="true"
        className={`cut-file w-8 h-[38px] shrink-0 grid place-items-end justify-center pb-[5px] text-[9.5px] font-extrabold text-white ${tone}`}
      >
        {label}
      </span>
    );
  };

  const handlePrint = () => {
    window.print();
  };

  if (isLoading) {
    return (
      <section aria-label="Message" className="flex-1 bg-sheet flex flex-col relative" aria-busy="true">
        {onBackToList && (
          <button
            onClick={onBackToList}
            aria-label="Back to message list"
            className={`m-1 p-1.5 text-ink-2 hover:text-ink hover:bg-hover rounded transition-colors md:hidden ${TOUCH}`}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <SkeletonReader />
      </section>
    );
  }

  if (!message) {
    return (
      <section aria-label="Message" className="flex-1 bg-sheet flex flex-col items-center justify-center p-8 text-center select-none relative">
        {onBackToList && (
          <button
            onClick={onBackToList}
            aria-label="Back to message list"
            className={`absolute top-1 left-1 p-1.5 text-ink-2 hover:text-ink hover:bg-hover rounded transition-colors md:hidden ${TOUCH}`}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <Mail className="w-10 h-10 stroke-[1.4] text-ink-3 mb-3" aria-hidden="true" />
        <h3 className="text-base font-extrabold text-ink mb-1">Select an email</h3>
        <p className="text-[13px] text-ink-2 max-w-[30ch]">
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
      ? { label: 'Restore to Inbox', short: 'Restore', run: () => onRestore(message.uid), icon: Undo2, tone: 'text-sel-ink hover:bg-sel border-line-2' }
      : folderKind === 'Junk' && onNotSpam
      ? { label: 'Not spam: move back to Inbox', short: 'Not spam', run: () => onNotSpam(message.uid), icon: ShieldCheck, tone: 'text-ok-ink hover:bg-toast-bg border-line' }
      : folderKind === 'Drafts' && onEditDraft
      ? { label: 'Continue writing this draft', short: 'Edit draft', run: () => onEditDraft(message), icon: Pencil, tone: 'text-sel-ink hover:bg-sel border-line-2' }
      : null;
  const contextAction = ctx ? (
    <button
      onClick={ctx.run}
      title={ctx.label}
      className={`flex items-center gap-1 px-2 py-1 min-h-8 text-xs rounded transition-colors border shrink-0 whitespace-nowrap ${ctx.tone}`}
    >
      <ctx.icon className="w-3.5 h-3.5" />
      <span className="hidden md:inline font-medium">{ctx.short}</span>
      <span className="sr-only md:hidden">{ctx.short}</span>
    </button>
  ) : null;
  const contextActionWide = ctx ? (
    <button
      onClick={ctx.run}
      className={`flex items-center gap-2 px-3 min-h-[44px] text-sm font-medium rounded transition-colors border ${ctx.tone}`}
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
      icon: <Star className={`w-4 h-4 ${message.isFlagged ? 'text-star-line fill-star' : ''}`} />,
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
      icon: <ShieldAlert className="w-4 h-4 text-caution" />,
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
  if (onSnooze) {
    moreItems.unshift({ key: 'snooze', label: 'Snooze', icon: <Clock className="w-4 h-4" />, onSelect: () => onMenuChange?.('snooze') });
  }
  if (onToggleLabel) {
    moreItems.unshift({ key: 'label', label: 'Label', icon: <Tag className="w-4 h-4" />, onSelect: () => onMenuChange?.('label') });
  }
  moreItems.push({ key: 'print', label: 'Print', icon: <Printer className="w-4 h-4" />, onSelect: handlePrint });

  return (
    <section aria-labelledby="message-subject" className="flex-1 min-w-0 bg-sheet flex flex-col h-full overflow-hidden">
      {/* Top Action Toolbar: on a phone only the main actions show; the rest are under "More" */}
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Message actions"
        className="px-1 sm:px-5 py-1 sm:py-0 sm:min-h-[56px] border-b border-line flex items-center justify-between bg-sheet shrink-0"
      >
        <div className="flex items-center gap-0 sm:gap-1 min-w-0 flex-nowrap">
          {onBackToList && (
            <button
              onClick={onBackToList}
              title="Back to list"
              aria-label="Back to message list"
              className={`text-[13px] font-bold text-ink-2 hover:bg-hover rounded transition-colors md:hidden sm:mr-1 ${TOUCH}`}
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={() => onReply(message, false)}
            title="Reply"
            aria-label="Reply"
            className={`gap-1.5 px-2 sm:px-3 py-1.5 text-[13px] font-bold text-ink-2 hover:bg-hover rounded transition-colors ${TOUCH}`}
          >
            <Reply className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            <span className={labels ? 'hidden sm:inline' : 'hidden'}>Reply</span>
          </button>
          <button
            onClick={() => onReply(message, true)}
            title="Reply All"
            aria-label="Reply all"
            className={`gap-1.5 px-2 sm:px-3 py-1.5 text-[13px] font-bold text-ink-2 hover:bg-hover rounded transition-colors ${TOUCH}`}
          >
            <ReplyAll className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            <span className={labels ? 'hidden sm:inline' : 'hidden'}>Reply All</span>
          </button>
          <button
            onClick={() => onForward(message)}
            title="Forward"
            aria-label="Forward"
            className={`gap-1.5 px-2 sm:px-3 py-1.5 text-[13px] font-bold text-ink-2 hover:bg-hover rounded transition-colors ${TOUCH}`}
          >
            <Forward className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            <span className={labels ? 'hidden sm:inline' : 'hidden'}>Forward</span>
          </button>

          <div className="hidden sm:block h-4 w-px bg-line-2 mx-1.5 shrink-0" />

          {onArchive && archiveFolder && folderKind !== 'Archive' && (
            <button
              onClick={() => onArchive(message.uid)}
              title="Archive (E)"
              aria-label="Archive"
              aria-keyshortcuts="E"
              className={`gap-1.5 px-2 sm:px-3 py-1.5 text-[13px] font-bold text-ink-2 hover:bg-hover rounded transition-colors ${TOUCH}`}
            >
              <Archive className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
              <span className={labels_ ? 'hidden sm:inline' : 'hidden'}>Archive</span>
              <KeyHint keys="E" className={labels_ ? '' : '!hidden'} />
            </button>
          )}
          {onSnooze && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onMenuChange?.(menu === 'snooze' ? null : 'snooze')}
              aria-haspopup="dialog"
              aria-expanded={menu === 'snooze'}
              aria-keyshortcuts="H"
              title="Snooze (H)"
              aria-label="Snooze"
              className={`max-sm:hidden gap-1.5 px-2 sm:px-3 py-1.5 text-[13px] font-bold text-ink-2 hover:bg-hover rounded transition-colors ${TOUCH}`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span className={labels_ ? 'hidden sm:inline' : 'hidden'}>Snooze</span>
              <KeyHint keys="H" className={labels_ ? '' : '!hidden'} />
            </button>
          )}
          {onToggleLabel && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onMenuChange?.(menu === 'label' ? null : 'label')}
              aria-haspopup="dialog"
              aria-expanded={menu === 'label'}
              aria-keyshortcuts="L"
              title="Label (L)"
              aria-label="Label"
              className={`max-sm:hidden gap-1.5 px-2 sm:px-3 py-1.5 text-[13px] font-bold text-ink-2 hover:bg-hover rounded transition-colors ${TOUCH}`}
            >
              <Tag className="w-3.5 h-3.5" />
              <span className={labels_ ? 'hidden sm:inline' : 'hidden'}>Label</span>
              <KeyHint keys="L" className={labels_ ? '' : '!hidden'} />
            </button>
          )}

          <button
            onClick={() => setShowMove(true)}
            aria-haspopup="dialog"
            className={`gap-1 px-2.5 py-1.5 text-[13px] font-bold text-ink-2 hover:bg-hover rounded transition-colors ${TOUCH}`}
            title="Move to folder"
            aria-label="Move to folder"
          >
            <FolderInput className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            <ChevronDown className={`w-3 h-3 text-ink-3 ${labels ? 'hidden sm:block' : 'hidden'}`} />
          </button>

          <button
            onClick={() => onDelete(message.uid)}
            title={folderKind === 'Trash' ? 'Delete forever' : 'Move to Trash'}
            aria-label={folderKind === 'Trash' ? 'Delete forever' : 'Move to Trash'}
            className={`p-1.5 text-ink-2 hover:text-warn-ink hover:bg-warn-bg rounded transition-colors sm:order-last ${TOUCH}`}
          >
            <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
          </button>

          {/* Wider screens: the rest of the actions stay on the toolbar */}
          <div className={full ? 'hidden sm:contents' : 'hidden'}>
            <button
              onClick={() => onToggleFlag(message.uid, 'isSeen')}
              title="Mark as unread"
              aria-label="Mark as unread"
              className={`p-1.5 text-ink-2 hover:bg-hover rounded transition-colors ${SMALL_BTN}`}
            >
              <Mail className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onToggleFlag(message.uid, 'isFlagged')}
              title={message.isFlagged ? 'Unstar' : 'Star'}
              aria-label={message.isFlagged ? 'Unstar' : 'Star'}
              aria-pressed={!!message.isFlagged}
              className={`p-1.5 text-ink-2 hover:bg-hover rounded transition-colors ${SMALL_BTN}`}
            >
              <Star
                className={`w-3.5 h-3.5 ${
                  message.isFlagged ? 'text-star-line fill-star' : 'text-ink-3'
                }`}
              />
            </button>
            {contextAction}
            {onMarkSpam && folderKind !== 'Junk' && folderKind !== 'Drafts' && (
              <button
                onClick={() => onMarkSpam(message.uid)}
                title="Mark as Spam / Move to Junk"
                className="flex items-center gap-1 px-2 py-1 min-h-8 text-[13px] text-caution hover:bg-caution-bg rounded transition-colors border border-caution-line shrink-0 whitespace-nowrap"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-caution" />
                <span className="hidden md:inline font-bold">Spam</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className={full ? 'hidden sm:flex items-center gap-2' : 'hidden'}>
            {message.html && message.text && (
              <div role="group" aria-label="Message format" className="flex items-center bg-surface border border-line p-0.5 rounded text-xs font-bold text-ink-2">
                <button
                  onClick={() => setViewMode('html')}
                  aria-pressed={viewMode === 'html'}
                  className={`px-2 py-0.5 rounded-[3px] ${
                    viewMode === 'html' ? 'bg-act text-act-ink' : ''
                  }`}
                >
                  HTML
                </button>
                <button
                  onClick={() => setViewMode('text')}
                  aria-pressed={viewMode === 'text'}
                  className={`px-2 py-0.5 rounded-[3px] ${
                    viewMode === 'text' ? 'bg-act text-act-ink' : ''
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
              className={`p-1.5 text-ink-3 hover:text-ink-2 hover:bg-hover rounded transition-colors ${SMALL_BTN}`}
            >
              <Printer className="w-3.5 h-3.5" />
            </button>
          </div>
          {position && (
            <div className="hidden sm:flex items-center gap-0.5 text-[12.5px] font-semibold text-ink-3" role="group" aria-label="Position in the list">
              <span aria-live="polite" className="mr-1 whitespace-nowrap">
                {position.index} of {position.total}
              </span>
              <button
                type="button"
                onClick={onNewer}
                disabled={!onNewer || position.index <= 1}
                aria-label="Newer message"
                aria-keyshortcuts="K"
                title="Newer (K)"
                className="t-fast min-h-8 min-w-8 grid place-items-center rounded hover:bg-hover text-ink-2 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <ChevronUp className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={onOlder}
                disabled={!onOlder || position.index >= position.total}
                aria-label="Older message"
                aria-keyshortcuts="J"
                title="Older (J)"
                className="t-fast min-h-8 min-w-8 grid place-items-center rounded hover:bg-hover text-ink-2 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
          )}
          <div className="relative shrink-0">
            <MoreMenu items={moreItems} always={!full} />
            {menu === 'snooze' && onSnooze && (
              <SnoozeMenu
                className="right-0 top-full mt-1 origin-tr"
                onClose={() => onMenuChange?.(null)}
                onPick={(until) => {
                  onMenuChange?.(null);
                  onSnooze(message.uid, until);
                }}
              />
            )}
            {menu === 'label' && onToggleLabel && onCreateLabel && (
              <LabelMenu
                className="right-0 top-full mt-1 origin-tr"
                labels={labelList}
                states={labelStates(labelList, [{ labels: messageLabelIds }])}
                onToggle={onToggleLabel}
                onCreate={onCreateLabel}
                onClose={() => onMenuChange?.(null)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Phone: the one action this folder is mostly for (Restore, Not spam, Edit draft) */}
      {contextAction && (
        <div className={`${full ? 'sm:hidden' : ''} px-3 py-1 border-b border-line flex items-center gap-2 bg-sheet shrink-0`}>
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
      <div key={message.uid} className="anim-rise flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 sm:px-10 py-4 sm:py-6 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {/* Subject Header */}
        <h2 id="message-subject" className="text-[21px] sm:text-[26px] font-extrabold text-ink mb-4 sm:mb-5 tracking-tight leading-tight break-words">
          {message.subject || '(No subject)'}
        </h2>

        {messageLabelIds.length > 0 && (
          <div className="flex flex-wrap gap-1.5 -mt-2 sm:-mt-3 mb-4" aria-label="Labels">
            {messageLabelIds
              .map((id) => labelList.find((l) => l.id === id))
              .filter((l): l is Label => !!l)
              .map((l) => (
                <LabelChip key={l.id} label={l} />
              ))}
          </div>
        )}

        {thread && <ThreadView part="before" info={thread} current={{ mailbox: folderPath, uid: message.uid }} myAddress={myAddress} />}

        <div className="bg-surface border border-line p-4 sm:px-6 sm:py-5">
          {bounce && (
            <div role="alert" className="mb-4 flex items-start gap-3 rounded border border-warn-line bg-warn-bg p-3 text-[13.5px] text-ink">
              <AlertTriangle className="w-5 h-5 shrink-0 text-warn-ink mt-0.5" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <b className="block text-warn-ink">Your message was not delivered</b>
                <p className="text-ink-2 mt-0.5">
                  &quot;{bounce.originalSubject}&quot; could not be sent to {bounce.recipient}. {bounce.reason}
                </p>
              </div>
              {onRetryBounce && (
                <button
                  type="button"
                  onClick={onRetryBounce}
                  className="cut-tr shrink-0 self-center bg-act hover:bg-act-hov text-act-ink font-extrabold text-[13px] px-3.5 min-h-[44px] sm:min-h-[36px]"
                >
                  Try again
                </button>
              )}
            </div>
          )}
        {/* Sender & Recipient Information */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between pb-4 border-b border-line mb-5 gap-2 sm:gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div
              aria-hidden="true"
              className={`cut-av w-10 h-10 text-white font-extrabold text-sm flex items-center justify-center shrink-0 ${avatarClass(
                message.from.address || message.from.name || '?'
              )}`}
            >
              {initialsOf(message.from.name || message.from.address || '?')}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="font-extrabold text-[15px] text-ink break-words">
                  {message.from.name || message.from.address}
                </span>
                <span className="text-[13px] text-ink-3 break-all">&lt;{message.from.address}&gt;</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-3 mt-0.5">
                <span>to</span>
                <span className="font-semibold text-ink-2 break-words min-w-0">
                  {message.to.map((t) => t.name || t.address).join(', ')}
                </span>
                {(message.cc && message.cc.length > 0) || (message.bcc && message.bcc.length > 0) ? (
                  <button
                    onClick={() => setShowDetails(!showDetails)}
                    aria-expanded={showDetails}
                    className="text-act hover:underline text-xs ml-1 font-bold min-h-[44px] sm:min-h-0 px-1"
                  >
                    {showDetails ? 'Hide details' : 'Show details'}
                  </button>
                ) : null}
              </div>
              {showDetails && (
                <div className="mt-2 text-xs text-ink-3 bg-sheet p-2.5 rounded border border-line space-y-1 break-words">
                  <div>
                    <span className="font-bold text-ink-2">From:</span> {message.from.name}{' '}
                    &lt;{message.from.address}&gt;
                  </div>
                  <div>
                    <span className="font-bold text-ink-2">To:</span>{' '}
                    {message.to.map((t) => `${t.name || ''} <${t.address}>`).join(', ')}
                  </div>
                  {message.cc && message.cc.length > 0 && (
                    <div>
                      <span className="font-bold text-ink-2">Cc:</span>{' '}
                      {message.cc.map((t) => `${t.name || ''} <${t.address}>`).join(', ')}
                    </div>
                  )}
                  {message.bcc && message.bcc.length > 0 && (
                    <div>
                      <span className="font-bold text-ink-2">Bcc:</span>{' '}
                      {message.bcc.map((t) => `${t.name || ''} <${t.address}>`).join(', ')}
                    </div>
                  )}
                  <div>
                    <span className="font-bold text-ink-2">Date:</span> {formattedDate}
                  </div>
                </div>
              )}
            </div>
          </div>
          <span className="text-[13px] text-ink-2 font-bold shrink-0 pt-1">{formattedDate}</span>
        </div>

        {/* Attachments Section */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mb-5">
            <div className="mb-2">
              <span className="text-xs font-bold text-ink-2">Attachments ({message.attachments.length})</span>
            </div>
            <div className="flex flex-wrap gap-2">
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
                    className="flex items-center gap-2.5 py-[7px] pl-[7px] pr-2.5 min-h-[44px] w-full sm:w-[244px] bg-surface rounded border border-line-2 hover:bg-hover text-ink-3 no-underline transition-colors"
                  >
                    {attachmentBadge(att)}
                    <div className="flex-1 min-w-0 grid">
                      <div className="text-[13px] font-bold text-ink truncate">{att.filename}</div>
                      <div className="text-xs">{formatFileSize(att.size)}</div>
                    </div>
                    <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
                  </a>
                );
              })}
            </div>
          </div>
        )}

        {/* Email Body */}
        <div className="email-body">
          {viewMode === 'html' && message.html && (message.blockedImages || 0) > 0 && onShowImages && (
            <div className="mb-3 flex items-center gap-2 rounded border border-caution-line bg-caution-bg px-3 py-2 text-xs text-caution">
              <ImageOff className="w-4 h-4 shrink-0" />
              <span className="flex-1">Images hidden to protect your privacy.</span>
              <button
                onClick={() => onShowImages(message.uid)}
                disabled={isLoadingImages}
                className="font-bold text-act underline hover:no-underline disabled:opacity-50 min-h-[44px] sm:min-h-0 px-1"
              >
                {isLoadingImages ? 'Loading...' : 'Show images'}
              </button>
            </div>
          )}
          {viewMode === 'html' && message.html ? (
            // The message keeps its own colours (white page), in both themes: received mail is not recoloured.
            <div className="bg-white rounded border border-line overflow-hidden">
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
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words font-sans text-[15px] text-ink leading-relaxed">
              {message.text || 'No text content available for this message.'}
            </div>
          )}
        </div>
        </div>
        {thread && <ThreadView part="after" info={thread} current={{ mailbox: folderPath, uid: message.uid }} myAddress={myAddress} />}
      </div>
    </section>
  );
};
