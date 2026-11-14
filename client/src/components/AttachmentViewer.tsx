import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog.js';
import { useBackLayer } from '../hooks/useBackLayer.js';

/** What the viewer can show: pictures a browser draws everywhere, and PDF. Anything else downloads. */
export function viewerKind(contentType: string, filename = ''): 'image' | 'pdf' | null {
  const t = contentType.toLowerCase().split(';')[0]!.trim();
  if (['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'].includes(t)) return 'image';
  if (t === 'application/pdf') return 'pdf';
  if (t === 'application/octet-stream' || t === '') {
    if (/\.pdf$/i.test(filename)) return 'pdf';
    if (/\.(png|jpe?g|gif|webp)$/i.test(filename)) return 'image';
  }
  return null;
}

/** iPhone and iPad cannot show a PDF inside a frame: it opens in its own tab there. */
export function pdfNeedsNewTab(
  ua = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  touchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints
): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

export interface ViewerTarget {
  filename: string;
  kind: 'image' | 'pdf';
  /** Inline address (shown in the page). */
  src: string;
  /** Address that downloads the file. */
  downloadUrl: string;
}

/** Full-screen viewer for one picture or PDF. Back (phone gesture), Escape and Close all close it. */
export const AttachmentViewer: React.FC<{ target: ViewerTarget; onClose: () => void }> = ({ target, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialog(ref, { open: true, onEscape: onClose, initialFocus: closeRef });
  useBackLayer(true, onClose);
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${target.filename}`}
      className="fixed inset-0 z-[70] flex flex-col bg-black/90 text-white"
    >
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] bg-black/60">
        <span className="flex-1 min-w-0 truncate text-sm font-bold">{target.filename}</span>
        {target.kind === 'pdf' && (
          <a
            href={target.src}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center min-h-[44px] px-3 rounded border border-white/40 text-sm font-bold hover:bg-white/10"
          >
            Open in new tab
          </a>
        )}
        <a
          href={target.downloadUrl}
          download={target.filename}
          className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded border border-white/40 text-sm font-bold hover:bg-white/10"
        >
          <Download className="w-4 h-4" aria-hidden="true" />
          Download
        </a>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded border border-white/40 text-sm font-bold hover:bg-white/10"
        >
          <X className="w-4 h-4" aria-hidden="true" />
          Close
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto grid place-items-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {target.kind === 'image' ? (
          <img src={target.src} alt={target.filename} className="max-w-full max-h-full object-contain" style={{ touchAction: 'pinch-zoom pan-x pan-y' }} />
        ) : (
          <iframe title={target.filename} src={target.src} className="w-full h-full bg-white border-0" />
        )}
      </div>
    </div>,
    document.body
  );
};
