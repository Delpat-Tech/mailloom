import React, { useEffect, useRef, useState } from 'react';
import { Copy, ImagePlus, Pencil, Plus, Trash2 } from 'lucide-react';
import type { AccountSettings, AccountTemplate } from '../../services/accountSettings.js';
import { RichEditor } from '../RichEditor.js';
import { composeSignatureHtml } from '../../services/signatures.js';
import { readImageFile, htmlToPlainText } from '../../services/richtext.js';
import { BUILT_IN_TEMPLATES, extractVariables, newTemplateId, toAccountTemplate } from '../../services/templates.js';
import type { ConfirmRequest } from '../ConfirmDialog.js';
import { BTN, BTN_PRIMARY, Card, ErrorNote, INPUT, SectionTitle } from './ui.js';

/** The server keeps a logo up to this size (decoded). */
export const LOGO_MAX_BYTES = 200 * 1024;
export const MAX_TEMPLATES = 50;

interface Props {
  settings: AccountSettings;
  /** Resolves when saved; rejects with a readable Error. */
  save: (patch: { signature?: { html: string; logo: string | null }; templates?: AccountTemplate[] }) => Promise<void>;
  requestConfirm: (r: ConfirmRequest) => void;
}

const Signature: React.FC<Pick<Props, 'settings' | 'save'>> = ({ settings, save }) => {
  const [html, setHtml] = useState(settings.signature.html);
  const [logo, setLogo] = useState<string | null>(settings.signature.logo);
  const [editorKey, setEditorKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = html !== settings.signature.html || logo !== settings.signature.logo;

  // Another device saved a new signature and nothing here is unsaved: show it.
  const version = settings.version;
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    if (!dirty) {
      setHtml(settings.signature.html);
      setLogo(settings.signature.logo);
      setEditorKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const preview = composeSignatureHtml({ html, logo });

  const pickLogo = async (file: File | undefined) => {
    if (!file) return;
    try {
      setLogo(await readImageFile(file, LOGO_MAX_BYTES));
      setError(null);
      setSaved(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onSave = async () => {
    setBusy(true);
    setError(null);
    try {
      await save({ signature: { html, logo } });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The signature could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-line bg-surface p-4 sm:p-5 space-y-5">
      <div>
        <span className="block text-[14.5px] font-bold text-ink mb-0.5">Signature</span>
        <p className="text-[13px] text-ink-3 mb-2.5">Added to new messages and replies. Leave it empty to send without one.</p>
        <div className="border border-line-2 rounded p-2 bg-sheet">
          <RichEditor
            key={editorKey}
            content={html}
            onChange={(h) => {
              setHtml(h);
              setSaved(false);
            }}
            onError={setError}
            ariaLabel="Signature text"
            placeholder="Name, role, phone, website"
            noPictures="Add your logo with the logo button below the editor."
            contentClassName="min-h-[7rem] max-h-56 overflow-y-auto"
          />
        </div>
      </div>

      <div>
        <span className="block text-[14.5px] font-bold text-ink mb-0.5">Logo</span>
        <p className="text-[13px] text-ink-3 mb-2.5">
          Shown under your signature. PNG, JPEG, GIF or WebP, up to {LOGO_MAX_BYTES / 1024} KB.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          {logo && (
            <span className="h-16 min-w-16 max-w-[12rem] px-2 grid place-items-center rounded border border-line bg-white">
              <img src={logo} alt="Your logo" className="max-h-14 max-w-full" />
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            aria-label="Choose a logo picture"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              void pickLogo(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button type="button" className={BTN} onClick={() => fileRef.current?.click()}>
            <ImagePlus className="w-4 h-4" aria-hidden="true" />
            {logo ? 'Change logo' : 'Upload logo'}
          </button>
          {logo && (
            <button
              type="button"
              className={BTN}
              onClick={() => {
                setLogo(null);
                setSaved(false);
              }}
            >
              Remove logo
            </button>
          )}
        </div>
      </div>

      <div>
        <span className="block text-[14.5px] font-bold text-ink mb-2">Preview</span>
        <div
          aria-label="Signature preview"
          role="group"
          className="rounded border border-dashed border-line-2 bg-sheet px-4 py-3 text-sm text-ink min-h-[3.5rem]"
        >
          {preview ? (
            <div className="ml-editor-content" dangerouslySetInnerHTML={{ __html: preview }} />
          ) : (
            <p className="text-ink-3 text-[13px]">No signature. Messages are sent without one.</p>
          )}
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex items-center gap-3">
        <button type="button" className={BTN_PRIMARY} disabled={!dirty || busy} onClick={() => void onSave()}>
          {busy ? 'Saving…' : 'Save signature'}
        </button>
        <span role="status" className="text-[13px] font-semibold text-ok-ink">
          {saved && !dirty ? 'Saved' : ''}
        </span>
      </div>
    </div>
  );
};

interface Draft {
  id: string;
  name: string;
  subject: string;
  body: string;
  isNew: boolean;
}

const Templates: React.FC<Props> = ({ settings, save, requestConfirm }) => {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const own = settings.templates;
  const full = own.length >= MAX_TEMPLATES;

  const commit = async (next: AccountTemplate[]): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await save({ templates: next });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The templates could not be saved.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const edit = (t: AccountTemplate) =>
    setDraft({ id: t.id, name: t.name, subject: t.subject, body: htmlToPlainText(t.html), isNew: false });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft || !draft.name.trim()) return;
    const t = toAccountTemplate(draft);
    const next = draft.isNew ? [t, ...own] : own.map((o) => (o.id === t.id ? t : o));
    if (await commit(next)) setDraft(null);
  };

  const vars = draft ? extractVariables(draft.subject, draft.body) : [];

  return (
    <div>
      <SectionTitle hint="Messages you reuse. Placeholders such as {{client_name}} are filled in each time you use one.">
        Your templates
      </SectionTitle>
      {error && <ErrorNote>{error}</ErrorNote>}

      {draft ? (
        <form
          onSubmit={(e) => void onSubmit(e)}
          className="rounded border border-line bg-surface p-4 sm:p-5 space-y-4"
          aria-label={draft.isNew ? 'New template' : 'Edit template'}
        >
          <div>
            <label htmlFor="tpl-name" className="block text-[13.5px] font-bold text-ink mb-1">
              Name
            </label>
            <input
              id="tpl-name"
              className={INPUT}
              required
              maxLength={80}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="For example, Quote follow-up"
            />
          </div>
          <div>
            <label htmlFor="tpl-subject" className="block text-[13.5px] font-bold text-ink mb-1">
              Subject
            </label>
            <input
              id="tpl-subject"
              className={INPUT}
              maxLength={200}
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              placeholder="For example, Quotation for {{project_name}}"
            />
          </div>
          <div>
            <label htmlFor="tpl-body" className="block text-[13.5px] font-bold text-ink mb-1">
              Message
            </label>
            <textarea
              id="tpl-body"
              rows={8}
              className={`${INPUT} py-2 leading-relaxed`}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder={'Dear {{client_name}},\n\nThank you for…'}
            />
            <p className="mt-1 text-[13px] text-ink-3">
              Put a placeholder in double curly brackets, for example {'{{client_name}}'}. You fill each one in when you use
              the template.
              {vars.length > 0 && <> Placeholders found: {vars.map((v) => v.key).join(', ')}.</>}
            </p>
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" className={BTN} onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="submit" className={BTN_PRIMARY} disabled={busy || !draft.name.trim()}>
              {busy ? 'Saving…' : 'Save template'}
            </button>
          </div>
        </form>
      ) : (
        <>
          {own.length === 0 ? (
            <p className="rounded border border-line bg-surface px-4 py-4 text-[13.5px] text-ink-3">
              You have no templates yet. Add one, or copy a starter below.
            </p>
          ) : (
            <Card>
              <ul className="list-none m-0 p-0 divide-y divide-line">
                {own.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14.5px] font-bold text-ink truncate">{t.name}</div>
                      <div className="text-[13px] text-ink-3 truncate">{t.subject || 'No subject'}</div>
                    </div>
                    <button
                      type="button"
                      aria-label={`Edit template ${t.name}`}
                      title="Edit"
                      onClick={() => edit(t)}
                      className="t-fast min-h-[44px] min-w-[44px] grid place-items-center rounded text-ink-3 hover:text-ink hover:bg-hover"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete template ${t.name}`}
                      title="Delete"
                      onClick={() =>
                        requestConfirm({
                          title: `Delete the template "${t.name}"?`,
                          message: 'It is removed from every device. Messages you already wrote with it are not changed.',
                          confirmLabel: 'Delete template',
                          danger: true,
                          onConfirm: () => void commit(own.filter((o) => o.id !== t.id))
                        })
                      }
                      className="t-fast min-h-[44px] min-w-[44px] grid place-items-center rounded text-ink-3 hover:text-warn-ink hover:bg-warn-bg"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <div className="mt-3">
            <button
              type="button"
              className={BTN}
              disabled={full}
              onClick={() => setDraft({ id: newTemplateId(), name: '', subject: '', body: '', isNew: true })}
            >
              <Plus className="w-4 h-4" aria-hidden="true" /> Add template
            </button>
            {full && <span className="ml-3 text-[13px] text-ink-3">You can keep up to {MAX_TEMPLATES} templates.</span>}
          </div>
        </>
      )}

      <SectionTitle hint="Ready-made examples from Mailloom. They cannot be changed, but you can copy one and make it your own.">
        Starters
      </SectionTitle>
      <Card>
        <ul className="list-none m-0 p-0 divide-y divide-line">
          {BUILT_IN_TEMPLATES.map((t) => (
            <li key={t.id} className="flex items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-bold text-ink truncate">{t.name}</div>
                <div className="text-[13px] text-ink-3 truncate">{t.subject}</div>
              </div>
              <button
                type="button"
                className={BTN}
                disabled={full || busy}
                aria-label={`Copy ${t.name} to my templates`}
                onClick={() =>
                  void commit([
                    toAccountTemplate({ id: newTemplateId(), name: t.name.slice(0, 80), subject: t.subject, body: t.body }),
                    ...own
                  ])
                }
              >
                <Copy className="w-4 h-4" aria-hidden="true" /> Copy
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
};

export const WritingSection: React.FC<Props> = (props) => (
  <div className="space-y-2">
    <Signature settings={props.settings} save={props.save} />
    <div className="pt-6">
      <Templates {...props} />
    </div>
  </div>
);
