import React, { useEffect, useState } from 'react';
import { CheckCircle2, Download, HelpCircle, RefreshCw, Share } from 'lucide-react';
import {
  canInstallPwa,
  checkForUpdate,
  isAppleTouchDevice,
  isPwaInstalled,
  promptPwaInstall,
  subscribePwaInstallState
} from '../../services/pwa.js';
import { BTN, BTN_PRIMARY, Card, Setting } from './ui.js';

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'development';

interface Props {
  onOpenShortcuts: () => void;
  /** Called after the app was installed. */
  onInstalled?: () => void;
}

export const AppSection: React.FC<Props> = ({ onOpenShortcuts, onInstalled }) => {
  const [canInstall, setCanInstall] = useState(() => canInstallPwa());
  const [installed, setInstalled] = useState(() => isPwaInstalled());
  const [update, setUpdate] = useState<'idle' | 'checking' | 'current' | 'updated' | 'unsupported' | 'error'>('idle');
  const apple = isAppleTouchDevice();

  useEffect(
    () =>
      subscribePwaInstallState((can) => {
        setCanInstall(can);
        setInstalled(isPwaInstalled());
      }),
    []
  );

  const install = async () => {
    if (await promptPwaInstall()) {
      setInstalled(true);
      onInstalled?.();
    }
  };

  const check = async () => {
    setUpdate('checking');
    try {
      setUpdate(await checkForUpdate());
    } catch {
      setUpdate('error');
    }
  };

  const installHelp = installed
    ? undefined
    : apple
      ? undefined
      : canInstall
        ? 'Opens Mailloom in its own window, with its own icon.'
        : 'Your browser has not offered to install Mailloom. Look for an install icon in the address bar.';

  return (
    <div>
      <Card>
        <Setting title="Install app" help={installHelp}>
          {installed ? (
            <span className="inline-flex items-center gap-2 text-[14px] font-bold text-ok-ink">
              <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Installed
            </span>
          ) : canInstall ? (
            <button type="button" className={BTN_PRIMARY} onClick={() => void install()}>
              <Download className="w-4 h-4" aria-hidden="true" /> Install app
            </button>
          ) : null}
        </Setting>
        {!installed && apple && (
          <div className="py-3.5 text-[13.5px] text-ink-2">
            <p className="font-bold text-ink mb-1.5">Add Mailloom to your Home Screen</p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>
                Tap Share <Share className="inline w-3.5 h-3.5 -mt-0.5" aria-hidden="true" /> in Safari.
              </li>
              <li>Choose Add to Home Screen.</li>
              <li>Open Mailloom from the Home Screen.</li>
            </ol>
          </div>
        )}

        <Setting title="Version" help="The build of Mailloom you are using.">
          <span className="text-[14px] font-bold text-ink tabular-nums" data-testid="app-version">
            {APP_VERSION}
          </span>
        </Setting>

        <div className="py-3.5 sm:flex sm:items-center sm:justify-between sm:gap-6">
          <div className="mb-2.5 sm:mb-0">
            <div className="text-[14.5px] font-bold text-ink">Updates</div>
            <p role="status" className="mt-0.5 text-[13px] leading-snug text-ink-3">
              {update === 'idle' && 'Mailloom updates itself. Check now if something looks out of date.'}
              {update === 'checking' && 'Checking for a newer version…'}
              {update === 'current' && 'You are on the latest version.'}
              {update === 'updated' && 'A new version is ready. Reload to use it.'}
              {update === 'unsupported' && 'Updates cannot be checked in this browser window.'}
              {update === 'error' && 'The check failed. Check your connection and try again.'}
            </p>
          </div>
          <div className="sm:shrink-0">
            {update === 'updated' ? (
              <button type="button" className={BTN_PRIMARY} onClick={() => window.location.reload()}>
                <RefreshCw className="w-4 h-4" aria-hidden="true" /> Reload
              </button>
            ) : (
              <button type="button" className={BTN} disabled={update === 'checking'} onClick={() => void check()}>
                <RefreshCw
                  className={`w-4 h-4 ${update === 'checking' ? 'animate-spin motion-reduce:animate-none' : ''}`}
                  aria-hidden="true"
                />
                Check for update
              </button>
            )}
          </div>
        </div>

        <Setting title="Help" help="Keyboard shortcuts for moving around and acting on mail quickly.">
          <button type="button" className={BTN} onClick={onOpenShortcuts}>
            <HelpCircle className="w-4 h-4" aria-hidden="true" /> Keyboard shortcuts
          </button>
        </Setting>
      </Card>
    </div>
  );
};
