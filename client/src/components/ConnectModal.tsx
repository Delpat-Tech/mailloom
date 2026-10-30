import React, { useState } from 'react';
import {
  Mail,
  Sparkles,
  Server,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Lock,
  ChevronDown,
  X,
  Settings2
} from 'lucide-react';
import { api } from '../services/api.js';
import type { UserAccount } from '../types.js';

interface ConnectModalProps {
  onConnected: (account: UserAccount, token: string, rememberMe: boolean) => void;
  isAddingAccount?: boolean;
  onCancel?: () => void;
}

type ProviderPreset = 'delpat' | 'custom' | 'gmail' | 'outlook' | 'cpanel';

export const ConnectModal: React.FC<ConnectModalProps> = ({
  onConnected,
  isAddingAccount = false,
  onCancel
}) => {
  const [activeTab, setActiveTab] = useState<'custom' | 'demo'>('custom');
  const [preset, setPreset] = useState<ProviderPreset>('delpat');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  // Form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('127.0.0.1');
  const [imapPort, setImapPort] = useState(993);
  const [imapSecure, setImapSecure] = useState(true);
  const [smtpHost, setSmtpHost] = useState('127.0.0.1');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpSecure, setSmtpSecure] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handlePresetChange = (selected: ProviderPreset) => {
    setPreset(selected);
    setErrorMsg(null);
    if (selected === 'delpat') {
      setImapHost('127.0.0.1');
      setImapPort(993);
      setImapSecure(true);
      setSmtpHost('127.0.0.1');
      setSmtpPort(587);
      setSmtpSecure(false);
    } else if (selected === 'gmail') {
      setImapHost('imap.gmail.com');
      setImapPort(993);
      setImapSecure(true);
      setSmtpHost('smtp.gmail.com');
      setSmtpPort(465);
      setSmtpSecure(true);
    } else if (selected === 'outlook') {
      setImapHost('outlook.office365.com');
      setImapPort(993);
      setImapSecure(true);
      setSmtpHost('smtp.office365.com');
      setSmtpPort(587);
      setSmtpSecure(false);
    } else if (selected === 'cpanel') {
      setImapHost('mail.yourdomain.com');
      setImapPort(993);
      setImapSecure(true);
      setSmtpHost('mail.yourdomain.com');
      setSmtpPort(465);
      setSmtpSecure(true);
    } else {
      setImapHost('');
      setSmtpHost('');
    }
  };

  const handleEmailChange = (val: string) => {
    setEmail(val);
    const lower = val.toLowerCase();
    // Auto-detect Delpat domains
    if (
      lower.endsWith('@delpat.in') ||
      lower.endsWith('@houseofhumanity.in') ||
      lower.endsWith('@ydco.in')
    ) {
      if (preset !== 'delpat') {
        handlePresetChange('delpat');
      }
    }
  };

  const handleLaunchDemo = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await api.connect({ isDemo: true });
      onConnected(res.account, res.token, rememberMe);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to launch demo account');
      setIsLoading(false);
    }
  };

  const handleConnectCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMsg('Please enter both your email address and password.');
      return;
    }

    // Default to Delpat server if host fields are hidden/empty
    const finalImapHost = imapHost || '127.0.0.1';
    const finalSmtpHost = smtpHost || '127.0.0.1';

    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await api.connect({
        email,
        name: name || email.split('@')[0],
        password,
        imapHost: finalImapHost,
        imapPort: Number(imapPort),
        imapSecure,
        smtpHost: finalSmtpHost,
        smtpPort: Number(smtpPort),
        smtpSecure
      });
      onConnected(res.account, res.token, rememberMe);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Connection failed. Verify host, port, and credentials.');
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 select-none">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-slate-900 px-6 py-5 text-white text-center relative">
          {isAddingAccount && onCancel && (
            <button
              onClick={onCancel}
              className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          <div className="w-10 h-10 rounded-xl bg-sky-500 mx-auto flex items-center justify-center text-white mb-2 shadow-lg shadow-sky-500/25">
            <Mail className="w-5 h-5" />
          </div>
          <h2 className="text-lg font-bold tracking-tight">
            {isAddingAccount ? 'Connect Another Mailbox' : 'Mailloom Webmail'}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-sm mx-auto">
            {isAddingAccount
              ? 'Log into an additional email account to switch seamlessly anytime.'
              : 'Sign in to access your Delpat mailboxes, sent items, and attachments.'}
          </p>

          {/* Tab Selector */}
          <div className="mt-4 flex justify-center">
            <div className="bg-slate-800/80 p-1 rounded-xl flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setActiveTab('custom');
                  setErrorMsg(null);
                }}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  activeTab === 'custom'
                    ? 'bg-sky-500 text-white shadow-md shadow-sky-500/20'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Server className="w-3.5 h-3.5" />
                <span>Mailbox Login</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('demo');
                  setErrorMsg(null);
                }}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  activeTab === 'demo'
                    ? 'bg-sky-500 text-white shadow-md shadow-sky-500/20'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Instant Demo</span>
              </button>
            </div>
          </div>
        </div>

        {/* Error notification */}
        {errorMsg && (
          <div className="bg-red-50 border-b border-red-200 px-6 py-2.5 text-xs text-red-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
            <span className="flex-1">{errorMsg}</span>
          </div>
        )}

        {/* Tab 1: Direct Mailbox Login */}
        {activeTab === 'custom' ? (
          <form onSubmit={handleConnectCustom} className="p-6 overflow-y-auto max-h-[460px] space-y-3.5 text-xs">
            {/* Primary Fields: Email & Password */}
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Email Address *</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => handleEmailChange(e.target.value)}
                placeholder="akash@delpat.in"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-semibold text-slate-700">Password / App Password *</label>
                {preset === 'gmail' && (
                  <span className="text-[10px] text-sky-600 font-medium">Use a 16-char App Password</span>
                )}
              </div>
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

            {/* Collapsible Advanced Server Settings Accordion */}
            <div className="border border-slate-200/80 rounded-xl overflow-hidden mt-2">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="w-full px-3.5 py-2.5 bg-slate-50 hover:bg-slate-100 flex items-center justify-between text-xs text-slate-600 font-medium transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <Settings2 className="w-3.5 h-3.5 text-slate-400" />
                  <span>Advanced Server Settings</span>
                  {preset === 'delpat' && (
                    <span className="text-[10px] bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded font-semibold ml-1">
                      Local Dovecot/Postfix
                    </span>
                  )}
                </div>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-slate-400 transition-transform ${
                    showAdvanced ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {showAdvanced && (
                <div className="p-3.5 bg-white border-t border-slate-200/80 space-y-3">
                  {/* Presets */}
                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-1">
                      Provider Preset
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                      {(['delpat', 'gmail', 'outlook', 'cpanel', 'custom'] as ProviderPreset[]).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => handlePresetChange(p)}
                          className={`py-1 px-2 rounded-md text-[11px] font-medium border capitalize text-center transition-all ${
                            preset === p
                              ? 'border-sky-500 bg-sky-50 text-sky-700 font-semibold'
                              : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {p === 'delpat' ? 'Delpat' : p === 'cpanel' ? 'cPanel' : p}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Display Name</label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Akash Patel"
                      className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20"
                    />
                  </div>

                  {/* IMAP Config */}
                  <div className="pt-1">
                    <span className="block font-bold text-slate-700 uppercase tracking-wider text-[10px] mb-1">
                      Incoming Mail (IMAP)
                    </span>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-2">
                        <input
                          type="text"
                          value={imapHost}
                          onChange={(e) => setImapHost(e.target.value)}
                          placeholder="127.0.0.1"
                          className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
                        />
                      </div>
                      <div>
                        <input
                          type="number"
                          value={imapPort}
                          onChange={(e) => setImapPort(Number(e.target.value))}
                          placeholder="993"
                          className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
                        />
                      </div>
                    </div>
                    <label className="flex items-center gap-1.5 mt-1 text-[11px] text-slate-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={imapSecure}
                        onChange={(e) => setImapSecure(e.target.checked)}
                        className="rounded text-sky-600"
                      />
                      <span>Use SSL/TLS</span>
                    </label>
                  </div>

                  {/* SMTP Config */}
                  <div className="pt-1">
                    <span className="block font-bold text-slate-700 uppercase tracking-wider text-[10px] mb-1">
                      Outgoing Mail (SMTP)
                    </span>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-2">
                        <input
                          type="text"
                          value={smtpHost}
                          onChange={(e) => setSmtpHost(e.target.value)}
                          placeholder="127.0.0.1"
                          className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
                        />
                      </div>
                      <div>
                        <input
                          type="number"
                          value={smtpPort}
                          onChange={(e) => setSmtpPort(Number(e.target.value))}
                          placeholder="587"
                          className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none"
                        />
                      </div>
                    </div>
                    <label className="flex items-center gap-1.5 mt-1 text-[11px] text-slate-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={smtpSecure}
                        onChange={(e) => setSmtpSecure(e.target.checked)}
                        className="rounded text-sky-600"
                      />
                      <span>Use SSL/TLS</span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-sky-600 hover:bg-sky-500 active:scale-[0.98] text-white font-semibold text-xs py-2.5 rounded-xl shadow-md shadow-sky-600/20 flex items-center justify-center gap-2 transition-all disabled:opacity-50 mt-4"
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
          </form>
        ) : (
          /* Tab 2: Instant Demo */
          <div className="p-6 flex flex-col items-center text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold mb-3">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Ready in 1 click · No server setup needed</span>
            </div>

            <h3 className="text-sm font-bold text-slate-800 mb-1">
              Explore Mailloom with Mock Business Mail
            </h3>
            <p className="text-xs text-slate-500 max-w-sm mb-5 leading-relaxed">
              Launches an in-memory test mailbox featuring fasteners RFQs, logistics tracking, invoice PDF attachments, and full interactive compose/send functionality.
            </p>

            <button
              onClick={handleLaunchDemo}
              disabled={isLoading}
              className="w-full max-w-sm bg-sky-600 hover:bg-sky-500 active:scale-[0.98] text-white font-semibold text-xs px-6 py-2.5 rounded-xl shadow-lg shadow-sky-600/25 flex items-center justify-center gap-2 transition-all disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Connecting Demo Mailbox...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Launch Instant Demo Mailbox</span>
                  <ChevronRight className="w-4 h-4 ml-1" />
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
