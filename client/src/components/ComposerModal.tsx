import { useBackLayer } from '../hooks/useBackLayer.js';
import { useOnline } from '../hooks/useOnline.js';
import { usePresence, LEAVE_COMPOSER_MS, Presence } from './Presence.js';
import { AnchoredPanel } from './AnchoredPanel.js';
import { usePopover } from '../hooks/usePopover.js';
import { readImageFile, IMAGE_TYPES, MAX_IMAGE_BYTES } from '../services/richtext.js';
import { splitRecipients, mergeRecipients, recipientSnapshot, isValidRecipient } from '../services/recipients';
import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Minus,
  Maximize2,
  Paperclip,
  Send,
  Trash2,
  AlertCircle,
  FileSpreadsheet,
  PenTool,
  Info,
  Bold,
  ImagePlus,
  MoreHorizontal,
  Type
} from 'lucide-react';
import { api, ApiError } from '../services/api.js';
import { clockTime } from '../services/time.js';
import { friendlyError } from '../services/errors.js';
import { useDialog } from '../hooks/useDialog.js';
import { findPlaceholder } from '../services/templates.js';
import { RecipientField } from './RecipientField.js';
import { TemplateSelectorModal } from './TemplateSelectorModal.js';
import type { ConfirmRequest } from './ConfirmDialog.js';
import {
  getSignatureForAccount,
  saveSignatureForAccount,
  signatureHtml,
  SIGNATURE_IMAGE_MAX_BYTES,
  type AccountSignature
} from '../services/signatures.js';
import type { Editor } from '@tiptap/react';
import { RichEditor, normalizeEditorHtml } from './RichEditor.js';
import {
  plainTextToHtml,
  htmlToPlainText,
  hasRichContent,
  isEmptyHtml,
  inlineImageBytes,
  formatBytes
} from '../services/richtext.js';

interface ComposerAttachment {
  file: File;
  filename: string;
  size: number;
}

// Largest total attachment size; the server enforces the real limit (MAIL_MAX_MESSAGE_BYTES).
const MAX_ATTACHMENT_BYTES =
  Number(import.meta.env.VITE_MAIL_MAX_MESSAGE_BYTES) > 0
    ? Number(import.meta.env.VITE_MAIL_MAX_MESSAGE_BYTES)
    : 10 * 1024 * 1024;

export interface SentInfo {
  /** Set when the mail was sent but something needs the user's attention. */
  warning?: string;
  /** Set when some recipients did not receive the mail. */
  error?: string;
  /** Who it went to, by name where known, otherwise the address (for the "Sent to ..." toast). */
  to?: string[];
}

export interface ComposerReplyMeta {
  inReplyTo?: string;
  references?: string[];
  forwardOf?: { folder: string; uid: number };
  /** Names of original attachments the server will add to a forward. */
  forwardedAttachmentNames?: string[];
  /** UID of the saved draft this composer was opened from. */
  draftUid?: number;
  /** Known names for addresses (lower case address to name), so chips can show people, not addresses. */
  names?: Record<string, string>;
}

interface ComposerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSentSuccess: (info?: SentInfo) => void;
  /**
   * The composer fills its form once, when it mounts. Give it a new React `key`
   * for every message you open so each one starts clean.
   */
  initialTo?: string[];
  initialCc?: string[];
  initialBcc?: string[];
  /**
   * Quoted original (reply) or forwarded message as editor HTML. It goes below the signature, so the
   * signature sits above the quote.
   */
  initialHtml?: string;
  /** Opened from the Drafts folder: the body is used as it is (no signature added). */
  isDraft?: boolean;
  /** Ask the user to confirm (discard / save draft). */
  requestConfirm: (request: ConfirmRequest) => void;
  initialSubject?: string;
  /** Plain-text starting body (used when no `initialHtml` is given; a plain-text draft opens in plain-text mode). */
  initialBody?: string;
  replyMeta?: ComposerReplyMeta;
  accountEmail?: string;
  accountName?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const ICON_BTN =
  't-fast shrink-0 p-2 text-ink-3 hover:text-ink hover:bg-hover rounded transition-colors min-h-[44px] min-w-[44px] sm:min-h-[36px] sm:min-w-[36px] flex items-center justify-center';

/** The "..." menu in the composer's bottom bar: Templates, Signature, Plain text. */
const ComposerMore: React.FC<{
  items: { key: string; label: string; icon: React.ReactNode; onSelect: () => void }[];
  anchor: React.RefObject<HTMLElement>;
  onClose: (refocus: boolean) => void;
}> = ({ items, anchor, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  usePopover(ref, onClose, anchor);
  return (
    <AnchoredPanel
      panelRef={ref}
      anchor={anchor}
      align="start"
      prefer="above"
      role="menu"
      aria-label="More composer options"
      className="anim-menu origin-bl w-48 bg-surface text-ink border border-line rounded shadow-xl py-1.5"
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose(false);
            it.onSelect();
          }}
          className="w-full min-h-[44px] sm:min-h-[36px] text-left px-3 py-2 text-sm font-semibold text-ink-2 hover:bg-sel hover:text-sel-ink flex items-center gap-3"
        >
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
    </AnchoredPanel>
  );
};

export const ComposerModal: React.FC<ComposerModalProps> = ({
  isOpen,
  onClose,
  onSentSuccess,
  initialTo,
  initialCc,
  initialBcc,
  isDraft = false,
  requestConfirm,
  initialSubject = '',
  initialBody = '',
  initialHtml,
  replyMeta,
  accountEmail = '',
  accountName = ''
}) => {
  const [toInput, setToInput] = useState('');
  const [toList, setToList] = useState<string[]>(() => initialTo ?? []);
  const [showCc, setShowCc] = useState((initialCc ?? []).length > 0);
  const [ccInput, setCcInput] = useState('');
  const [ccList, setCcList] = useState<string[]>(() => initialCc ?? []);
  const [showBcc, setShowBcc] = useState((initialBcc ?? []).length > 0);
  const [bccInput, setBccInput] = useState('');
  const [bccList, setBccList] = useState<string[]>(() => initialBcc ?? []);
  const [subject, setSubject] = useState(initialSubject);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  // One key per composed message: a retried request never sends twice.
  const idempotencyKey = useRef<string>(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const [isSending, setIsSending] = useState(false);
  const online = useOnline();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showFormat, setShowFormat] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const nameOf = (email: string) => replyMeta?.names?.[email.toLowerCase()] || '';
  const [showSigModal, setShowSigModal] = useState(false);
  const [signature, setSignature] = useState<AccountSignature>(() =>
    getSignatureForAccount(accountEmail, accountName)
  );
  const [sigForm, setSigForm] = useState<AccountSignature>(signature);
  const [sigError, setSigError] = useState<string | null>(null);
  // A plain-text draft reopens as plain text. Everything else starts in the rich editor.
  const [plainMode, setPlainMode] = useState(isDraft && !initialHtml);
  const [bodyText, setBodyText] = useState(() => (isDraft && !initialHtml ? initialBody : ''));
  const [bodyHtml, setBodyHtml] = useState(() => {
    if (isDraft) return initialHtml ?? '';
    const sig = signatureHtml(signature);
    const quoted = initialHtml ?? plainTextToHtml(initialBody);
    return sig || quoted ? `<p></p>${sig}${quoted}` : '';
  });
  // Changing it starts a fresh editor (templates, switching back from plain text).
  const [editorKey, setEditorKey] = useState(0);
  const initialBodyHtml = useRef<string | null>(null);
  if (initialBodyHtml.current === null) initialBodyHtml.current = bodyHtml;
  const editorRef = useRef<Editor | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const sigRef = useRef<HTMLDivElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // ---- Drafts: autosave every 10 s while there are changes ----
  const draftUidRef = useRef<number | undefined>(replyMeta?.draftUid);
  const [droppedNote, setDroppedNote] = useState<string | null>(null);
  const droppedShownRef = useRef('');
  const [draftStatus, setDraftStatus] = useState<{ text: string; error: boolean } | null>(null);
  const savingRef = useRef(false);
  const lastSaveAtRef = useRef(0);
  const sentRef = useRef(false);

  const statusText = [draftStatus?.text, attachments.length > 0 ? 'Attachments are not saved in drafts' : ''].filter(Boolean).join(' · ');

  const snapshot = () =>
    JSON.stringify({
      to: recipientSnapshot(toList, toInput),
      cc: recipientSnapshot(ccList, ccInput),
      bcc: recipientSnapshot(bccList, bccInput),
      subject,
      plain: plainMode,
      body: plainMode ? bodyText : bodyHtml
    });
  const initialSnap = useRef<string | null>(null);
  if (initialSnap.current === null) initialSnap.current = snapshot();
  const lastSavedSnap = useRef<string>(initialSnap.current);
  const hasContent = () => attachments.length > 0 || snapshot() !== initialSnap.current;

  /** Saves the draft; returns true when it is stored (or there was nothing new to store). */
  const saveDraftNow = async (): Promise<boolean> => {
    if (sentRef.current || savingRef.current) return true;
    const snap = snapshot();
    if (snap === lastSavedSnap.current) return true;
    const data = JSON.parse(snap) as { to: string[]; cc: string[]; bcc: string[]; subject: string; plain: boolean; body: string };
    savingRef.current = true;
    try {
      const res = await api.saveDraft({
        to: data.to,
        cc: data.cc,
        bcc: data.bcc,
        subject: data.subject,
        ...(data.plain ? { text: data.body } : { html: data.body, text: '' }),
        inReplyTo: replyMeta?.inReplyTo,
        references: replyMeta?.references,
        replaceUid: draftUidRef.current
      });
      if (!res.success) throw new Error('The draft could not be saved.');
      draftUidRef.current = res.uid;
      // Quiet note, once per distinct list.
      const dropped = res.droppedRecipients ?? [];
      const key = dropped.join("|");
      if (key !== droppedShownRef.current) {
        droppedShownRef.current = key;
        setDroppedNote(dropped.length > 0 ? `Not kept in the draft: ${dropped.join(', ')}` : null);
      }
      lastSavedSnap.current = snap;
      lastSaveAtRef.current = Date.now();
      setDraftStatus({ text: `Draft saved ${clockTime()}`, error: false });
      return true;
    } catch (err: unknown) {
      const tooBig = err instanceof ApiError && err.status === 413;
      setDraftStatus({
        text: tooBig
          ? 'This draft is too large to save; remove a picture.'
          : `Draft not saved. ${friendlyError(err, 'Try again in a moment.')}`,
        error: true
      });
      return false;
    } finally {
      savingRef.current = false;
    }
  };
  const bodyHtmlRef = useRef(bodyHtml);
  bodyHtmlRef.current = plainMode ? '' : bodyHtml;
  const saveDraftRef = useRef(saveDraftNow);
  saveDraftRef.current = saveDraftNow;

  useEffect(() => {
    if (!isOpen) return;
    const id = setInterval(() => {
      // With pictures every save uploads them all: at most once a minute (closing still saves at once).
      if (/<img/i.test(bodyHtmlRef.current) && Date.now() - lastSaveAtRef.current < 60000) return;
      void saveDraftRef.current();
    }, 10000);
    return () => clearInterval(id);
  }, [isOpen]);

  // Hiding the page (tab switch, app switch, close) may be the last chance: keep the draft now.
  useEffect(() => {
    if (!isOpen) return;
    const save = () => {
      if (document.visibilityState === 'hidden') void saveDraftRef.current();
    };
    document.addEventListener('visibilitychange', save);
    window.addEventListener('pagehide', save);
    return () => {
      document.removeEventListener('visibilitychange', save);
      window.removeEventListener('pagehide', save);
    };
  }, [isOpen]);

  /** Remove the saved draft (if any) and close. Stays open if the draft could not be removed. */
  const discardAndClose = async () => {
    sentRef.current = true; // no more autosaves
    if (draftUidRef.current) {
      try {
        await api.deleteDraft(draftUidRef.current);
      } catch (err: unknown) {
        sentRef.current = false;
        setErrorMsg(`The saved draft could not be deleted. ${friendlyError(err, 'Try again in a moment.')}`);
        return;
      }
    }
    onClose();
  };

  // Trash icon: discard the message (and its saved draft), after confirming when there is something to lose.
  const handleDiscard = () => {
    if (!hasContent() && !draftUidRef.current) {
      onClose();
      return;
    }
    requestConfirm({
      title: 'Discard this message?',
      message: draftUidRef.current ? 'The message and its saved draft will be deleted.' : 'What you wrote will be lost.',
      confirmLabel: 'Discard',
      danger: true,
      onConfirm: () => void discardAndClose()
    });
  };

  // X button: keep as a draft, discard, or keep editing.
  const handleCloseClick = () => {
    const unsaved = snapshot() !== lastSavedSnap.current;
    if (!unsaved && (draftUidRef.current || !hasContent())) {
      sentRef.current = true;
      onClose();
      return;
    }
    requestConfirm({
      title: 'Save this message as a draft?',
      message: attachments.length > 0 ? 'Attachments are not kept in drafts.' : 'You can continue it later from the Drafts folder.',
      confirmLabel: 'Save draft',
      alternateLabel: 'Discard',
      onConfirm: () => {
        void saveDraftNow().then((ok) => {
          if (ok) {
            sentRef.current = true;
            onClose();
          } else {
            setErrorMsg('The draft could not be saved, so the message is still open.');
          }
        });
      },
      onAlternate: () => void discardAndClose()
    });
  };

  useDialog(panelRef, {
    open: isOpen,
    onEscape: handleCloseClick, // asks what to do with the content, if there is any
    initialFocus: () =>
      toList.length === 0 ? toInputRef.current : (editorRef.current?.view.dom as HTMLElement | undefined) ?? bodyRef.current
  });

  // Phone Back asks the same as the close button (keep as draft, discard, or keep editing).
  useBackLayer(isOpen, handleCloseClick);
  useBackLayer(showSigModal, () => setShowSigModal(false));
  useBackLayer(showTemplateModal, () => setShowTemplateModal(false));

  useDialog(sigRef, { open: showSigModal, onEscape: () => setShowSigModal(false) });

  // Phone: the composer fills the visible screen (above the on-screen keyboard), so Send stays in view.
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const el = panelRef.current;
    if (!vv || !el || !isOpen) return;
    const fit = () => {
      el.style.setProperty('--vvh', `${vv.height}px`);
      el.style.setProperty('--vvtop', `${vv.offsetTop}px`);
    };
    fit();
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    return () => {
      vv.removeEventListener('resize', fit);
      vv.removeEventListener('scroll', fit);
    };
  }, [isOpen]);
  const { mounted: cmpMounted, leaving: cmpLeaving } = usePresence(isOpen, LEAVE_COMPOSER_MS);
  if (!cmpMounted) return null;

  const handleAddRecipient = (
    type: 'to' | 'cc' | 'bcc',
    value: string
  ) => {
    if (splitRecipients(value).length === 0) {
      // Only separators typed: just clear the box.
      if (value.trim()) {
        if (type === 'to') setToInput('');
        else if (type === 'cc') setCcInput('');
        else setBccInput('');
      }
      return;
    }
    if (type === 'to') {
      setToList(mergeRecipients(toList, value));
      setToInput('');
    } else if (type === 'cc') {
      setCcList(mergeRecipients(ccList, value));
      setCcInput('');
    } else {
      setBccList(mergeRecipients(bccList, value));
      setBccInput('');
    }
  };

  const handleRemoveRecipient = (type: 'to' | 'cc' | 'bcc', index: number) => {
    if (type === 'to') setToList(toList.filter((_, i) => i !== index));
    if (type === 'cc') setCcList(ccList.filter((_, i) => i !== index));
    if (type === 'bcc') setBccList(bccList.filter((_, i) => i !== index));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (files.length === 0) return;

    const limitText = formatFileSize(MAX_ATTACHMENT_BYTES);
    let total = attachments.reduce((n, a) => n + a.size, 0) + (plainMode ? 0 : inlineImageBytes(bodyHtml));
    const accepted: ComposerAttachment[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setErrorMsg(`"${file.name}" is ${formatFileSize(file.size)}. Attachments can be at most ${limitText} in total.`);
        continue;
      }
      if (total + file.size > MAX_ATTACHMENT_BYTES) {
        setErrorMsg(`"${file.name}" was not added: attachments can be at most ${limitText} in total.`);
        continue;
      }
      total += file.size;
      accepted.push({ file, filename: file.name, size: file.size });
    }
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  /** Puts a template in without touching the reply's quote or the signature. */
  const applyTemplate = ({ subject: newSubject, body: newBody }: { subject: string; body: string }) => {
    // A reply keeps its "Re:" subject; the template's subject is used only for an empty one.
    if (!subject.trim()) setSubject(newSubject);
    if (plainMode) {
      const ta = bodyRef.current;
      const at = ta ? ta.selectionStart : bodyText.length;
      setBodyText(bodyText.slice(0, at) + newBody + bodyText.slice(ta ? ta.selectionEnd : at));
      return;
    }
    const ed = editorRef.current;
    if (!ed) return;
    const html = plainTextToHtml(newBody);
    const insert = () => ed.chain().focus().insertContent(html).run();
    const typed = bodyHtml !== initialBodyHtml.current && !isEmptyHtml(bodyHtml);
    if (!typed) {
      insert();
      return;
    }
    requestConfirm({
      title: 'Replace the current text?',
      message: 'The paragraph you are in is replaced by the template. Your signature and any quoted message stay as they are.',
      confirmLabel: 'Replace',
      alternateLabel: 'Insert at cursor',
      onConfirm: () => {
        const { selection } = ed.state;
        if (!selection.empty) {
          insert();
          return;
        }
        const $from = selection.$from;
        if ($from.depth >= 1) {
          ed.chain().focus().deleteRange({ from: $from.before(1), to: $from.after(1) }).insertContent(html).run();
        } else {
          insert();
        }
      },
      onAlternate: () => void insert()
    });
  };

  const handleSend = async () => {
    setErrorMsg(null);
    if (!online) {
      setErrorMsg("You're offline, so the message can't be sent yet. It is kept here.");
      return;
    }

    const leftover = findPlaceholder(`${subject}
${plainMode ? bodyText : htmlToPlainText(bodyHtml)}`);
    if (leftover) {
      setErrorMsg(`Fill in or delete ${leftover} before sending.`);
      return;
    }

    // If user has typed an email without pressing enter, add it automatically
    const finalTo = mergeRecipients(toList, toInput);

    const badOne = [...finalTo, ...mergeRecipients(ccList, ccInput), ...mergeRecipients(bccList, bccInput)].find((r) => !isValidRecipient(r));
    if (badOne) {
      setErrorMsg(`Not a valid address: ${badOne}`);
      return;
    }

    if (finalTo.length === 0) {
      setErrorMsg('Please specify at least one recipient.');
      return;
    }

    const finalCc = mergeRecipients(ccList, ccInput);

    const finalBcc = mergeRecipients(bccList, bccInput);

    if (!plainMode) {
      // Pictures in the text count toward the same limit as attachments (the server checks again).
      const total = inlineImageBytes(bodyHtml) + attachments.reduce((n, a) => n + a.size, 0);
      if (total > MAX_ATTACHMENT_BYTES) {
        setErrorMsg(
          `The pictures and attachments together are ${formatBytes(total)}. A message can be at most ${formatBytes(MAX_ATTACHMENT_BYTES)}. Remove a picture or an attachment.`
        );
        return;
      }
    }

    setIsSending(true);
    sentRef.current = true; // no autosave while sending
    const draftUidAtSend = draftUidRef.current;
    try {
      const res = await api.sendEmail({
        to: finalTo,
        cc: finalCc.length > 0 ? finalCc : undefined,
        bcc: finalBcc.length > 0 ? finalBcc : undefined,
        subject: subject.trim() || '(No subject)',
        ...(plainMode || isEmptyHtml(bodyHtml) ? { text: plainMode ? bodyText : '' } : { html: bodyHtml }),
        inReplyTo: replyMeta?.inReplyTo,
        references: replyMeta?.references,
        forwardOf: replyMeta?.forwardOf,
        idempotencyKey: idempotencyKey.current,
        draftUid: draftUidRef.current,
        files: attachments.map((a) => a.file)
      });

      setIsSending(false);
      if (draftUidRef.current && draftUidRef.current !== draftUidAtSend) {
        void api.deleteDraft(draftUidRef.current).catch(() => {}); // a save that raced the send
      }
      onSentSuccess({ warning: res.warning, error: res.success ? undefined : res.error, to: finalTo.map((e) => nameOf(e) || e) });
      onClose();
    } catch (err: unknown) {
      sentRef.current = false; // sending failed: the composer stays open and keeps autosaving
      setIsSending(false);
      setErrorMsg(friendlyError(err, 'The message could not be sent. Check your connection and try again.'));
    }
  };

  const handleSaveSignature = (e: React.FormEvent) => {
    e.preventDefault();
    if (accountEmail && !saveSignatureForAccount(accountEmail, sigForm)) {
      setSigError('This browser could not store the signature (its storage is full or blocked). Try a smaller logo.');
      return;
    }
    setSigError(null);
    const prev = signatureHtml(signature);
    const next = signatureHtml(sigForm);
    setSignature(sigForm);
    setShowSigModal(false);
    if (plainMode || prev === next) return;

    // Swap the old signature for the new one in the message being written (or add it if it is not there).
    const ed = editorRef.current;
    if (!ed) return;
    const current = ed.getHTML();
    const oldNorm = prev ? normalizeEditorHtml(prev) : '';
    let updated = current;
    if (oldNorm && current.includes(oldNorm)) {
      updated = current.replace(oldNorm, next ? normalizeEditorHtml(next) : '');
    } else if (next) {
      const q = current.indexOf('<blockquote>');
      const add = normalizeEditorHtml(next);
      updated = q >= 0 ? current.slice(0, q) + add + current.slice(q) : current + add;
    }
    if (updated !== current) {
      ed.commands.setContent(updated, true);
    }
  };

  /** Plain text <-> rich text. Going to plain text drops formatting and pictures, so ask first. */
  const togglePlainMode = () => {
    if (plainMode) {
      setBodyHtml(plainTextToHtml(bodyText));
      setEditorKey((k) => k + 1);
      setPlainMode(false);
      return;
    }
    const toPlain = () => {
      setBodyText(htmlToPlainText(bodyHtml));
      setPlainMode(true);
    };
    if (hasRichContent(bodyHtml)) {
      requestConfirm({
        title: 'Switch to plain text?',
        message: 'Formatting, links and pictures will be removed from this message.',
        confirmLabel: 'Switch to plain text',
        onConfirm: toPlain
      });
    } else {
      toPlain();
    }
  };

  // Drawn at the root of the page, above the reader and everything in it, at every moment of the animation.
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="composer-title"
      data-leaving={cmpLeaving ? 'true' : undefined}
      onKeyDown={(e) => {
        // Ctrl+Enter (Cmd+Enter on a Mac) sends from anywhere in the composer.
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !isSending && !isMinimized) {
          e.preventDefault();
          void handleSend();
        }
      }}
      className={`anim-composer cmp-panel fixed z-[55] shadow-2xl rounded-t sm:rounded overflow-hidden bg-surface border border-line flex flex-col ${
        isMinimized
          ? 'cmp-min inset-x-0 bottom-0 sm:inset-x-auto sm:right-8 w-full sm:w-[580px] md:w-[640px] h-[92vh] sm:h-[540px] max-sm:!translate-y-0 max-sm:!inset-0 max-sm:!h-[var(--vvh,100dvh)]'
          : isMaximized
          ? 'top-2 bottom-2 left-2 right-2 sm:top-4 sm:bottom-4 sm:left-12 sm:right-12'
          : 'inset-x-0 bottom-0 sm:inset-x-auto sm:right-8 sm:bottom-0 w-full sm:w-[580px] md:w-[640px] sm:h-[540px] max-sm:inset-0 max-sm:top-[var(--vvtop,0px)] max-sm:bottom-auto max-sm:h-[var(--vvh,100dvh)] max-sm:rounded-none max-sm:border-0'
      }`}
    >
      {/* Modal Header */}
      <div className="bg-cmp-top text-white pl-4 pr-2 min-h-[42px] flex items-center justify-between select-none cursor-pointer max-sm:flex-row-reverse max-sm:justify-end max-sm:gap-1 max-sm:pl-4 max-sm:pr-1 max-sm:pt-[env(safe-area-inset-top)] max-sm:min-h-[calc(52px+env(safe-area-inset-top))]">
        <span id="composer-title" className="text-[13.5px] max-sm:text-[16px] font-extrabold text-white truncate max-sm:flex-1">
          {subject || 'New Message'}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setIsMinimized(!isMinimized)}
            className="max-sm:hidden p-1 text-white hover:bg-white/15 rounded transition-colors min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
            title={isMinimized ? 'Expand' : 'Minimize'}
            aria-label={isMinimized ? 'Expand' : 'Minimize'}
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              setIsMaximized(!isMaximized);
              setIsMinimized(false);
            }}
            className="max-sm:hidden p-1 text-white hover:bg-white/15 rounded transition-colors min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
            title={isMaximized ? 'Restore size' : 'Maximize'}
            aria-label={isMaximized ? 'Restore size' : 'Maximize'}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleCloseClick}
            className="p-1 text-white hover:bg-white/15 rounded transition-colors min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
            title="Close"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5 max-sm:w-5 max-sm:h-5" />
          </button>
        </div>
      </div>

      {(
        <div aria-hidden={isMinimized || undefined} className={`cmp-content flex-1 flex flex-col bg-surface overflow-hidden ${isMinimized ? 'cmp-content-min' : ''}`}>
          {/* Error Banner */}
          {errorMsg && (
            <div role="alert" className="bg-warn-bg text-warn-ink px-4 py-2 text-xs flex items-center gap-2 border-b border-warn-line shrink-0">
              <AlertCircle className="w-4 h-4 shrink-0 text-warn-ink" />
              <span className="flex-1">{errorMsg}</span>
              <button onClick={() => setErrorMsg(null)} aria-label="Dismiss error" className="text-warn-ink font-bold px-2 min-h-[44px] sm:min-h-0">
                ×
              </button>
            </div>
          )}

          {/* Phone, keyboard open: To, Subject and the body scroll together above a fixed Send bar. */}
          <div className="flex-1 min-h-0 flex flex-col max-sm:overflow-y-auto">
          {/* Recipients & Subject Fields */}
          <div className="px-4 py-2 border-b border-line flex flex-col divide-y divide-line text-xs">
            <RecipientField
              id="composer-to"
              label="To"
              list={toList}
              input={toInput}
              onInput={setToInput}
              onAdd={(v) => handleAddRecipient('to', v)}
              onRemove={(i) => handleRemoveRecipient('to', i)}
              nameOf={nameOf}
              inputRef={toInputRef}
              trailing={
                <div className="flex items-center gap-2 text-[11px] text-ink-3">
                  {!showCc && (
                    <button onClick={() => setShowCc(true)} className="hover:text-ink-2 min-h-[44px] px-1 sm:min-h-0">
                      Cc
                    </button>
                  )}
                  {!showBcc && (
                    <button onClick={() => setShowBcc(true)} className="hover:text-ink-2 min-h-[44px] px-1 sm:min-h-0">
                      Bcc
                    </button>
                  )}
                </div>
              }
            />
            {showCc && (
              <RecipientField
                id="composer-cc"
                label="Cc"
                list={ccList}
                input={ccInput}
                onInput={setCcInput}
                onAdd={(v) => handleAddRecipient('cc', v)}
                onRemove={(i) => handleRemoveRecipient('cc', i)}
                nameOf={nameOf}
              />
            )}
            {showBcc && (
              <RecipientField
                id="composer-bcc"
                label="Bcc"
                list={bccList}
                input={bccInput}
                onInput={setBccInput}
                onAdd={(v) => handleAddRecipient('bcc', v)}
                onRemove={(i) => handleRemoveRecipient('bcc', i)}
                nameOf={nameOf}
              />
            )}

            {droppedNote && (
              <p role="status" className="px-4 py-1 text-[11px] text-ink-3">
                {droppedNote}
              </p>
            )}

            {/* Subject Line */}
            <div className="py-1.5 flex items-center gap-2">
              <label htmlFor="composer-subject" className="text-ink-3 font-medium w-12">Subject:</label>
              <input
                id="composer-subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                className="flex-1 focus:outline-none bg-transparent py-0.5 text-ink font-medium max-sm:text-[16px]"
              />
            </div>
          </div>

          {/* Email Body Area */}
          <div className="flex-1 p-4 flex flex-col overflow-hidden max-sm:min-h-[12rem]">
            {plainMode ? (
              <textarea
                ref={bodyRef}
                aria-label="Message"
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                placeholder="Write your email message here..."
                className="w-full flex-1 resize-none focus:outline-none text-sm text-ink font-sans leading-relaxed"
              />
            ) : (
              <RichEditor
                key={editorKey}
                content={bodyHtml}
                onChange={setBodyHtml}
                onError={setErrorMsg}
                onReady={(ed) => {
                  editorRef.current = ed;
                }}
                ariaLabel="Message"
                placeholder="Write your email message here..."
                contentClassName="min-h-[10rem]"
                hideToolbar={!showFormat}
              />
            )}

            {replyMeta?.forwardedAttachmentNames && replyMeta.forwardedAttachmentNames.length > 0 && (
              <div className="pt-2 text-xs text-ink-3">
                The original attachments will be included: {replyMeta.forwardedAttachmentNames.join(', ')}
              </div>
            )}

            {/* Attached Files Pill List */}
            {attachments.length > 0 && (
              <div className="pt-3 border-t border-line flex flex-wrap gap-2">
                {attachments.map((att, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-1.5 bg-hover hover:bg-line px-2.5 py-1 rounded text-xs text-ink-2 transition-colors"
                  >
                    <Paperclip className="w-3 h-3 text-ink-3" />
                    <span className="font-medium max-w-[150px] truncate">{att.filename}</span>
                    <span className="text-[11px] text-ink-3">({formatFileSize(att.size)})</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(idx)}
                      aria-label={`Remove attachment ${att.filename}`}
                      className="ml-1 text-ink-3 hover:text-warn-ink font-bold px-1 min-h-[44px] sm:min-h-0"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          </div>

          {/* Hidden File Input */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            multiple
            className="hidden"
          />

          {/* Bottom bar: one row. Send, attach, picture, formatting on the left; saved time and delete on the right. */}
          <input
            ref={imageInputRef}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            multiple
            aria-label="Choose a picture"
            className="hidden"
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              for (const f of files) {
                try {
                  const src = await readImageFile(f, MAX_IMAGE_BYTES);
                  editorRef.current?.chain().focus().setImage({ src, alt: f.name }).run();
                } catch (err) {
                  setErrorMsg(err instanceof Error ? err.message : 'That picture could not be added.');
                }
              }
            }}
          />
          {!online && (
            <p id="send-offline" role="status" className="px-4 py-1.5 text-xs font-semibold text-warn-ink bg-warn-bg border-t border-warn-line">
              You're offline. Your message is kept; Send works again when you're back online.
            </p>
          )}
          <div className="px-3 sm:px-4 py-2.5 border-t border-line bg-sheet flex flex-nowrap items-center gap-1 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
            <button
              onClick={handleSend}
              disabled={isSending || !online}
              aria-describedby={online ? undefined : 'send-offline'}
              title={online ? undefined : "You're offline. Send works again when you're back online."}
              aria-keyshortcuts="Control+Enter"
              className="cut-tr shrink-0 whitespace-nowrap flex items-center gap-2 bg-act hover:bg-act-hov text-act-ink font-extrabold text-[13.5px] pl-3 pr-3.5 mr-1 min-h-[44px] sm:min-h-[36px] transition-colors disabled:opacity-50"
            >
              {isSending ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-surface border-t-transparent rounded-full animate-spin" />
                  <span>Sending...</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>Send</span>
                  <kbd aria-hidden="true" className="hidden md:inline-block text-[10.5px] font-semibold leading-none px-1 py-[3px] rounded-[3px] border border-current opacity-80">Ctrl+Enter</kbd>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={ICON_BTN}
              title="Attach files"
              aria-label="Attach files"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            {!plainMode && (
              <>
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  className={ICON_BTN}
                  title="Insert picture"
                  aria-label="Insert picture"
                >
                  <ImagePlus className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowFormat((v) => !v)}
                  aria-pressed={showFormat}
                  className={`${ICON_BTN} ${showFormat ? '!bg-sel !text-sel-ink' : ''}`}
                  title="Formatting"
                  aria-label="Formatting"
                >
                  <Bold className="w-4 h-4" />
                </button>
              </>
            )}
            <div className="relative shrink-0">
              <button
                ref={moreBtn}
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                className={ICON_BTN}
                title="More"
                aria-label="More composer options"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              <Presence show={moreOpen}>
                {moreOpen && (
                  <ComposerMore
                    anchor={moreBtn}
                    onClose={(refocus) => {
                      setMoreOpen(false);
                      if (refocus) moreBtn.current?.focus();
                    }}
                    items={[
                      {
                        key: 'templates',
                        label: 'Templates',
                        icon: <FileSpreadsheet className="w-4 h-4" />,
                        onSelect: () => setShowTemplateModal(true)
                      },
                      {
                        key: 'signature',
                        label: signature.enabled ? 'Signature (on)' : 'Signature',
                        icon: <PenTool className="w-4 h-4" />,
                        onSelect: () => {
                          setSigForm(signature);
                          setSigError(null);
                          setShowSigModal(true);
                        }
                      },
                      {
                        key: 'plain',
                        label: plainMode ? 'Back to formatted text' : 'Plain text',
                        icon: <Type className="w-4 h-4" />,
                        onSelect: togglePlainMode
                      }
                    ]}
                  />
                )}
              </Presence>
            </div>

            <div className="flex items-center gap-1 min-w-0 ml-auto">
              {/* Fixed-size slot: the status never moves the buttons. Icon only on narrow screens. */}
              <span
                className={`shrink-0 w-5 sm:w-40 h-5 flex items-center justify-end overflow-hidden text-[11px] whitespace-nowrap ${draftStatus?.error ? 'text-warn-ink font-semibold' : 'text-ink-3'}`}
                role="status"
                title={statusText}
                aria-label={statusText || undefined}
              >
                {statusText && (
                  <>
                    <Info className="w-4 h-4 sm:hidden" aria-hidden="true" />
                    <span className="hidden sm:block truncate">{statusText}</span>
                  </>
                )}
              </span>
              <button
                onClick={handleDiscard}
                className="p-2 text-ink-3 hover:text-warn-ink hover:bg-warn-bg rounded transition-colors min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center shrink-0"
                title="Discard message"
                aria-label="Discard message"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Templates Selector Modal */}
      <TemplateSelectorModal
        isOpen={showTemplateModal}
        onClose={() => setShowTemplateModal(false)}
        onApplyTemplate={applyTemplate}
      />

      {/* Signature Settings Modal */}
      {showSigModal && (
        <div className="fixed inset-0 z-[60] bg-scrim anim-scrim flex items-center justify-center p-4">
          <div
            ref={sigRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="signature-title"
            className="bg-surface rounded shadow-2xl border border-line w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150 max-h-full overflow-y-auto"
          >
            <div className="px-4 py-3 bg-cmp-top text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PenTool className="w-4 h-4" />
                <span id="signature-title" className="text-[13.5px] font-extrabold">Corporate Email Signature</span>
              </div>
              <button
                onClick={() => setShowSigModal(false)}
                aria-label="Close signature settings"
                className="text-white hover:bg-white/15 rounded min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveSignature} className="p-4 space-y-3 text-xs">
              <label className="flex items-center gap-2 select-none cursor-pointer pb-2 border-b border-line">
                <input
                  type="checkbox"
                  checked={sigForm.enabled}
                  onChange={(e) => setSigForm({ ...sigForm, enabled: e.target.checked })}
                  className="rounded border-line-2 text-act focus:ring-focus"
                />
                <span className="font-medium text-ink">Add my signature to new messages and replies</span>
              </label>

              <div>
                <span id="sig-editor-label" className="block text-[11px] font-semibold text-ink-3 mb-1">
                  Signature
                </span>
                <div className="border border-line rounded p-2 bg-sheet">
                  <RichEditor
                    content={sigForm.html}
                    onChange={(html) => setSigForm((f) => ({ ...f, html }))}
                    onError={setSigError}
                    ariaLabel="Signature text"
                    placeholder="Name, role, phone, website. Use the picture button to add your logo."
                    maxImageBytes={SIGNATURE_IMAGE_MAX_BYTES}
                    contentClassName="min-h-[7rem] max-h-56"
                  />
                </div>
                <p className="mt-1 text-[11px] text-ink-3">
                  Logos are sent inside the message, not as an attachment (up to {formatBytes(SIGNATURE_IMAGE_MAX_BYTES)}).
                  The signature is saved in this browser only.
                </p>
                {sigError && (
                  <p role="alert" className="mt-1 text-[11px] text-warn-ink">
                    {sigError}
                  </p>
                )}
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-line">
                <button
                  type="button"
                  onClick={() => setShowSigModal(false)}
                  className="px-3 py-1.5 text-ink-2 hover:bg-hover rounded text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 bg-act hover:bg-act-hov text-act-ink font-medium rounded text-xs shadow-sm"
                >
                  Save Signature
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};
