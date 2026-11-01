import React, { useState, useEffect } from 'react';
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
import type { UserAccount } from '../types.js';

interface ConnectModalProps {
  onConnected: (account: UserAccount, token: string, rememberMe: boolean) => void;
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
  onRequestNotifications
}) => {
  const [rememberMe, setRememberMe] = useState(true);

  // Dynamic pun state fetched from free JokeAPI
  const [pun, setPun] = useState<string>('Delivering smiles, one email at a time.');

  useEffect(() => {
    fetch('https://v2.jokeapi.dev/joke/Pun?blacklistFlags=nsfw,religious,political,racist,sexist,explicit&type=single')
      .then((res) => res.json())
      .then((data) => {
        if (data && data.joke) {
          setPun(data.joke);
        }
      })
      .catch(() => {
        const fallbackPuns = [
          "I'd tell you an email joke, but you might not get the message.",
          "To whoever stole my Microsoft Office: You have my Word.",
          "Why did the email go to school? To improve its attachments!",
          "I have a great joke about SMTP, but you might reject it.",
          "Spam in my inbox, jam on my toast."
        ];
        setPun(fallbackPuns[Math.floor(Math.random() * fallbackPuns.length)]);
      });
  }, []);

  // Form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleConnectCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMsg('Please enter both your email address and password.');
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await api.connect({
        email,
        name: email.split('@')[0],
        password,
        imapHost: '127.0.0.1',
        imapPort: 993,
        imapSecure: true,
        smtpHost: '127.0.0.1',
        smtpPort: 587,
        smtpSecure: false
      });
      onConnected(res.account, res.token, rememberMe);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Connection failed. Verify your email and password.');
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 select-none">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-slate-900 px-6 py-6 text-white text-center relative">
          {isAddingAccount && onCancel && (
            <button
              onClick={onCancel}
              className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          <div className="w-11 h-11 rounded-xl bg-sky-500 mx-auto flex items-center justify-center text-white mb-2.5 shadow-lg shadow-sky-500/25">
            <Mail className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold tracking-tight">
            {isAddingAccount ? 'Connect Another Mailbox' : 'Mailloom Webmail'}
          </h2>

          {/* Dynamic Pun fetched live on load */}
          <div className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800/80 border border-slate-700/60 max-w-sm mx-auto text-[11px] text-sky-300 font-medium leading-tight">
            <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="italic">{pun}</span>
          </div>
        </div>

        {/* Error notification */}
        {errorMsg && (
          <div className="bg-red-50 border-b border-red-200 px-6 py-2.5 text-xs text-red-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
            <span className="flex-1">{errorMsg}</span>
          </div>
        )}

        {/* Direct Mailbox Login Form */}
        <form onSubmit={handleConnectCustom} className="p-6 space-y-4 text-xs">
          {/* Email Address */}
          <div>
            <label className="block font-semibold text-slate-700 mb-1">Email Address *</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="akash@delpat.in"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
            />
          </div>

          {/* Password */}
          <div>
            <label className="block font-semibold text-slate-700 mb-1">Password *</label>
            <input
              type="password"
              required
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
              <span className="font-medium text-xs">Remember Me / Stay Signed In (30 days)</span>
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
