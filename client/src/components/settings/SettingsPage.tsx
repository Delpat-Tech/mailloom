import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, X } from 'lucide-react';
import type { AccountSettings, AccountSettingsPatch } from '../../services/accountSettings.js';
import type { StoredAccountProfile, UserAccount } from '../../types.js';
import type { Label, LabelColour } from '../../services/labels.js';
import { useDesktop } from '../../hooks/useMediaQuery.js';
import { readThemeChoice } from '../../services/theme.js';
import { LabelsManager } from '../LabelsManager.js';
import { NotificationsPanel } from '../NotificationsPanel.js';
import { ConnectionsPanel } from '../ConnectionsPanel.js';
import type { ConfirmRequest } from '../ConfirmDialog.js';
import { GeneralSection } from './GeneralSection.js';
import { WritingSection } from './WritingSection.js';
import { AccountsSection } from './AccountsSection.js';
import { AppSection, APP_VERSION } from './AppSection.js';
import { SECTIONS, sectionTitle, type SectionId } from './sections.js';
import { ErrorNote, errorMessage } from './ui.js';
import { isPwaInstalled } from '../../services/pwa.js';

export interface SettingsPageProps {
  /** The open section. On a phone null is the list of sections; on a desktop null means General. */
  section: SectionId | null;
  onSection: (id: SectionId | null) => void;
  onClose: () => void;
  settings: AccountSettings | null;
  loadError: string | null;
  onUpdate: (patch: AccountSettingsPatch) => Promise<void>;
  account: UserAccount;
  accounts: StoredAccountProfile[];
  onSwitchAccount: (email: string) => void;
  onRemoveAccount: (email: string) => void;
  onAddAccount: () => void;
  onSignOut: () => void;
  labels: Label[];
  onRenameLabel: (id: string, name: string) => Promise<string | null | void> | void;
  onRecolourLabel: (id: string, colour: LabelColour) => void;
  onDeleteLabel: (id: string) => void;
  onCreateLabel: (name: string, colour: LabelColour) => Promise<string | null | void> | void;
  onMoveLabel: (id: string, position: number) => void;
  requestConfirm: (r: ConfirmRequest) => void;
  notificationPerm: NotificationPermission;
  onOpenShortcuts: () => void;
  onReport?: () => void;
  onInstalled?: () => void;
}

const THEME_NAME = { system: 'System', light: 'Light', dark: 'Dark' } as const;

function summary(id: SectionId, p: SettingsPageProps, s: AccountSettings | null): string {
  switch (id) {
    case 'general':
      return `${THEME_NAME[readThemeChoice()]} theme, pictures ${s ? (s.loadPictures ? 'on' : 'off') : 'on'}`;
    case 'writing': {
      if (!s) return 'Signature and templates';
      const sig = s.signature.html.trim() || s.signature.logo ? 'Signature on' : 'No signature';
      const n = s.templates.length;
      return `${sig}, ${n} ${n === 1 ? 'template' : 'templates'}`;
    }
    case 'notifications':
      return p.notificationPerm === 'granted'
        ? 'Allowed on this device'
        : p.notificationPerm === 'denied'
          ? 'Blocked in this browser'
          : 'Not turned on';
    case 'labels':
      return `${p.labels.length} ${p.labels.length === 1 ? 'label' : 'labels'}`;
    case 'accounts':
      return p.accounts.length > 1 ? `${p.account.email} and ${p.accounts.length - 1} more` : p.account.email;
    case 'connections':
      return 'Keys for Work OS and Claude';
    case 'app':
      return `Version ${APP_VERSION}${isPwaInstalled() ? ', installed' : ''}`;
  }
}

/**
 * Settings. On a phone it is a full screen: the list of sections, then one section at a time, each with its own
 * Back arrow. On a desktop it is a page over the mail area: sections on the left, the open one on the right.
 */
export const SettingsPage: React.FC<SettingsPageProps> = (props) => {
  const { section, onSection, onClose, settings, loadError, onUpdate, requestConfirm } = props;
  const desktop = useDesktop();
  const current: SectionId | null = desktop ? (section ?? 'general') : section;
  const [pending, setPending] = useState<Partial<AccountSettings>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Show a change at once; the server's answer replaces it (or it is taken back when the save fails).
  const view: AccountSettings | null = settings ? { ...settings, ...pending } : null;
  const saveAsync = async (patch: AccountSettingsPatch) => {
    const keys = Object.keys(patch) as (keyof AccountSettings)[];
    setPending((p) => ({ ...p, ...(patch as Partial<AccountSettings>) }));
    try {
      await onUpdate(patch);
    } finally {
      setPending((p) => {
        const n = { ...p };
        for (const k of keys) delete n[k];
        return n;
      });
    }
  };
  const save = (patch: AccountSettingsPatch) => {
    setSaveError(null);
    saveAsync(patch).catch((err) => setSaveError(errorMessage(err)));
  };

  const back = () => (!desktop && section ? onSection(null) : onClose());

  // Escape: one step back (a section to the list on a phone), then out of Settings.
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) backRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Move focus to the heading when the screen changes, so keyboard and screen reader users start at the top.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [current, desktop]);

  const body = (id: SectionId): React.ReactNode => {
    const needsSettings = id === 'general' || id === 'writing';
    if (needsSettings && !view) {
      return loadError ? (
        <ErrorNote>{loadError} Close Settings and open it again to retry.</ErrorNote>
      ) : (
        <p role="status" className="text-[13.5px] text-ink-3">
          Loading your settings…
        </p>
      );
    }
    switch (id) {
      case 'general':
        return <GeneralSection settings={view!} save={save} onOpenShortcuts={props.onOpenShortcuts} />;
      case 'writing':
        return <WritingSection settings={view!} save={saveAsync} requestConfirm={requestConfirm} />;
      case 'notifications':
        return (
          <NotificationsPanel
            key={props.account.handle}
            embedded
            email={props.account.email}
            otherAccounts={Math.max(0, props.accounts.length - 1)}
            onClose={() => undefined}
          />
        );
      case 'labels':
        return (
          <LabelsManager
            embedded
            labels={props.labels}
            onRename={props.onRenameLabel}
            onRecolour={props.onRecolourLabel}
            onDelete={props.onDeleteLabel}
            onCreate={props.onCreateLabel}
            onMove={props.onMoveLabel}
            requestConfirm={requestConfirm}
            onClose={() => undefined}
          />
        );
      case 'accounts':
        return (
          <AccountsSection
            email={props.account.email}
            accounts={props.accounts}
            onSwitch={props.onSwitchAccount}
            onRemove={props.onRemoveAccount}
            onAdd={props.onAddAccount}
            onSignOut={props.onSignOut}
            requestConfirm={requestConfirm}
          />
        );
      case 'connections':
        return <ConnectionsPanel key={props.account.handle} embedded email={props.account.email} onClose={() => undefined} />;
      case 'app':
        return <AppSection onOpenShortcuts={props.onOpenShortcuts} onReport={props.onReport} onInstalled={props.onInstalled} />;
    }
  };

  const heading = 'text-[22px] font-extrabold tracking-tight text-ink focus:outline-none';

  if (!desktop) {
    return (
      <section aria-label="Settings" className="h-full flex flex-col bg-sheet text-ink pt-[env(safe-area-inset-top)]">
        <header className="shrink-0 flex items-center gap-1 px-2 min-h-[56px] bg-surface border-b border-line">
          <button
            type="button"
            onClick={back}
            aria-label={current ? 'Back to Settings' : 'Close Settings'}
            className="t-fast min-h-[44px] min-w-[44px] grid place-items-center rounded text-ink-2 hover:bg-hover"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 ref={headingRef} tabIndex={-1} className="text-[19px] font-extrabold tracking-tight text-ink focus:outline-none truncate">
            {current ? sectionTitle(current) : 'Settings'}
          </h1>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {saveError && <ErrorNote>{saveError}</ErrorNote>}
          {current ? (
            <div key={current}>
              <p className="mb-4 text-[13.5px] text-ink-3">{SECTIONS.find((s) => s.id === current)!.blurb}</p>
              {body(current)}
            </div>
          ) : (
            <ul className="list-none m-0 p-0 rounded border border-line bg-surface divide-y divide-line">
              {SECTIONS.map(({ id, title, icon: Icon }) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => onSection(id)}
                    className="t-fast w-full min-h-[64px] px-4 flex items-center gap-3.5 text-left hover:bg-hover"
                  >
                    <span aria-hidden="true" className="w-10 h-10 grid place-items-center rounded bg-sel text-sel-ink shrink-0">
                      <Icon className="w-5 h-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-bold text-ink">{title}</span>
                      <span className="block text-[13px] text-ink-3 truncate">{summary(id, props, view)}</span>
                    </span>
                    <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Settings" className="h-full overflow-y-auto bg-sheet text-ink">
      <div className="mx-auto w-full max-w-[960px] px-8 pt-8 pb-12">
        <div className="flex items-center justify-between mb-7">
          <h1 ref={headingRef} tabIndex={-1} className={`${heading} text-[26px]`}>
            Settings
          </h1>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Settings"
            title="Close (Esc)"
            className="t-fast min-h-[40px] min-w-[40px] grid place-items-center rounded text-ink-3 hover:text-ink hover:bg-hover"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="grid grid-cols-[210px_minmax(0,1fr)] gap-10 items-start">
          <nav aria-label="Settings sections" className="sticky top-8">
            <ul className="list-none m-0 p-0 space-y-0.5">
              {SECTIONS.map(({ id, title, icon: Icon }) => {
                const on = current === id;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => onSection(id)}
                      aria-current={on ? 'page' : undefined}
                      className={`t-fast w-full min-h-[40px] px-3 flex items-center gap-3 rounded text-[14px] text-left ${
                        on ? 'bg-sel text-sel-ink font-extrabold' : 'font-semibold text-ink-2 hover:bg-hover'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                      {title}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="min-w-0 max-w-[680px]" key={current ?? 'general'}>
            <h2 className="text-[19px] font-extrabold tracking-tight text-ink">{sectionTitle(current ?? 'general')}</h2>
            <p className="mt-0.5 mb-5 text-[13.5px] text-ink-3">{SECTIONS.find((s) => s.id === (current ?? 'general'))!.blurb}</p>
            {saveError && <ErrorNote>{saveError}</ErrorNote>}
            {body(current ?? 'general')}
          </div>
        </div>
      </div>
    </section>
  );
};
