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
  FolderInput
} from 'lucide-react';
import { format } from 'date-fns';
import type { ParsedEmailMessage, MailboxFolder, EmailAttachment } from '../types.js';
import { api } from '../services/api.js';

interface MessageViewerProps {
  folderPath: string;
  message: ParsedEmailMessage | null;
  isLoading: boolean;
  onToggleFlag: (uid: number, flag: 'isSeen' | 'isFlagged') => void;
  onDelete: (uid: number) => void;
  onMove: (uid: number, targetFolder: string) => void;
  onReply: (message: ParsedEmailMessage, replyAll: boolean) => void;
  onForward: (message: ParsedEmailMessage) => void;
  folders: MailboxFolder[];
}

export const MessageViewer: React.FC<MessageViewerProps> = ({
  folderPath,
  message,
  isLoading,
  onToggleFlag,
  onDelete,
  onMove,
  onReply,
  onForward,
  folders
}) => {
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [viewMode, setViewMode] = useState<'html' | 'text'>('html');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Resize iframe to fit content automatically
  useEffect(() => {
    if (!message || viewMode !== 'html') return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => {
      try {
        if (iframe.contentWindow?.document?.body) {
          const doc = iframe.contentWindow.document;
          // Apply basic styling to ensure it looks modern and readable
          const style = doc.createElement('style');
          style.textContent = `
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              color: #1e293b;
              line-height: 1.6;
              padding: 16px 8px;
              margin: 0;
              word-break: break-word;
            }
            img { max-width: 100%; height: auto; }
            a { color: #0284c7; text-decoration: underline; }
            table { max-width: 100% !important; }
            blockquote {
              border-left: 3px solid #cbd5e1;
              margin: 0.5em 0;
              padding-left: 12px;
              color: #64748b;
            }
          `;
          doc.head.appendChild(style);

          // Adjust height
          const newHeight = Math.max(300, doc.documentElement.scrollHeight);
          iframe.style.height = `${newHeight}px`;
        }
      } catch {
        // Cross-origin restriction if any
      }
    };

    iframe.addEventListener('load', handleLoad);
    return () => iframe.removeEventListener('load', handleLoad);
  }, [message, viewMode]);

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
      <div className="flex-1 bg-white flex flex-col items-center justify-center text-slate-400 gap-3">
        <div className="w-8 h-8 rounded-full border-2 border-sky-500 border-t-transparent animate-spin" />
        <span className="text-xs font-medium">Loading message contents...</span>
      </div>
    );
  }

  if (!message) {
    return (
      <div className="flex-1 bg-slate-50/50 flex flex-col items-center justify-center p-8 text-center select-none">
        <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400 mb-4 shadow-inner">
          <Mail className="w-8 h-8 stroke-1" />
        </div>
        <h3 className="text-base font-bold text-slate-700 mb-1">Select an email</h3>
        <p className="text-xs text-slate-400 max-w-xs">
          Choose a message from the list to preview details, inspect attachments, or compose replies.
        </p>
      </div>
    );
  }

  const formattedDate = (() => {
    try {
      return format(new Date(message.date), 'EEEE, MMMM d, yyyy · h:mm a');
    } catch {
      return message.date;
    }
  })();

  return (
    <div className="flex-1 bg-white flex flex-col h-full overflow-hidden">
      {/* Top Action Toolbar */}
      <div className="px-6 py-2.5 border-b border-slate-100 flex items-center justify-between bg-white shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => onReply(message, false)}
            title="Reply"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <Reply className="w-3.5 h-3.5" />
            <span>Reply</span>
          </button>
          <button
            onClick={() => onReply(message, true)}
            title="Reply All"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <ReplyAll className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Reply All</span>
          </button>
          <button
            onClick={() => onForward(message)}
            title="Forward"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <Forward className="w-3.5 h-3.5" />
            <span>Forward</span>
          </button>

          <div className="h-4 w-[1px] bg-slate-200 mx-1.5" />

          {/* Move to Folder Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowMoveMenu(!showMoveMenu)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              title="Move to folder"
            >
              <FolderInput className="w-3.5 h-3.5" />
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </button>
            {showMoveMenu && (
              <div className="absolute left-0 mt-1 w-48 bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 z-20">
                <div className="px-3 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Move to
                </div>
                {folders
                  .filter((f) => f.path.toLowerCase() !== folderPath.toLowerCase())
                  .map((f) => (
                    <button
                      key={f.path}
                      onClick={() => {
                        onMove(message.uid, f.path);
                        setShowMoveMenu(false);
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-sky-50 hover:text-sky-700 flex items-center gap-2"
                    >
                      <span className="truncate">{f.name}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>

          <button
            onClick={() => onToggleFlag(message.uid, 'isSeen')}
            title="Mark as unread"
            className="p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <Mail className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onToggleFlag(message.uid, 'isFlagged')}
            title={message.isFlagged ? 'Unstar' : 'Star'}
            className="p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <Star
              className={`w-3.5 h-3.5 ${
                message.isFlagged ? 'text-amber-500 fill-amber-500' : 'text-slate-400'
              }`}
            />
          </button>
          <button
            onClick={() => onDelete(message.uid)}
            title="Delete"
            className="p-1.5 text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {message.html && message.text && (
            <div className="flex items-center bg-slate-100 p-0.5 rounded-lg text-[11px] font-medium text-slate-600">
              <button
                onClick={() => setViewMode('html')}
                className={`px-2 py-0.5 rounded ${
                  viewMode === 'html' ? 'bg-white shadow-sm font-semibold text-sky-700' : ''
                }`}
              >
                HTML
              </button>
              <button
                onClick={() => setViewMode('text')}
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
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <Printer className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/* Subject Header */}
        <h2 className="text-xl font-bold text-slate-900 mb-4 tracking-tight leading-snug">
          {message.subject || '(No subject)'}
        </h2>

        {/* Sender & Recipient Information */}
        <div className="flex items-start justify-between pb-4 border-b border-slate-100 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-sky-500 to-indigo-600 text-white font-bold text-sm flex items-center justify-center shrink-0 shadow-sm">
              {(message.from.name || message.from.address || '?').charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm text-slate-900">
                  {message.from.name || message.from.address}
                </span>
                <span className="text-xs text-slate-400">&lt;{message.from.address}&gt;</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-0.5">
                <span>to</span>
                <span className="font-medium text-slate-700">
                  {message.to.map((t) => t.name || t.address).join(', ')}
                </span>
                {(message.cc && message.cc.length > 0) || (message.bcc && message.bcc.length > 0) ? (
                  <button
                    onClick={() => setShowDetails(!showDetails)}
                    className="text-sky-600 hover:underline text-[11px] ml-1 font-medium"
                  >
                    {showDetails ? 'Hide details' : 'Show details'}
                  </button>
                ) : null}
              </div>
              {showDetails && (
                <div className="mt-2 text-xs text-slate-500 bg-slate-50 p-2.5 rounded-lg border border-slate-200/60 space-y-1">
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
                    download={att.filename}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 p-3 bg-white rounded-lg border border-slate-200 hover:border-sky-300 hover:shadow-sm transition-all group"
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
        <div className="email-body min-h-[300px]">
          {viewMode === 'html' && message.html ? (
            <iframe
              ref={iframeRef}
              title="Email body"
              srcDoc={message.html}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              className="w-full border-0 rounded"
              style={{ minHeight: '350px' }}
            />
          ) : (
            <div className="whitespace-pre-wrap font-sans text-sm text-slate-800 leading-relaxed bg-slate-50/40 p-4 rounded-xl border border-slate-100">
              {message.text || 'No text content available for this message.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
