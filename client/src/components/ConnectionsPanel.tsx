import React, { useCallback, useEffect, useState } from 'react';
import { X, KeyRound, Copy, Check, RotateCw, Ban, Pencil, AlertCircle, Plus } from 'lucide-react';
import { connectionsApi, type AgentAuditEntry, type AgentKey, type AgentScope } from '../services/connections.js';

interface ConnectionsPanelProps {
  email: string;
  onClose: () => void;
}

const SCOPE_LABELS: Record<AgentScope, string> = {
  read: 'Read and search mail',
  organise: 'Move, flag, mark read, delete to Trash',
  send: 'Send, reply and forward'
};

function when(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.';
}

/** Connections: keys that let Work OS (Claude) use this mailbox, and what they did. */
export const ConnectionsPanel: React.FC<ConnectionsPanelProps> = ({ email, onClose }) => {
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [apiEnabled, setApiEnabled] = useState(true);
  const [audit, setAudit] = useState<AgentAuditEntry[]>([]);
  const [tab, setTab] = useState<'keys' | 'activity'>('keys');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Create / rotate form
  const [mode, setMode] = useState<{ kind: 'create' } | { kind: 'rotate'; key: AgentKey } | null>(null);
  const [name, setName] = useState('Work OS');
  const [scopes, setScopes] = useState<Record<AgentScope, boolean>>({ read: true, organise: true, send: true });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [k, a] = await Promise.all([connectionsApi.list(), connectionsApi.audit()]);
      setKeys(k.keys);
      setApiEnabled(k.agent_api_enabled);
      setAudit(a.entries);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      const res =
        mode.kind === 'create'
          ? await connectionsApi.create({
              name: name.trim() || 'Work OS',
              scopes: (Object.keys(scopes) as AgentScope[]).filter((s) => scopes[s]),
              password
            })
          : await connectionsApi.rotate(mode.key.id, password);
      setNewKey(res.key);
      setCopied(false);
      setMode(null);
      setPassword('');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k: AgentKey) => {
    if (!window.confirm(`Revoke "${k.name}" (${k.prefix}…)? Work OS will lose access to this mailbox at once.`)) return;
    try {
      await connectionsApi.revoke(k.id);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const rename = async (k: AgentKey) => {
    const next = window.prompt('Name for this key', k.name);
    if (!next || next.trim() === k.name) return;
    try {
      await connectionsApi.rename(k.id, next.trim());
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const copy = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const noScope = !Object.values(scopes).some(Boolean);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="connections-title"
    >
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <KeyRound className="w-5 h-5 text-sky-400" />
            <div>
              <h2 id="connections-title" className="text-sm font-bold text-white">Connections</h2>
              <p className="text-[11px] text-slate-400">Keys that let Work OS (Claude) use {email}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex gap-1 px-5 pt-3">
          {(['keys', 'activity'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === t ? 'bg-sky-950/60 text-sky-300 border border-sky-800/50' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
            >
              {t === 'keys' ? 'Keys' : 'Activity'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {error && (
            <div className="flex items-start gap-2 text-xs text-red-300 bg-red-950/40 border border-red-900/60 rounded-lg px-3 py-2" role="alert">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {!apiEnabled && (
            <div className="text-xs text-amber-200 bg-amber-950/40 border border-amber-900/60 rounded-lg px-3 py-2">
              The agent API is switched off on this server, so keys cannot be used yet.
            </div>
          )}

          {newKey && (
            <div className="border border-sky-800/60 bg-sky-950/30 rounded-xl p-3 space-y-2">
              <div className="text-xs font-semibold text-sky-200">Copy this key now. It will not be shown again.</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[11px] text-white bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 break-all select-all">{newKey}</code>
                <button
                  type="button"
                  onClick={copy}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="text-[11px] text-slate-400">Paste it into Work OS. Anyone with this key can use your mailbox as allowed below.</div>
              <button type="button" onClick={() => setNewKey(null)} className="text-[11px] text-slate-400 hover:text-white underline">
                I have saved it
              </button>
            </div>
          )}

          {tab === 'keys' && (
            <>
              {mode ? (
                <form onSubmit={submit} className="border border-slate-800 rounded-xl p-3 space-y-3 bg-slate-950/40">
                  <div className="text-xs font-semibold text-white">
                    {mode.kind === 'create' ? 'New key' : `New value for "${mode.key.name}" (the old one stops working)`}
                  </div>
                  {mode.kind === 'create' && (
                    <>
                      <label className="block text-[11px] text-slate-400">
                        Name
                        <input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          maxLength={80}
                          className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-600"
                        />
                      </label>
                      <fieldset className="space-y-1.5">
                        <legend className="text-[11px] text-slate-400 mb-1">Allowed</legend>
                        {(Object.keys(SCOPE_LABELS) as AgentScope[]).map((s) => (
                          <label key={s} className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={scopes[s]}
                              onChange={(e) => setScopes({ ...scopes, [s]: e.target.checked })}
                              className="accent-sky-500"
                            />
                            {SCOPE_LABELS[s]}
                          </label>
                        ))}
                      </fieldset>
                    </>
                  )}
                  <label className="block text-[11px] text-slate-400">
                    Your mailbox password (to confirm it is you)
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-600"
                    />
                  </label>
                  <div className="flex gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        setMode(null);
                        setPassword('');
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={busy || !password || (mode.kind === 'create' && noScope)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white"
                    >
                      {busy ? 'Checking…' : mode.kind === 'create' ? 'Create key' : 'Rotate key'}
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setName('Work OS');
                    setScopes({ read: true, organise: true, send: true });
                    setMode({ kind: 'create' });
                  }}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-sky-400 hover:bg-sky-950/40 border border-slate-800"
                >
                  <Plus className="w-3.5 h-3.5" /> New key
                </button>
              )}

              {loading ? (
                <div className="text-xs text-slate-400">Loading…</div>
              ) : keys.length === 0 ? (
                <div className="text-xs text-slate-400">No keys yet.</div>
              ) : (
                <ul className="space-y-2">
                  {keys.map((k) => (
                    <li key={k.id} className="border border-slate-800 rounded-xl px-3 py-2.5 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-white truncate">{k.name}</span>
                          <code className="text-[10px] text-slate-400">{k.prefix}…</code>
                          {k.status !== 'active' && (
                            <span
                              className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${k.status === 'revoked' ? 'bg-slate-800 text-slate-400' : 'bg-amber-950 text-amber-300'}`}
                            >
                              {k.status === 'revoked' ? 'Revoked' : 'Needs new password'}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">{k.scopes.join(', ')}</div>
                        <div className="text-[11px] text-slate-400">
                          Created {when(k.created_at)} · Last used {when(k.last_used_at)}
                        </div>
                        {k.status === 'broken' && (
                          <div className="text-[11px] text-amber-300 mt-0.5">
                            Mailloom could not sign in with this key's password. Rotate it to enter the current password.
                          </div>
                        )}
                      </div>
                      {k.status !== 'revoked' && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button type="button" onClick={() => rename(k)} className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800" title="Rename" aria-label={`Rename ${k.name}`}>
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" onClick={() => setMode({ kind: 'rotate', key: k })} className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800" title="Rotate" aria-label={`Rotate ${k.name}`}>
                            <RotateCw className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" onClick={() => revoke(k)} className="p-1.5 rounded text-red-400 hover:bg-red-950/40" title="Revoke" aria-label={`Revoke ${k.name}`}>
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === 'activity' && (
            audit.length === 0 ? (
              <div className="text-xs text-slate-400">Nothing yet. Every call Work OS makes with your keys appears here.</div>
            ) : (
              <ul className="divide-y divide-slate-800/80">
                {audit.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="py-2 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-200">{e.tool.replace(/_/g, ' ')}</span>
                      <span className="text-slate-400">{when(e.at)}</span>
                    </div>
                    <div className="text-slate-400">
                      <code>{e.key_prefix}…</code> · {e.result}
                      {e.workos_user ? ` · for ${e.workos_user}` : ''}
                    </div>
                    {e.subject !== null && <div className="text-slate-300 truncate">Subject: {e.subject}</div>}
                    {e.recipients && <div className="text-slate-300 truncate">To: {e.recipients.join(', ')}</div>}
                    {!e.recipients && e.folder && <div className="text-slate-400 truncate">{e.folder}{e.message_id ? ` · ${e.message_id}` : ''}</div>}
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      </div>
    </div>
  );
};
