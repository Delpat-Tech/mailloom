import React, { useRef, useState } from 'react';
import {
  Mail,
  AlertCircle,
  Lock,
  X,
  Sparkles,
  Download,
  Bell,
  Check
} from 'lucide-react';
import { api } from '../services/api.js';
import { friendlyError } from '../services/errors.js';
import { useDialog } from '../hooks/useDialog.js';
import type { UserAccount } from '../types.js';

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

const LOCAL_PUNS = [
  "I'd tell you an email joke, but you might not get the message.",
  "Why did the email go to school? To improve its attachments!",
  "I have a great joke about SMTP, but you might reject it.",
  "Spam in my inbox, jam on my toast."
];

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

  // Local puns only: the sign-in page makes no third-party requests.
  const [pun] = useState<string>(() => LOCAL_PUNS[Math.floor(Math.random() * LOCAL_PUNS.length)]);

  // Form state
  const [email, setEmail] = useState(reauthEmail || '');
  const [password, setPassword] = useState('');

  const [isLoading, setIsLoading] = useState(false);
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
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        aria-describedby={errorMsg ? 'connect-error' : undefined}
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="bg-slate-900 px-6 py-6 text-white text-center relative">
          {isAddingAccount && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          <div className="w-11 h-11 rounded-xl bg-sky-500 mx-auto flex items-center justify-center text-white mb-2.5 shadow-lg shadow-sky-500/25">
            <Mail className="w-6 h-6" />
          </div>
          <h2 id="connect-title" className="text-xl font-bold tracking-tight">
            {reauthEmail !== undefined ? 'Sign In Again' : isAddingAccount ? 'Connect Another Mailbox' : 'Mailloom Webmail'}
          </h2>

          {/* Light-hearted tagline (local list) */}
          <div className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800/80 border border-slate-700/60 max-w-sm mx-auto text-[11px] text-sky-300 font-medium leading-tight">
            <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="italic">{pun}</span>
          </div>
        </div>

        {/* Error notification */}
        {errorMsg && (
          <div id="connect-error" role="alert" className="bg-red-50 border-b border-red-200 px-6 py-2.5 text-xs text-red-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
            <span className="flex-1">{errorMsg}</span>
          </div>
        )}

        {/* Direct Mailbox Login Form */}
        <form onSubmit={handleConnectCustom} className="p-6 space-y-4 text-xs">
          {/* Email Address */}
          <div>
            <label htmlFor="connect-email" className="block font-semibold text-slate-700 mb-1">Email Address *</label>
            <input
              id="connect-email"
              ref={emailRef}
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
            />
          </div>

          {/* Password */}
          <div>
            <label htmlFor="connect-password" className="block font-semibold text-slate-700 mb-1">Password *</label>
            <input
              id="connect-password"
              ref={passwordRef}
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
            />
          </div>

          {/* Remember Me Checkbox */}
          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-2 text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="rounded text-sky-600 focus:ring-sky-500 w-3.5 h-3.5"
              />
              <span className="font-medium text-xs">Keep me signed in for 30 days (not on a shared computer)</span>
            </label>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-sky-600 hover:bg-sky-500 active:scale-[0.98] text-white font-semibold text-xs py-2.5 rounded-xl shadow-md shadow-sky-600/20 flex items-center justify-center gap-2 transition-all disabled:opacity-50 mt-2"
          >
            {isLoading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
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
          <div className="flex items-center justify-center gap-2 pt-3 border-t border-slate-100 text-[11px]">
            {canInstall && onInstallApp && (
              <button
                type="button"
                onClick={onInstallApp}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 font-semibold transition-all active:scale-[0.98]"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Install App</span>
              </button>
            )}
            {onRequestNotifications && notificationPermission !== 'granted' ? (
              <button
                type="button"
                onClick={onRequestNotifications}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 font-semibold transition-all active:scale-[0.98]"
              >
                <Bell className="w-3.5 h-3.5 text-amber-500" />
                <span>Enable Notifications</span>
              </button>
            ) : (
              <span className="inline-flex items-center gap-1 text-slate-400 font-medium py-1">
                <Check className="w-3 h-3 text-emerald-500" /> Notifications ready
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
