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

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className="w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-base font-bold text-slate-900">
          {request.title}
        </h2>
        <p id="confirm-message" className="mt-2 text-sm text-slate-600">
          {request.message}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            {request.cancelLabel || 'Cancel'}
          </button>
          {request.alternateLabel && request.onAlternate && (
            <button
              onClick={() => {
                const fn = request.onAlternate!;
                onClose();
                fn();
              }}
              className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-100"
            >
              {request.alternateLabel}
            </button>
          )}
          <button
            onClick={() => {
              const fn = request.onConfirm;
              onClose();
              fn();
            }}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white ${
              request.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-sky-600 hover:bg-sky-700'
            }`}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
