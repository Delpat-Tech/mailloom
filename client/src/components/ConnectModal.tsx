import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  Lock,
  X,
  Download,
  Bell,
  Check
} from 'lucide-react';
import { api } from '../services/api.js';
import { friendlyError } from '../services/errors.js';
import { useDialog } from '../hooks/useDialog.js';
import type { UserAccount } from '../types.js';
import { Logo } from './Logo.js';
import { PasswordInput } from './PasswordInput.js';

interface ConnectModalProps {
  onConnected: (account: UserAccount, rememberMe: boolean) => void;
  /** Set when an account's session ended: the form is prefilled and explains why. */
  reauthEmail?: string;
  isAddingAccount?: boolean;
  onCancel?: () => void;
  canInstall?: boolean;
  onInstallApp?: () => void;
  notificationPermission?: NotificationPermission;
  onRequestNotifications?: () => void;
}

export const ConnectModal: React.FC<ConnectModalProps> = ({
  onConnected,
  isAddingAccount = false,
  onCancel,
  canInstall = false,
  onInstallApp,
  notificationPermission = 'default',
  onRequestNotifications,
  reauthEmail
}) => {
  // Unticked by default: a short session that ends when idle. Ticked keeps this browser signed in for 30 days.
  const [rememberMe, setRememberMe] = useState(false);

  // Form state
  const [email, setEmail] = useState(reauthEmail || '');
  const [password, setPassword] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(
    reauthEmail !== undefined ? 'Your session has ended. Sign in again to continue; open drafts are kept.' : null
  );

  // Dialog behaviour: focus moves in (to the password when the email is already known), Tab stays inside,
  // and Escape closes it only when there is another signed-in account to go back to.
  const dialogRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const canClose = isAddingAccount && !!onCancel;
  useDialog(dialogRef, {
    open: true,
    onEscape: canClose ? onCancel : undefined,
    initialFocus: () => (reauthEmail ? passwordRef.current : emailRef.current)
  });

  const handleConnectCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMsg('Please enter both your email address and password.');
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);
    setAttempts((n) => n + 1);
    try {
      // Only the email and password are sent; the mail server is fixed in the server's configuration.
      const res = await api.connect({ email: email.trim(), password, rememberMe });
      setPassword('');
      onConnected(res.account, rememberMe);
    } catch (err: unknown) {
      setErrorMsg(friendlyError(err, 'Sign-in failed. Please try again.'));
      setIsLoading(false);
    }
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 select-none ${
        isAddingAccount ? 'bg-scrim anim-scrim' : 'bg-rail'
      }`}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        aria-describedby={errorMsg ? 'connect-error' : undefined}
        className="anim-dialog w-full max-w-md bg-surface rounded shadow-2xl border border-line overflow-hidden flex flex-col max-h-full overflow-y-auto"
      >
        {/* Header */}
        <div className="bg-rail text-rail-ink px-6 pt-6 pb-9 cut-phone relative">
          {isAddingAccount && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className="absolute top-2 right-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-rail-2 hover:text-rail-hov-ink hover:bg-rail-hi rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          <div className="flex items-center gap-3 pr-10">
            <Logo size={36} className="shrink-0" />
            <h2 id="connect-title" className="text-xl font-extrabold tracking-tight">
              {reauthEmail !== undefined ? 'Sign In Again' : isAddingAccount ? 'Connect Another Mailbox' : 'Mailloom Webmail'}
            </h2>
          </div>
          <p className="text-[13px] text-rail-2 mt-2">Sign in with your Delpat mailbox.</p>
        </div>

        {/* Error notification */}
        {/* Direct Mailbox Login Form */}
        <form onSubmit={handleConnectCustom} className="p-6 space-y-4 text-xs">
          {errorMsg && (
            <div id="connect-error" role="alert" className="flex items-start gap-2 rounded border border-warn-line border-l-4 border-l-warn-ink bg-warn-bg px-3 py-2.5 text-xs text-warn-ink">
              <AlertCircle className="w-4 h-4 shrink-0 mt-px" aria-hidden="true" />
              <span className="flex-1">{errorMsg}</span>
            </div>
          )}

          {/* Email Address */}
          <div>
            <label htmlFor="connect-email" className="block font-bold text-ink-2 mb-1">Email Address *</label>
            <input
              id="connect-email"
              ref={emailRef}
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-surface border border-line-2 rounded px-3 py-2 min-h-[44px] text-base sm:text-sm text-ink focus:outline-none focus:ring-1 focus:ring-focus focus:border-focus"
            />
          </div>

          {/* Password */}
          <div>
            <label htmlFor="connect-password" className="block font-bold text-ink-2 mb-1">Password *</label>
            <PasswordInput
              id="connect-password"
              ref={passwordRef}
              resetSignal={attempts}
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full bg-surface border border-line-2 rounded px-3 py-2 min-h-[44px] text-base sm:text-sm text-ink focus:outline-none focus:ring-1 focus:ring-focus focus:border-focus"
            />
          </div>

          {/* Remember Me Checkbox */}
          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-2 text-ink-2 cursor-pointer">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="rounded accent-act w-4 h-4"
              />
              <span className="font-medium text-xs">Keep me signed in for 30 days (not on a shared computer)</span>
            </label>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full cut-tr bg-act hover:bg-act-hov text-act-ink font-extrabold text-sm min-h-[44px] flex items-center justify-center gap-2 transition-colors disabled:opacity-50 mt-2"
          >
            {isLoading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-act-ink border-t-transparent rounded-full animate-spin motion-reduce:animate-none" />
                <span>Verifying Server Connection...</span>
              </>
            ) : (
              <>
                <Lock className="w-3.5 h-3.5" />
                <span>{isAddingAccount ? 'Add Mailbox' : 'Sign In to Mailbox'}</span>
              </>
            )}
          </button>

          {/* Quick Access Utility Actions (PWA install & Notifications) */}
          <div className="flex items-center justify-center gap-2 pt-3 border-t border-line text-[11px]">
            {canInstall && onInstallApp && (
              <button
                type="button"
                onClick={onInstallApp}
                className="inline-flex items-center gap-1.5 px-3 min-h-[44px] sm:min-h-[32px] rounded bg-sel hover:bg-hover text-sel-ink border border-line-2 font-bold transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Install App</span>
              </button>
            )}
            {onRequestNotifications && notificationPermission !== 'granted' ? (
              <button
                type="button"
                onClick={onRequestNotifications}
                className="inline-flex items-center gap-1.5 px-3 min-h-[44px] sm:min-h-[32px] rounded bg-caution-bg hover:brightness-95 text-caution border border-caution-line font-bold transition-colors"
              >
                <Bell className="w-3.5 h-3.5" />
                <span>Enable Notifications</span>
              </button>
            ) : (
              <span className="inline-flex items-center gap-1 text-ink-3 font-semibold py-1">
                <Check className="w-3 h-3 text-ok-ink" /> Notifications ready
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
