import { splitRecipients, mergeRecipients } from '../services/recipients';
import React, { useState, useRef, useEffect } from 'react';
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
  Info
} from 'lucide-react';
import { api, ApiError } from '../services/api.js';
import { friendlyError } from '../services/errors.js';
import { useDialog } from '../hooks/useDialog.js';
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
}

export interface ComposerReplyMeta {
  inReplyTo?: string;
  references?: string[];
  forwardOf?: { folder: string; uid: number };
  /** Names of original attachments the server will add to a forward. */
  forwardedAttachmentNames?: string[];
  /** UID of the saved draft this composer was opened from. */
  draftUid?: number;
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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
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
  const editorRef = useRef<Editor | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const sigRef = useRef<HTMLDivElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // ---- Drafts: autosave every 10 s while there are changes ----
  const draftUidRef = useRef<number | undefined>(replyMeta?.draftUid);
  const [draftStatus, setDraftStatus] = useState<{ text: string; error: boolean } | null>(null);
  const savingRef = useRef(false);
  const lastSaveAtRef = useRef(0);
  const sentRef = useRef(false);

  const statusText = [draftStatus?.text, attachments.length > 0 ? 'Attachments are not saved in drafts' : ''].filter(Boolean).join(' · ');

  const snapshot = () =>
    JSON.stringify({
      to: [...toList, toInput.trim()].filter(Boolean),
      cc: [...ccList, ccInput.trim()].filter(Boolean),
      bcc: [...bccList, bccInput.trim()].filter(Boolean),
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
      lastSavedSnap.current = snap;
      lastSaveAtRef.current = Date.now();
      setDraftStatus({ text: `Draft saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, error: false });
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

  useDialog(sigRef, { open: showSigModal, onEscape: () => setShowSigModal(false) });

  if (!isOpen) return null;

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

  const handleSend = async () => {
    setErrorMsg(null);

    // If user has typed an email without pressing enter, add it automatically
    const finalTo = mergeRecipients(toList, toInput);

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
      onSentSuccess({ warning: res.warning, error: res.success ? undefined : res.error });
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

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="composer-title"
      className={`fixed z-50 transition-all duration-200 shadow-2xl rounded-t-2xl sm:rounded-xl overflow-hidden bg-white border border-slate-200 flex flex-col ${
        isMinimized
          ? 'bottom-0 right-4 sm:right-6 w-72 h-11'
          : isMaximized
          ? 'top-2 bottom-2 left-2 right-2 sm:top-4 sm:bottom-4 sm:left-12 sm:right-12'
          : 'inset-x-0 bottom-0 sm:inset-x-auto sm:right-8 sm:bottom-0 w-full sm:w-[580px] md:w-[640px] h-[92vh] sm:h-[540px]'
      }`}
    >
      {/* Modal Header */}
      <div className="bg-slate-900 text-slate-200 px-4 py-2.5 flex items-center justify-between select-none cursor-pointer">
        <span id="composer-title" className="text-xs font-semibold tracking-wide text-white truncate">
          {subject || 'New Message'}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setIsMinimized(!isMinimized)}
            className="p-1 hover:text-white hover:bg-slate-800 rounded transition-colors min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
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
            className="p-1 hover:text-white hover:bg-slate-800 rounded transition-colors min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
            title={isMaximized ? 'Restore size' : 'Maximize'}
            aria-label={isMaximized ? 'Restore size' : 'Maximize'}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleCloseClick}
            className="p-1 hover:text-red-400 hover:bg-slate-800 rounded transition-colors min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
            title="Close"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <div className="flex-1 flex flex-col bg-white overflow-hidden">
          {/* Error Banner */}
          {errorMsg && (
            <div role="alert" className="bg-red-50 text-red-700 px-4 py-2 text-xs flex items-center gap-2 border-b border-red-200 shrink-0">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-500" />
              <span className="flex-1">{errorMsg}</span>
              <button onClick={() => setErrorMsg(null)} aria-label="Dismiss error" className="text-red-500 font-bold px-2 min-h-[44px] sm:min-h-0">
                ×
              </button>
            </div>
          )}

          {/* Recipients & Subject Fields */}
          <div className="px-4 py-2 border-b border-slate-100 flex flex-col divide-y divide-slate-100 text-xs">
            {/* To Line */}
            <div className="py-1.5 flex items-center gap-2">
              <label htmlFor="composer-to" className="text-slate-400 font-medium w-12">To:</label>
              <div className="flex-1 flex flex-wrap items-center gap-1.5">
                {toList.map((email, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 bg-sky-50 text-sky-700 border border-sky-200/80 px-2 py-0.5 rounded-md text-xs font-medium"
                  >
                    <span>{email}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveRecipient('to', idx)}
                      aria-label={`Remove ${email}`}
                      className="hover:text-sky-900 px-1 min-h-[44px] sm:min-h-0"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  id="composer-to"
                  ref={toInputRef}
                  type="email"
                  value={toInput}
                  onChange={(e) => setToInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      handleAddRecipient('to', toInput);
                    }
                  }}
                  onBlur={() => {
                    if (toInput) handleAddRecipient('to', toInput);
                  }}
                  placeholder={toList.length === 0 ? 'recipients@example.com (press Enter)' : ''}
                  className="flex-1 min-w-[140px] focus:outline-none bg-transparent py-0.5 text-slate-800"
                />
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                {!showCc && (
                  <button onClick={() => setShowCc(true)} className="hover:text-slate-700 min-h-[44px] px-1 sm:min-h-0">
                    Cc
                  </button>
                )}
                {!showBcc && (
                  <button onClick={() => setShowBcc(true)} className="hover:text-slate-700 min-h-[44px] px-1 sm:min-h-0">
                    Bcc
                  </button>
                )}
              </div>
            </div>

            {/* Cc Line */}
            {showCc && (
              <div className="py-1.5 flex items-center gap-2">
                <label htmlFor="composer-cc" className="text-slate-400 font-medium w-12">Cc:</label>
                <div className="flex-1 flex flex-wrap items-center gap-1.5">
                  {ccList.map((email, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1 bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md text-xs font-medium"
                    >
                      <span>{email}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveRecipient('cc', idx)}
                        aria-label={`Remove ${email}`}
                        className="hover:text-slate-900 px-1 min-h-[44px] sm:min-h-0"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    id="composer-cc"
                    type="email"
                    value={ccInput}
                    onChange={(e) => setCcInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        handleAddRecipient('cc', ccInput);
                      }
                    }}
                    onBlur={() => {
                      if (ccInput) handleAddRecipient('cc', ccInput);
                    }}
                    placeholder="Cc recipients..."
                    className="flex-1 min-w-[120px] focus:outline-none bg-transparent py-0.5 text-slate-800"
                  />
                </div>
              </div>
            )}

            {/* Bcc Line */}
            {showBcc && (
              <div className="py-1.5 flex items-center gap-2">
                <label htmlFor="composer-bcc" className="text-slate-400 font-medium w-12">Bcc:</label>
                <div className="flex-1 flex flex-wrap items-center gap-1.5">
                  {bccList.map((email, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1 bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md text-xs font-medium"
                    >
                      <span>{email}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveRecipient('bcc', idx)}
                        aria-label={`Remove ${email}`}
                        className="hover:text-slate-900 px-1 min-h-[44px] sm:min-h-0"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    id="composer-bcc"
                    type="email"
                    value={bccInput}
                    onChange={(e) => setBccInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        handleAddRecipient('bcc', bccInput);
                      }
                    }}
                    onBlur={() => {
                      if (bccInput) handleAddRecipient('bcc', bccInput);
                    }}
                    placeholder="Bcc recipients..."
                    className="flex-1 min-w-[120px] focus:outline-none bg-transparent py-0.5 text-slate-800"
                  />
                </div>
              </div>
            )}

            {/* Subject Line */}
            <div className="py-1.5 flex items-center gap-2">
              <label htmlFor="composer-subject" className="text-slate-400 font-medium w-12">Subject:</label>
              <input
                id="composer-subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                className="flex-1 focus:outline-none bg-transparent py-0.5 text-slate-800 font-medium"
              />
            </div>
          </div>

          {/* Email Body Area */}
          <div className="flex-1 p-4 flex flex-col overflow-hidden">
            {plainMode ? (
              <textarea
                ref={bodyRef}
                aria-label="Message"
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                placeholder="Write your email message here..."
                className="w-full flex-1 resize-none focus:outline-none text-sm text-slate-800 font-sans leading-relaxed"
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
              />
            )}

            {replyMeta?.forwardedAttachmentNames && replyMeta.forwardedAttachmentNames.length > 0 && (
              <div className="pt-2 text-xs text-slate-500">
                The original attachments will be included: {replyMeta.forwardedAttachmentNames.join(', ')}
              </div>
            )}

            {/* Attached Files Pill List */}
            {attachments.length > 0 && (
              <div className="pt-3 border-t border-slate-100 flex flex-wrap gap-2">
                {attachments.map((att, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200/80 px-2.5 py-1 rounded-lg text-xs text-slate-700 transition-colors"
                  >
                    <Paperclip className="w-3 h-3 text-slate-400" />
                    <span className="font-medium max-w-[150px] truncate">{att.filename}</span>
                    <span className="text-[10px] text-slate-400">({formatFileSize(att.size)})</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(idx)}
                      aria-label={`Remove attachment ${att.filename}`}
                      className="ml-1 text-slate-400 hover:text-red-500 font-bold px-1 min-h-[44px] sm:min-h-0"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Hidden File Input */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            multiple
            className="hidden"
          />

          {/* Bottom Action Bar */}
          <div className="px-3 sm:px-4 py-3 border-t border-slate-100 bg-slate-50/60 flex flex-wrap items-center justify-between gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleSend}
                disabled={isSending}
                className="flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs px-4 py-2 min-h-[44px] sm:min-h-0 rounded-lg shadow-sm shadow-sky-600/20 transition-all disabled:opacity-50"
              >
                {isSending ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Sending...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    <span>Send Message</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-200/60 rounded-lg transition-colors min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
                title="Attach files"
                aria-label="Attach files"
              >
                <Paperclip className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={togglePlainMode}
                aria-pressed={plainMode}
                title={plainMode ? 'Back to formatted text' : 'Write this message as plain text'}
                className={`flex items-center gap-1.5 px-3 py-1.5 min-h-[44px] sm:min-h-0 text-xs rounded-lg transition-colors border font-medium ${
                  plainMode
                    ? 'text-slate-800 bg-slate-200 border-slate-300'
                    : 'text-slate-500 bg-slate-100 hover:bg-slate-200 border-slate-200'
                }`}
              >
                <span>Plain text</span>
              </button>

              <button
                type="button"
                onClick={() => setShowTemplateModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 min-h-[44px] sm:min-h-0 text-xs text-sky-700 bg-sky-50 hover:bg-sky-100 rounded-lg transition-colors border border-sky-200/60 font-medium"
                title="Insert pre-written email templates"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-sky-600" />
                <span>Templates</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSigForm(signature);
                  setSigError(null);
                  setShowSigModal(true);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 min-h-[44px] sm:min-h-0 text-xs rounded-lg transition-colors border font-medium ${
                  signature.enabled
                    ? 'text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border-indigo-200/60'
                    : 'text-slate-500 bg-slate-100 hover:bg-slate-200 border-slate-200'
                }`}
                title="Configure Delpat corporate signature"
              >
                <PenTool className="w-3.5 h-3.5 text-indigo-600" />
                <span>Signature</span>
              </button>
            </div>

            <div className="flex items-center gap-2 min-w-0">
            {/* Fixed-size slot: the status never moves the buttons. Icon only on narrow screens. */}
            <span
              className={`shrink-0 w-5 sm:w-48 h-5 flex items-center justify-end overflow-hidden text-[11px] ${draftStatus?.error ? 'text-red-600 font-semibold' : 'text-slate-400'}`}
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
              className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
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
        onApplyTemplate={({ subject: newSubject, body: newBody }) => {
          setSubject(newSubject);
          if (plainMode) {
            setBodyText(newBody);
          } else {
            setBodyHtml(plainTextToHtml(newBody));
            setEditorKey((k) => k + 1);
          }
        }}
      />

      {/* Signature Settings Modal */}
      {showSigModal && (
        <div className="fixed inset-0 z-[60] bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div
            ref={sigRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="signature-title"
            className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150 max-h-full overflow-y-auto"
          >
            <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PenTool className="w-4 h-4 text-sky-400" />
                <span id="signature-title" className="text-xs font-semibold">Corporate Email Signature</span>
              </div>
              <button
                onClick={() => setShowSigModal(false)}
                aria-label="Close signature settings"
                className="text-slate-400 hover:text-white min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveSignature} className="p-4 space-y-3 text-xs">
              <label className="flex items-center gap-2 select-none cursor-pointer pb-2 border-b border-slate-100">
                <input
                  type="checkbox"
                  checked={sigForm.enabled}
                  onChange={(e) => setSigForm({ ...sigForm, enabled: e.target.checked })}
                  className="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                />
                <span className="font-medium text-slate-800">Add my signature to new messages and replies</span>
              </label>

              <div>
                <span id="sig-editor-label" className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                  Signature
                </span>
                <div className="border border-slate-200 rounded-lg p-2 bg-slate-50/50">
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
                <p className="mt-1 text-[11px] text-slate-400">
                  Logos are sent inside the message, not as an attachment (up to {formatBytes(SIGNATURE_IMAGE_MAX_BYTES)}).
                  The signature is saved in this browser only.
                </p>
                {sigError && (
                  <p role="alert" className="mt-1 text-[11px] text-red-600">
                    {sigError}
                  </p>
                )}
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowSigModal(false)}
                  className="px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded-lg text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white font-medium rounded-lg text-xs shadow-sm shadow-sky-600/20"
                >
                  Save Signature
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
