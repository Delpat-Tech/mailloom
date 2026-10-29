import React, { useState } from 'react';
import {
  Mail,
  Sparkles,
  Server,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Lock
} from 'lucide-react';
import { api } from '../services/api.js';
import type { UserAccount } from '../types.js';

interface ConnectModalProps {
  onConnected: (account: UserAccount) => void;
}

type ProviderPreset = 'delpat' | 'custom' | 'gmail' | 'outlook' | 'cpanel';

export const ConnectModal: React.FC<ConnectModalProps> = ({ onConnected }) => {
  const [activeTab, setActiveTab] = useState<'demo' | 'custom'>('demo');
  const [preset, setPreset] = useState<ProviderPreset>('delpat');

  // Custom connection state
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
      onConnected(res.account);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to launch demo account');
      setIsLoading(false);
    }
  };

  const handleConnectCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !imapHost || !smtpHost) {
      setErrorMsg('Please fill in all required server and credential fields.');
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await api.connect({
        email,
        name: name || email.split('@')[0],
        password,
        imapHost,
        imapPort: Number(imapPort),
        imapSecure,
        smtpHost,
        smtpPort: Number(smtpPort),
        smtpSecure
      });
      onConnected(res.account);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Connection failed. Verify host, port, and credentials.');
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 select-none">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-slate-900 px-6 py-6 text-white text-center relative">
          <div className="w-12 h-12 rounded-xl bg-sky-500 mx-auto flex items-center justify-center text-white mb-3 shadow-lg shadow-sky-500/25">
            <Mail className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold tracking-tight">Mailloom Webmail</h2>
          <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
            Lightweight, modern webmail client for Delpat & iRedMail. Live IMAP/SMTP proxy with zero local DB storage.
          </p>

          {/* Tab Selector */}
          <div className="mt-6 flex justify-center">
            <div className="bg-slate-800/80 p-1 rounded-xl flex items-center gap-1">
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
                <span>Live IMAP / SMTP</span>
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

        {/* Tab 1: Instant Demo */}
        {activeTab === 'demo' ? (
          <div className="p-8 flex flex-col items-center text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold mb-4">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Ready in 1 click · No server setup needed</span>
            </div>

            <h3 className="text-base font-bold text-slate-800 mb-2">
              Explore Roundcube with Realistic Business Mail
            </h3>
            <p className="text-xs text-slate-500 max-w-sm mb-6 leading-relaxed">
              Launches an in-memory test mailbox featuring fasteners RFQs, logistics tracking, invoice PDF attachments, and full interactive compose/send functionality.
            </p>

            <button
              onClick={handleLaunchDemo}
              disabled={isLoading}
              className="w-full max-w-sm bg-sky-600 hover:bg-sky-500 active:scale-[0.98] text-white font-semibold text-sm px-6 py-3 rounded-xl shadow-lg shadow-sky-600/25 flex items-center justify-center gap-2 transition-all disabled:opacity-50"
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

            <div className="mt-8 pt-6 border-t border-slate-100 grid grid-cols-3 gap-4 text-center w-full">
              <div>
                <div className="text-xs font-bold text-slate-700">Live IMAP Proxy</div>
                <div className="text-[11px] text-slate-400">Zero permanent DB storage</div>
              </div>
              <div>
                <div className="text-xs font-bold text-slate-700">MIME & Attachments</div>
                <div className="text-[11px] text-slate-400">PDFs, images & files</div>
              </div>
              <div>
                <div className="text-xs font-bold text-slate-700">AES-256-GCM</div>
                <div className="text-[11px] text-slate-400">Encrypted credentials</div>
              </div>
            </div>
          </div>
        ) : (
          /* Tab 2: Custom Mailbox */
          <form onSubmit={handleConnectCustom} className="p-6 overflow-y-auto max-h-[460px] space-y-4 text-xs">
            {/* Presets */}
            <div>
              <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Quick Preset
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {(['delpat', 'gmail', 'outlook', 'cpanel', 'custom'] as ProviderPreset[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handlePresetChange(p)}
                    className={`py-1.5 px-2 rounded-lg text-xs font-medium border capitalize text-center transition-all ${
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

            {/* Email & Name */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Your Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Lakshya Arora"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Email Address *</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => handleEmailChange(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-semibold text-slate-700">Password / App Password *</label>
                {preset === 'gmail' && (
                  <span className="text-[10px] text-sky-600 font-medium">Use a 16-char Google App Password</span>
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

            {/* IMAP Config */}
            <div className="pt-2 border-t border-slate-100">
              <span className="block font-bold text-slate-700 uppercase tracking-wider text-[11px] mb-2">
                Incoming Mail (IMAP)
              </span>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <input
                    type="text"
                    required
                    value={imapHost}
                    onChange={(e) => setImapHost(e.target.value)}
                    placeholder="imap.example.com"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
                  />
                </div>
                <div>
                  <input
                    type="number"
                    required
                    value={imapPort}
                    onChange={(e) => setImapPort(Number(e.target.value))}
                    placeholder="993"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 mt-1.5 text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={imapSecure}
                  onChange={(e) => setImapSecure(e.target.checked)}
                  className="rounded text-sky-600 focus:ring-sky-500"
                />
                <span>Use SSL/TLS</span>
              </label>
            </div>

            {/* SMTP Config */}
            <div className="pt-2 border-t border-slate-100">
              <span className="block font-bold text-slate-700 uppercase tracking-wider text-[11px] mb-2">
                Outgoing Mail (SMTP)
              </span>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <input
                    type="text"
                    required
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.example.com"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
                  />
                </div>
                <div>
                  <input
                    type="number"
                    required
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(Number(e.target.value))}
                    placeholder="465"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 mt-1.5 text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={smtpSecure}
                  onChange={(e) => setSmtpSecure(e.target.checked)}
                  className="rounded text-sky-600 focus:ring-sky-500"
                />
                <span>Use SSL/TLS</span>
              </label>
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
                  <span>Connect & Login</span>
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
