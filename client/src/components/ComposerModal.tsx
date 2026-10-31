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
  PenTool
} from 'lucide-react';
import { api } from '../services/api.js';
import { TemplateSelectorModal } from './TemplateSelectorModal.js';
import {
  getSignatureForAccount,
  saveSignatureForAccount,
  formatSignatureText,
  type AccountSignature
} from '../services/signatures.js';

interface ComposerAttachment {
  filename: string;
  content: string; // base64
  size: number;
  contentType: string;
}

interface ComposerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSentSuccess: () => void;
  initialTo?: string[];
  initialCc?: string[];
  initialSubject?: string;
  initialBody?: string;
  accountEmail?: string;
  accountName?: string;
}

export const ComposerModal: React.FC<ComposerModalProps> = ({
  isOpen,
  onClose,
  onSentSuccess,
  initialTo = [],
  initialCc = [],
  initialSubject = '',
  initialBody = '',
  accountEmail = '',
  accountName = ''
}) => {
  const [toInput, setToInput] = useState('');
  const [toList, setToList] = useState<string[]>(initialTo);
  const [showCc, setShowCc] = useState(initialCc.length > 0);
  const [ccInput, setCcInput] = useState('');
  const [ccList, setCcList] = useState<string[]>(initialCc);
  const [showBcc, setShowBcc] = useState(false);
  const [bccInput, setBccInput] = useState('');
  const [bccList, setBccList] = useState<string[]>([]);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
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

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync initial props when opened or changed
  useEffect(() => {
    if (isOpen) {
      setToList(initialTo);
      setCcList(initialCc);
      setShowCc(initialCc.length > 0);
      setSubject(initialSubject);

      const currentSig = getSignatureForAccount(accountEmail, accountName);
      setSignature(currentSig);
      setSigForm(currentSig);
      const sigText = formatSignatureText(currentSig);

      let fullBody = initialBody;
      if (!initialBody && sigText) {
        fullBody = `\n\n${sigText}`;
      } else if (initialBody && sigText && !initialBody.includes(currentSig.name)) {
        if (initialBody.startsWith('\n\n---') || initialBody.startsWith('\n\n----------')) {
          fullBody = `\n\n${sigText}${initialBody}`;
        }
      }
      setBody(fullBody);
      setErrorMsg(null);
    }
  }, [isOpen, initialTo, initialCc, initialSubject, initialBody, accountEmail, accountName]);

  if (!isOpen) return null;

  const handleAddRecipient = (
    type: 'to' | 'cc' | 'bcc',
    value: string
  ) => {
    const trimmed = value.trim().replace(/,/g, '');
    if (!trimmed) return;
    if (type === 'to') {
      if (!toList.includes(trimmed)) setToList([...toList, trimmed]);
      setToInput('');
    } else if (type === 'cc') {
      if (!ccList.includes(trimmed)) setCcList([...ccList, trimmed]);
      setCcInput('');
    } else {
      if (!bccList.includes(trimmed)) setBccList([...bccList, trimmed]);
      setBccInput('');
    }
  };

  const handleRemoveRecipient = (type: 'to' | 'cc' | 'bcc', index: number) => {
    if (type === 'to') setToList(toList.filter((_, i) => i !== index));
    if (type === 'cc') setCcList(ccList.filter((_, i) => i !== index));
    if (type === 'bcc') setBccList(bccList.filter((_, i) => i !== index));
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const files = Array.from(e.target.files);

    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Strip data:contentType;base64, prefix
        const base64 = result.split(',')[1] || '';
        setAttachments((prev) => [
          ...prev,
          {
            filename: file.name,
            content: base64,
            size: file.size,
            contentType: file.type || 'application/octet-stream'
          }
        ]);
      };
      reader.readAsDataURL(file);
    }
    // reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    setErrorMsg(null);

    // If user has typed an email without pressing enter, add it automatically
    const finalTo = [...toList];
    if (toInput.trim() && !finalTo.includes(toInput.trim())) {
      finalTo.push(toInput.trim());
    }

    if (finalTo.length === 0) {
      setErrorMsg('Please specify at least one recipient.');
      return;
    }

    const finalCc = [...ccList];
    if (ccInput.trim() && !finalCc.includes(ccInput.trim())) {
      finalCc.push(ccInput.trim());
    }

    const finalBcc = [...bccList];
    if (bccInput.trim() && !finalBcc.includes(bccInput.trim())) {
      finalBcc.push(bccInput.trim());
    }

    setIsSending(true);
    try {
      // Prepare payload
      const htmlBody = body.replace(/\n/g, '<br/>');
      await api.sendEmail({
        to: finalTo,
        cc: finalCc.length > 0 ? finalCc : undefined,
        bcc: finalBcc.length > 0 ? finalBcc : undefined,
        subject: subject.trim() || '(No subject)',
        text: body,
        html: htmlBody,
        attachments: attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType
        }))
      });

      setIsSending(false);
      onSentSuccess();
      onClose();
    } catch (err: unknown) {
      setIsSending(false);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to send message. Please check connection.');
    }
  };

  const handleSaveSignature = (e: React.FormEvent) => {
    e.preventDefault();
    if (accountEmail) {
      saveSignatureForAccount(accountEmail, sigForm);
    }
    const prevSigText = formatSignatureText(signature);
    const newSigText = formatSignatureText(sigForm);
    setSignature(sigForm);
    setShowSigModal(false);

    if (prevSigText && body.includes(prevSigText)) {
      setBody(body.replace(prevSigText, newSigText));
    } else if (newSigText && !body.includes(newSigText)) {
      setBody((prev) => `${prev}\n\n${newSigText}`);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  return (
    <div
      className={`fixed z-50 transition-all duration-200 shadow-2xl rounded-t-xl sm:rounded-xl overflow-hidden bg-white border border-slate-200 flex flex-col ${
        isMinimized
          ? 'bottom-0 right-6 w-72 h-11'
          : isMaximized
          ? 'top-4 bottom-4 left-4 right-4 sm:left-12 sm:right-12'
          : 'bottom-0 right-4 sm:right-8 w-full sm:w-[580px] md:w-[640px] h-[540px]'
      }`}
    >
      {/* Modal Header */}
      <div className="bg-slate-900 text-slate-200 px-4 py-2.5 flex items-center justify-between select-none cursor-pointer">
        <span className="text-xs font-semibold tracking-wide text-white truncate">
          {subject || 'New Message'}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setIsMinimized(!isMinimized)}
            className="p-1 hover:text-white hover:bg-slate-800 rounded transition-colors"
            title={isMinimized ? 'Expand' : 'Minimize'}
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              setIsMaximized(!isMaximized);
              setIsMinimized(false);
            }}
            className="p-1 hover:text-white hover:bg-slate-800 rounded transition-colors"
            title={isMaximized ? 'Restore' : 'Maximize'}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClose}
            className="p-1 hover:text-red-400 hover:bg-slate-800 rounded transition-colors"
            title="Discard & Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <div className="flex-1 flex flex-col bg-white overflow-hidden">
          {/* Error Banner */}
          {errorMsg && (
            <div className="bg-red-50 text-red-700 px-4 py-2 text-xs flex items-center gap-2 border-b border-red-200 shrink-0">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-500" />
              <span className="flex-1">{errorMsg}</span>
              <button onClick={() => setErrorMsg(null)} className="text-red-500 font-bold">
                ×
              </button>
            </div>
          )}

          {/* Recipients & Subject Fields */}
          <div className="px-4 py-2 border-b border-slate-100 flex flex-col divide-y divide-slate-100 text-xs">
            {/* To Line */}
            <div className="py-1.5 flex items-center gap-2">
              <span className="text-slate-400 font-medium w-12">To:</span>
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
                      className="hover:text-sky-900"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
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
                  <button onClick={() => setShowCc(true)} className="hover:text-slate-700">
                    Cc
                  </button>
                )}
                {!showBcc && (
                  <button onClick={() => setShowBcc(true)} className="hover:text-slate-700">
                    Bcc
                  </button>
                )}
              </div>
            </div>

            {/* Cc Line */}
            {showCc && (
              <div className="py-1.5 flex items-center gap-2">
                <span className="text-slate-400 font-medium w-12">Cc:</span>
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
                        className="hover:text-slate-900"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
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
                <span className="text-slate-400 font-medium w-12">Bcc:</span>
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
                        className="hover:text-slate-900"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
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
              <span className="text-slate-400 font-medium w-12">Subject:</span>
              <input
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
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your email message here..."
              className="w-full flex-1 resize-none focus:outline-none text-sm text-slate-800 font-sans leading-relaxed"
            />

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
                      className="ml-1 text-slate-400 hover:text-red-500 font-bold"
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
          <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/60 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={handleSend}
                disabled={isSending}
                className="flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs px-4 py-2 rounded-lg shadow-sm shadow-sky-600/20 transition-all disabled:opacity-50"
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
                className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-200/60 rounded-lg transition-colors"
                title="Attach files"
              >
                <Paperclip className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={() => setShowTemplateModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-sky-700 bg-sky-50 hover:bg-sky-100 rounded-lg transition-colors border border-sky-200/60 font-medium"
                title="Insert pre-written email templates"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-sky-600" />
                <span>Templates</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSigForm(signature);
                  setShowSigModal(true);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors border font-medium ${
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

            <button
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              title="Discard draft"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Templates Selector Modal */}
      <TemplateSelectorModal
        isOpen={showTemplateModal}
        onClose={() => setShowTemplateModal(false)}
        onApplyTemplate={({ subject: newSubject, body: newBody }) => {
          setSubject(newSubject);
          setBody(newBody);
        }}
      />

      {/* Signature Settings Modal */}
      {showSigModal && (
        <div className="fixed inset-0 z-[60] bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PenTool className="w-4 h-4 text-sky-400" />
                <span className="text-xs font-semibold">Corporate Email Signature</span>
              </div>
              <button
                onClick={() => setShowSigModal(false)}
                className="text-slate-400 hover:text-white"
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
                <span className="font-medium text-slate-800">Append corporate signature automatically</span>
              </label>

              <div>
                <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  value={sigForm.name}
                  onChange={(e) => setSigForm({ ...sigForm, name: e.target.value })}
                  placeholder="e.g. Rahul Sharma"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                  Designation / Role
                </label>
                <input
                  type="text"
                  value={sigForm.designation}
                  onChange={(e) => setSigForm({ ...sigForm, designation: e.target.value })}
                  placeholder="e.g. Operations & Engineering"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                    Phone Number
                  </label>
                  <input
                    type="text"
                    value={sigForm.phone}
                    onChange={(e) => setSigForm({ ...sigForm, phone: e.target.value })}
                    placeholder="+91 98250 12345"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                    Company Website
                  </label>
                  <input
                    type="text"
                    value={sigForm.website}
                    onChange={(e) => setSigForm({ ...sigForm, website: e.target.value })}
                    placeholder="https://delpat.in"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                  Confidentiality Disclaimer
                </label>
                <textarea
                  rows={2}
                  value={sigForm.customText}
                  onChange={(e) => setSigForm({ ...sigForm, customText: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:border-sky-500"
                />
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
