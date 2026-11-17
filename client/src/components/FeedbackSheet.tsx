import React, { useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog.js';
import { api } from '../services/api.js';
import { friendlyError } from '../services/errors.js';
import { collectDetails, detailLines } from '../services/feedback.js';

const MAX_WHAT = 4000;
const MAX_EXPECTED = 2000;
const FIELD =
  'w-full bg-surface border border-line-2 rounded px-3 py-2 text-base sm:text-[14px] text-ink placeholder:text-ink-3';

/** "Report a problem": a short form that sends one email to the Mailloom team from the signed-in mailbox. */
export const FeedbackSheet: React.FC<{
  /** The folder or view the person is looking at (a name only). */
  view: string;
  /** Text to start "What happened?" with (for example from an error message). */
  prefill?: string;
  onClose: () => void;
}> = ({ view, prefill = '', onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, { open: true, onEscape: onClose });
  const [what, setWhat] = useState(prefill);
  const [expected, setExpected] = useState('');
  const [include, setInclude] = useState(true);
  const [error, setError] = useState('');
  const [whatError, setWhatError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const details = useMemo(() => collectDetails(view), [view]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!what.trim()) {
      setWhatError('Tell us what happened.');
      return;
    }
    setWhatError('');
    setError('');
    setBusy(true);
    try {
      await api.sendFeedback({ what: what.trim(), expected: expected.trim(), details: include ? collectDetails(view) : undefined });
      setDone(true);
    } catch (err) {
      setError(friendlyError(err, 'The report could not be sent. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-scrim anim-scrim flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        onClick={(e) => e.stopPropagation()}
        className="anim-dialog w-full max-w-lg max-h-[90vh] flex flex-col bg-surface border border-line rounded shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 id="feedback-title" className="text-base font-extrabold text-ink">
            Report a problem
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:p-1.5 flex items-center justify-center rounded text-ink-3 hover:text-ink hover:bg-hover"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {done ? (
          <div className="px-5 py-6">
            <p role="status" className="text-[14.5px] text-ink">
              Thanks, the Mailloom team has it.
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="t-fast cut-tr min-h-[44px] sm:min-h-[38px] px-4 bg-act hover:bg-act-hov text-act-ink text-[13.5px] font-extrabold"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="overflow-y-auto px-5 py-4 grid gap-4" noValidate>
            <div>
              <label htmlFor="fb-what" className="block text-[13.5px] font-bold text-ink mb-1">
                What happened? <span className="font-semibold text-ink-3">(required)</span>
              </label>
              <textarea
                id="fb-what"
                className={FIELD}
                rows={4}
                maxLength={MAX_WHAT}
                value={what}
                onChange={(e) => setWhat(e.target.value)}
                aria-required="true"
                aria-invalid={whatError ? true : undefined}
                aria-describedby={whatError ? 'fb-what-err' : undefined}
              />
              {whatError && (
                <p id="fb-what-err" role="alert" className="mt-1 text-[13px] font-semibold text-warn-ink">
                  {whatError}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="fb-expected" className="block text-[13.5px] font-bold text-ink mb-1">
                What did you expect? <span className="font-semibold text-ink-3">(optional)</span>
              </label>
              <textarea id="fb-expected" className={FIELD} rows={2} maxLength={MAX_EXPECTED} value={expected} onChange={(e) => setExpected(e.target.value)} />
            </div>
            <div>
              <label className="flex items-start gap-2.5 text-[13.5px] text-ink min-h-[44px] sm:min-h-0">
                <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} className="mt-[3px] w-4 h-4" />
                <span>
                  <span className="font-bold">Include technical details</span>
                  <span className="block text-ink-3 text-[13px]">Helps us find the cause. No message content or subjects.</span>
                </span>
              </label>
              <details className="mt-1 group">
                <summary className="cursor-pointer inline-flex items-center gap-1 text-[13px] font-bold text-ink-2 min-h-[32px]">
                  <ChevronDown className="w-3.5 h-3.5 group-open:rotate-180" aria-hidden="true" /> What is sent
                </summary>
                <dl className="mt-1 rounded border border-line bg-hover px-3 py-2 text-[12.5px] text-ink-2 break-words">
                  {detailLines(details).map(([k, v]) => (
                    <div key={k} className="py-0.5">
                      <dt className="inline font-bold">{k}: </dt>
                      <dd className="inline">{v}</dd>
                    </div>
                  ))}
                  {!include && <p className="mt-1 font-semibold">Not sent, because the box above is off.</p>}
                </dl>
              </details>
            </div>
            {error && (
              <p role="alert" className="rounded bg-warn-bg border border-warn-line text-warn-ink text-[13px] font-semibold px-3 py-2">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="t-fast inline-flex items-center justify-center min-h-[44px] sm:min-h-[38px] px-4 rounded border border-line-2 bg-surface hover:bg-hover text-ink-2 text-[13.5px] font-bold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="t-fast cut-tr inline-flex items-center justify-center min-h-[44px] sm:min-h-[38px] px-4 bg-act hover:bg-act-hov text-act-ink text-[13.5px] font-extrabold disabled:opacity-50"
              >
                {busy ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
