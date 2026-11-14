import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Bell, BellOff, AlertCircle, Smartphone, Share } from 'lucide-react';
import { useDialog } from '../hooks/useDialog.js';
import {
  currentSubscription,
  pushApi,
  pushAvailability,
  turnOffPush,
  turnOnPush,
  type PushAvailability,
  type PushDevice
} from '../services/push.js';

interface NotificationsPanelProps {
  email: string;
  /** Other accounts signed in in this browser (they may share this device's push subscription). */
  otherAccounts: number;
  onClose: () => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.';
}

function when(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const AVAILABILITY_TEXT: Record<Exclude<PushAvailability, 'ok' | 'ios-needs-install'>, string> = {
  unsupported: 'This browser cannot show notifications while Mailloom is closed.',
  insecure: 'Notifications need a secure (https) connection to Mailloom.',
  denied: 'Notifications are blocked for Mailloom. Allow them in the browser or phone settings, then come back here.'
};

/** Notification settings for this device and mailbox. */
export const NotificationsPanel: React.FC<NotificationsPanelProps> = ({ email, otherAccounts, onClose }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialog(dialogRef, { open: true, onEscape: onClose });

  const [loading, setLoading] = useState(true);
  const [serverOn, setServerOn] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [availability] = useState<PushAvailability>(() => pushAvailability());
  const [device, setDevice] = useState<PushDevice | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [password, setPassword] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cfg, list] = await Promise.all([pushApi.config(), pushApi.devices()]);
      setServerOn(cfg.enabled);
      setPublicKey(cfg.public_key);
      setDevices(list.devices);
      const sub = await currentSubscription();
      const mine = sub ? (await pushApi.device(sub.endpoint)).device : null;
      setDevice(mine);
      if (mine) {
        setShowDetails(mine.show_details);
        setQuiet(mine.quiet);
      }
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

  const on = device?.status === 'on';

  const turnOn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const d = await turnOnPush({ publicKey, password, showDetails, quiet });
      setPassword('');
      setDevice(d);
      setNotice('Notifications are on for this device.');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async (target: PushDevice, isThisDevice: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (isThisDevice) await turnOffPush(target.id, otherAccounts);
      else await pushApi.remove(target.id);
      setNotice(isThisDevice ? 'Notifications are off for this device. The saved password was deleted.' : `Turned off on ${target.label}.`);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const turnOffAll = async () => {
    if (!window.confirm('Turn off notifications on every device for this mailbox? The saved passwords are deleted.')) return;
    setBusy(true);
    setError(null);
    try {
      await pushApi.removeAll();
      if (otherAccounts === 0) await (await currentSubscription())?.unsubscribe().catch(() => undefined);
      setNotice('Notifications are off on all devices. The saved passwords were deleted.');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const changeSetting = async (patch: { show_details?: boolean; quiet?: boolean }) => {
    if (patch.show_details !== undefined) setShowDetails(patch.show_details);
    if (patch.quiet !== undefined) setQuiet(patch.quiet);
    if (!device || !on) return;
    try {
      setDevice((await pushApi.update(device.id, patch)).device);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const sendTest = async () => {
    if (!device) return;
    setError(null);
    setNotice(null);
    try {
      await pushApi.test(device.id);
      setNotice('Test sent. It should appear within a few seconds.');
    } catch (err) {
      setError(errorText(err));
      await load();
    }
  };

  const others = devices.filter((d) => d.id !== device?.id);
  const canTurnOn = serverOn && availability === 'ok' && !!publicKey;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notifications-title"
        className="w-full max-w-lg max-h-[90vh] flex flex-col bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <Bell className="w-5 h-5 text-sky-400" aria-hidden="true" />
            <div>
              <h2 id="notifications-title" className="text-sm font-bold text-white">Notifications</h2>
              <p className="text-[11px] text-slate-400">New mail for {email}, even when Mailloom is closed</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs text-slate-300">
          <div aria-live="polite" className="space-y-2">
            {error && (
              <p role="alert" className="flex items-start gap-2 p-3 rounded-lg bg-rose-950/50 border border-rose-900 text-rose-200">
                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}
            {notice && <p className="p-3 rounded-lg bg-emerald-950/40 border border-emerald-900 text-emerald-200">{notice}</p>}
          </div>

          {loading ? (
            <p>Loading…</p>
          ) : !serverOn ? (
            <p className="p-3 rounded-lg bg-slate-800/60 border border-slate-700">
              Notifications while Mailloom is closed are not set up on this server yet. While Mailloom is open you still see new mail.
            </p>
          ) : availability === 'ios-needs-install' ? (
            <div className="p-3 rounded-lg bg-sky-950/40 border border-sky-900 text-sky-100 space-y-2">
              <p className="flex items-center gap-2 font-semibold">
                <Smartphone className="w-4 h-4" aria-hidden="true" /> Add Mailloom to your Home Screen first
              </p>
              <p>
                On iPhone and iPad, notifications only work in the Mailloom app on the Home Screen. In Safari tap{' '}
                <Share className="inline w-3.5 h-3.5" aria-label="Share" />, then <strong>Add to Home Screen</strong>. Open Mailloom from
                the Home Screen, sign in, and come back here.
              </p>
            </div>
          ) : availability !== 'ok' ? (
            <p className="p-3 rounded-lg bg-slate-800/60 border border-slate-700">{AVAILABILITY_TEXT[availability]}</p>
          ) : null}

          {!loading && device?.status === 'stopped' && (
            <p className="p-3 rounded-lg bg-amber-950/40 border border-amber-900 text-amber-100">
              Notifications stopped on this device: {device.disabled_reason === 'mail server refused the saved password'
                ? 'the mail server no longer accepts the saved password (was it changed?).'
                : device.disabled_reason}{' '}
              Enter your password below to turn them on again.
            </p>
          )}

          {!loading && canTurnOn && (
            <>
              <fieldset className="space-y-2">
                <legend className="sr-only">Settings for this device</legend>
                <label className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={showDetails}
                    onChange={(e) => void changeSetting({ show_details: e.target.checked })}
                  />
                  <span>
                    <span className="font-semibold text-slate-100">Show sender and subject</span>
                    <span className="block text-slate-400">Off: the notification only says “New mail” and how many. Anyone who sees your lock screen sees what is shown.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2.5">
                  <input type="checkbox" className="mt-0.5" checked={quiet} onChange={(e) => void changeSetting({ quiet: e.target.checked })} />
                  <span>
                    <span className="font-semibold text-slate-100">Quiet</span>
                    <span className="block text-slate-400">No sound or vibration; the notification still appears.</span>
                  </span>
                </label>
              </fieldset>

              {on ? (
                <div className="space-y-2">
                  <p className="flex items-center gap-2 text-emerald-300 font-semibold">
                    <Bell className="w-4 h-4" aria-hidden="true" /> On for this device ({device!.label})
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => void sendTest()} className="px-3 py-2 min-h-[44px] rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold">
                      Send a test
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void turnOff(device!, true)}
                      className="px-3 py-2 min-h-[44px] rounded-lg bg-rose-900/60 hover:bg-rose-800/70 text-rose-100 font-semibold disabled:opacity-50"
                    >
                      Turn off on this device
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={(e) => void turnOn(e)} className="space-y-3">
                  <div className="p-3 rounded-lg bg-slate-800/60 border border-slate-700 space-y-1.5">
                    <p className="font-semibold text-slate-100">What is stored</p>
                    <p>
                      To tell you about new mail while Mailloom is closed, the Mailloom server keeps watching your inbox. For that it keeps
                      your mailbox password, encrypted, on the Delpat Mailloom server, for this device only.
                    </p>
                    <p>
                      Turning notifications off here, or signing out on this device, deletes it. The message text is never sent in a notification.
                    </p>
                  </div>
                  <div>
                    <label htmlFor="push-password" className="block font-semibold text-slate-100 mb-1">
                      Mailbox password
                    </label>
                    <input
                      id="push-password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full px-3 py-2 min-h-[44px] rounded-lg bg-slate-950 border border-slate-700 text-white"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busy || !password}
                    className="w-full px-3 py-2 min-h-[44px] rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-bold disabled:opacity-50"
                  >
                    {busy ? 'Turning on…' : 'Turn on notifications for this device'}
                  </button>
                </form>
              )}
            </>
          )}

          {!loading && others.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-slate-800">
              <h3 className="font-bold text-slate-100">Other devices with notifications for this mailbox</h3>
              <ul className="space-y-1.5">
                {others.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-800/50">
                    <span>
                      <span className="font-semibold text-slate-100">{d.label}</span>
                      <span className="block text-slate-400">
                        {d.status === 'on' ? `On since ${when(d.created_at)}` : `Stopped: ${d.disabled_reason ?? 'unknown reason'}`}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void turnOff(d, false)}
                      className="px-2.5 py-1.5 min-h-[44px] rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 font-semibold disabled:opacity-50"
                      aria-label={`Turn off on ${d.label}`}
                    >
                      Turn off
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!loading && devices.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void turnOffAll()}
              className="flex items-center gap-2 text-rose-300 hover:text-rose-200 font-semibold min-h-[44px]"
            >
              <BellOff className="w-4 h-4" aria-hidden="true" /> Turn off on all devices
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
