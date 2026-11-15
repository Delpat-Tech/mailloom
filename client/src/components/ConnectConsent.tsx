import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Lock } from 'lucide-react';
import { api, getActiveHandle, isSessionEndedError, setActiveHandle } from '../services/api.js';
import { connectApi, isSafeReturnUrl, type ConnectRequest } from '../services/connect.js';
import type { AgentScope } from '../services/connections.js';
import { friendlyError } from '../services/errors.js';
import type { UserAccount } from '../types.js';
import { ConnectModal } from './ConnectModal.js';
import { Logo } from './Logo.js';
import { PasswordInput } from './PasswordInput.js';

const SCOPE_LABELS: Record<AgentScope, string> = {
  read: 'Read and search mail',
  organise: 'Move, flag, mark read, delete to Trash',
  send: 'Send, reply and forward'
};
const SCOPE_ORDER: AgentScope[] = ['read', 'organise', 'send'];

interface Props {
  requestId: string;
  /** Test hook: where the browser goes after Allow or Cancel. Defaults to window.location.assign. */
  navigate?: (url: string) => void;
}

type Stage =
  | { kind: 'loading' }
  | { kind: 'signin'; email?: string }
  | { kind: 'gone' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; request: ConnectRequest };

/**
 * The consent screen for "Connect Mailloom" (#/connect/<request id>): which app, which mailbox, what it may do,
 * the mailbox password, Allow / Cancel. It signs in first when needed and asks which mailbox when several are
 * signed in. Allow and Cancel both end by sending the browser back to the other app.
 */
export const ConnectConsent: React.FC<Props> = ({ requestId, navigate }) => {
  const [accounts, setAccounts] = useState<UserAccount[] | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [ticks, setTicks] = useState<Record<AgentScope, boolean>>({ read: true, organise: true, send: true });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<null | 'allow' | 'cancel'>(null);
  const [leaving, setLeaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const passwordRef = useRef<HTMLInputElement>(null);

  const go = (url: string) => {
    if (!isSafeReturnUrl(url)) {
      setErrorMsg('Mailloom was sent an address it will not open. Nothing was shared.');
      setBusy(null);
      return;
    }
    setLeaving(true);
    (navigate ?? ((u: string) => window.location.assign(u)))(url);
  };

  // 1. Which mailboxes are signed in here?
  useEffect(() => {
    let live = true;
    api
      .getAccounts()
      .then(({ accounts: list }) => {
        if (!live) return;
        setAccounts(list);
        if (list.length === 0) {
          setStage({ kind: 'signin' });
          return;
        }
        const active = getActiveHandle();
        setHandle((list.find((a) => a.handle === active) ?? list[0]!).handle);
      })
      .catch((err: unknown) => {
        if (live) setStage({ kind: 'error', message: friendlyError(err, 'Cannot reach Mailloom.') });
      });
    return () => {
      live = false;
    };
  }, []);

  // 2. What is being asked, as seen by the chosen mailbox's session.
  useEffect(() => {
    if (!handle) return;
    let live = true;
    setStage({ kind: 'loading' });
    connectApi
      .getRequest(requestId, handle)
      .then((request) => {
        if (!live) return;
        setTicks({ read: true, organise: request.scopes.includes('organise'), send: request.scopes.includes('send') });
        setStage({ kind: 'ready', request });
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (isSessionEndedError(err)) {
          setStage({ kind: 'signin', email: accounts?.find((a) => a.handle === handle)?.email });
        } else if (err && typeof err === 'object' && (err as { status?: number }).status === 404) {
          setStage({ kind: 'gone' });
        } else {
          setStage({ kind: 'error', message: friendlyError(err, 'Cannot reach Mailloom.') });
        }
      });
    return () => {
      live = false;
    };
  }, [handle, requestId, accounts]);

  const signedIn = (account: UserAccount) => {
    // api.connect() already stored the profile and made this account active.
    setAccounts((prev) => [...(prev ?? []).filter((a) => a.handle !== account.handle && a.email.toLowerCase() !== account.email.toLowerCase()), account]);
    setActiveHandle(account.handle);
    setHandle(account.handle);
  };

  if (stage.kind === 'signin') {
    return <ConnectModal onConnected={(acc) => signedIn(acc)} reauthEmail={stage.email} />;
  }

  const shell = (title: string, body: React.ReactNode) => (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-rail overflow-y-auto">
      <div
        role="main"
        aria-labelledby="consent-title"
        className="w-full max-w-md bg-surface rounded shadow-2xl border border-line overflow-hidden flex flex-col max-h-full overflow-y-auto"
      >
        <div className="bg-rail text-rail-ink px-6 pt-6 pb-9 cut-phone">
          <div className="flex items-center gap-3">
            <Logo size={36} className="shrink-0" />
            <h1 id="consent-title" className="text-xl font-extrabold tracking-tight">
              {title}
            </h1>
          </div>
        </div>
        {body}
      </div>
    </div>
  );

  if (stage.kind === 'loading' || accounts === null) {
    return shell('Connect a mailbox', <p role="status" className="p-6 text-xs text-ink-3">Loading…</p>);
  }
  if (stage.kind === 'gone') {
    return shell(
      'Connection expired',
      <p className="p-6 text-[13px] text-ink-2">
        This connection request has expired or was already answered. Go back to the other app and start again.
      </p>
    );
  }
  if (stage.kind === 'error') {
    return shell(
      'Cannot connect',
      <p role="alert" className="p-6 text-[13px] text-warn-ink">
        {stage.message}
      </p>
    );
  }

  const request = stage.request;
  const account = accounts.find((a) => a.handle === handle);
  const who = request.label ? `${request.client_name} (${request.label})` : request.client_name;
  const asked = SCOPE_ORDER.filter((s) => request.scopes.includes(s));

  const allow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handle || !password || busy) return;
    setBusy('allow');
    setErrorMsg(null);
    setAttempts((n) => n + 1);
    try {
      const res = await connectApi.answer(handle, {
        request_id: requestId,
        allow: true,
        scopes: asked.filter((s) => ticks[s]),
        password
      });
      setPassword('');
      go(res.redirect);
    } catch (err) {
      setPassword('');
      setErrorMsg(friendlyError(err, 'That did not work. Please try again.'));
      setBusy(null);
      if (err && typeof err === 'object' && (err as { status?: number }).status === 404) setStage({ kind: 'gone' });
      else passwordRef.current?.focus();
    }
  };

  const cancel = async () => {
    if (!handle || busy) return;
    setBusy('cancel');
    setErrorMsg(null);
    try {
      const res = await connectApi.answer(handle, { request_id: requestId, allow: false });
      go(res.redirect);
    } catch (err) {
      setErrorMsg(friendlyError(err, 'That did not work. Please try again.'));
      setBusy(null);
    }
  };

  return shell(
    `Connect ${request.client_name}`,
    <form onSubmit={allow} className="p-6 space-y-4 text-xs" aria-describedby={errorMsg ? 'consent-error' : undefined}>
      {errorMsg && (
        <div
          id="consent-error"
          role="alert"
          className="flex items-start gap-2 rounded border border-warn-line border-l-4 border-l-warn-ink bg-warn-bg px-3 py-2.5 text-xs text-warn-ink"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" aria-hidden="true" />
          <span className="flex-1">{errorMsg}</span>
        </div>
      )}

      {accounts.length > 1 && (
        <fieldset className="space-y-1.5">
          <legend className="font-bold text-ink-2 mb-1">Connect which mailbox?</legend>
          {accounts.map((a) => (
            <label key={a.handle} className="flex items-center gap-2 text-ink cursor-pointer min-h-[32px]">
              <input
                type="radio"
                name="consent-mailbox"
                checked={a.handle === handle}
                onChange={() => {
                  setPassword('');
                  setErrorMsg(null);
                  setHandle(a.handle);
                }}
                className="accent-act"
              />
              {a.email}
            </label>
          ))}
        </fieldset>
      )}

      <p className="text-[13px] text-ink">
        <strong>{who}</strong> wants to {asked.map((s) => ({ read: 'read', organise: 'move', send: 'send' })[s]).join(', ').replace(/, ([^,]*)$/, ' and $1')} mail as{' '}
        <strong>{account?.email}</strong>.
      </p>

      <fieldset className="space-y-1.5">
        <legend className="font-bold text-ink-2 mb-1">Allow {request.client_name} to</legend>
        {asked.map((s) => (
          <label key={s} className="flex items-center gap-2 text-ink cursor-pointer min-h-[32px]">
            <input
              type="checkbox"
              checked={ticks[s]}
              disabled={s === 'read'}
              onChange={(e) => setTicks({ ...ticks, [s]: e.target.checked })}
              className="accent-act"
            />
            <span>
              {SCOPE_LABELS[s]}
              {s === 'read' && <span className="text-ink-3"> (always on)</span>}
            </span>
          </label>
        ))}
      </fieldset>

      <div>
        <label htmlFor="consent-password" className="block font-bold text-ink-2 mb-1">
          Your mailbox password (to confirm it is you)
        </label>
        <PasswordInput
          id="consent-password"
          ref={passwordRef}
          resetSignal={attempts}
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-surface border border-line-2 rounded px-3 py-2 min-h-[44px] text-base sm:text-sm text-ink focus:outline-none focus:ring-1 focus:ring-focus focus:border-focus"
        />
      </div>

      <p className="text-[11px] text-ink-3">
        After you choose, you go back to {request.redirect_host}. You can end this any time in Mailloom, Settings, Connections.
      </p>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={cancel}
          disabled={busy !== null || leaving}
          className="flex-1 min-h-[44px] rounded border border-line-2 text-ink-2 hover:bg-hover font-bold text-sm disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy !== null || leaving || !password}
          className="flex-1 cut-tr bg-act hover:bg-act-hov text-act-ink font-extrabold text-sm min-h-[44px] flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
        >
          <Lock className="w-3.5 h-3.5" aria-hidden="true" />
          {busy === 'allow' || leaving ? 'Checking…' : 'Allow'}
        </button>
      </div>
    </form>
  );
};
