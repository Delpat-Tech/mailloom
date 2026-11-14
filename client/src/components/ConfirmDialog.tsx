import { usePresence } from './Presence.js';
import React, { useRef } from 'react';
import { useDialog } from '../hooks/useDialog.js';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** Optional middle choice, e.g. "Save draft". */
  alternateLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onAlternate?: () => void;
}

interface ConfirmDialogProps {
  request: ConfirmRequest | null;
  onClose: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ request, onClose }) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialog(dialogRef, { open: !!request, onEscape: onClose, initialFocus: cancelRef });

  const { mounted, leaving } = usePresence(!!request);
  const lastRequest = useRef<ConfirmRequest | null>(null);
  if (request) lastRequest.current = request;
  const shown = request ?? lastRequest.current;
  if (!mounted || !shown) return null;

  return (
    <div
      data-leaving={leaving ? 'true' : undefined}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim anim-scrim p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className="anim-dialog w-full max-w-sm rounded bg-surface border border-line p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-base font-extrabold text-ink">
          {shown.title}
        </h2>
        <p id="confirm-message" className="mt-2 text-sm text-ink-2">
          {shown.message}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onClose}
            className="rounded border border-line-2 px-3 py-1.5 text-xs font-bold text-ink-2 hover:bg-hover"
          >
            {shown.cancelLabel || 'Cancel'}
          </button>
          {shown.alternateLabel && shown.onAlternate && (
            <button
              onClick={() => {
                const fn = shown.onAlternate!;
                onClose();
                fn();
              }}
              className="rounded border border-line-2 bg-sel px-3 py-1.5 text-xs font-bold text-sel-ink hover:bg-hover"
            >
              {shown.alternateLabel}
            </button>
          )}
          <button
            onClick={() => {
              const fn = shown.onConfirm;
              onClose();
              fn();
            }}
            className={`cut-tr px-4 py-1.5 text-xs font-extrabold text-act-ink ${
              shown.danger ? 'bg-warn hover:brightness-110' : 'bg-act hover:bg-act-hov'
            }`}
          >
            {shown.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
