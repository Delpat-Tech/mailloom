import { usePresence } from './Presence.js';
import React, { useState, useEffect, useRef } from 'react';
import { useDialog } from '../hooks/useDialog.js';
import { X, FileSpreadsheet, ChevronRight, Sparkles } from 'lucide-react';
import { type EmailTemplate, BUILT_IN_TEMPLATES, fillTemplateVariables } from '../services/templates.js';

interface TemplateSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplyTemplate: (result: { subject: string; body: string }) => void;
  /** The person's own templates (kept on the server). They are listed first, then the starters. */
  ownTemplates?: EmailTemplate[];
}

/** Pick a template, fill its placeholders and put it in the message. Templates are added and edited in Settings > Writing. */
export const TemplateSelectorModal: React.FC<TemplateSelectorModalProps> = ({
  isOpen,
  onClose,
  onApplyTemplate,
  ownTemplates = []
}) => {
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const templates = [...ownTemplates, ...BUILT_IN_TEMPLATES];

  const handleSelectTemplate = (t: EmailTemplate) => {
    setSelectedTemplate(t);
    const initialVals: Record<string, string> = {};
    t.variables.forEach((v) => {
      initialVals[v.key] = v.defaultValue || '';
    });
    setVariableValues(initialVals);
  };

  useEffect(() => {
    if (isOpen && !selectedTemplate && templates.length > 0) handleSelectTemplate(templates[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleApply = () => {
    if (!selectedTemplate) return;
    onApplyTemplate(fillTemplateVariables(selectedTemplate, variableValues));
    onClose();
  };

  const dialogRef = useRef<HTMLDivElement>(null);
  useDialog(dialogRef, { open: isOpen, onEscape: onClose });

  const { mounted, leaving } = usePresence(isOpen);
  if (!mounted) return null;

  const currentPreview = selectedTemplate
    ? fillTemplateVariables(selectedTemplate, variableValues)
    : { subject: '', body: '' };

  return (
    <div data-leaving={leaving ? 'true' : undefined} className="fixed inset-0 z-50 bg-scrim anim-scrim flex items-center justify-center p-4 select-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="templates-title"
        className="anim-dialog w-full max-w-3xl bg-surface rounded shadow-2xl border border-line overflow-hidden flex flex-col h-[600px] max-h-full"
      >
        <div className="px-5 py-3.5 bg-surface text-ink flex items-center justify-between border-b border-line">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-act" aria-hidden="true" />
            <div>
              <h3 id="templates-title" className="text-sm font-extrabold tracking-tight">Templates</h3>
              <p className="text-[11px] text-ink-3">Insert a ready-made message. Add and edit your own in Settings, under Writing.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close templates"
            className="p-1 text-ink-3 hover:text-ink hover:bg-hover rounded transition-colors ml-2 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 flex flex-col sm:flex-row overflow-hidden">
          <div className="w-full sm:w-64 max-h-40 sm:max-h-none shrink-0 border-b sm:border-b-0 sm:border-r border-r-0 border-line bg-sheet p-3 overflow-y-auto space-y-1">
            <div className="px-2 pb-1 text-[11px] font-bold text-ink-3">Available templates</div>
            {templates.map((tpl) => {
              const isSelected = selectedTemplate?.id === tpl.id;
              return (
                <div
                  key={tpl.id}
                  onClick={() => handleSelectTemplate(tpl)}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      handleSelectTemplate(tpl);
                    }
                  }}
                  className={`w-full p-2.5 rounded text-left cursor-pointer transition-colors border ${
                    isSelected
                      ? 'bg-surface border-act shadow-sm text-ink'
                      : 'border-transparent text-ink-2 hover:bg-surface hover:border-line'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-semibold px-1.5 py-0.2 rounded bg-hover text-ink-3">
                      {tpl.isCustom ? 'Yours' : tpl.category}
                    </span>
                  </div>
                  <div className="text-xs font-semibold truncate">{tpl.name}</div>
                  <div className="text-[11px] text-ink-3 truncate mt-0.5">{tpl.subject}</div>
                </div>
              );
            })}
          </div>

          {selectedTemplate ? (
            <div className="flex-1 flex flex-col overflow-hidden bg-surface">
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                <div>
                  <label className="block text-[11px] font-bold text-ink-3 mb-1">Subject preview</label>
                  <div className="p-2.5 bg-sheet border border-line rounded text-xs font-semibold text-ink">
                    {currentPreview.subject}
                  </div>
                </div>

                {selectedTemplate.variables.length > 0 && (
                  <div className="p-3.5 bg-sel border border-line rounded space-y-2.5">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-act">
                      <Sparkles className="w-3.5 h-3.5 text-act" />
                      <span>Fill in the placeholders</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                      {selectedTemplate.variables.map((v) => (
                        <div key={v.key}>
                          <label htmlFor={`tpl-var-${v.key}`} className="block text-[11px] font-semibold text-ink-2 mb-0.5 capitalize">
                            {v.label}
                          </label>
                          <input
                            id={`tpl-var-${v.key}`}
                            type="text"
                            value={variableValues[v.key] ?? ''}
                            onChange={(e) => setVariableValues((prev) => ({ ...prev, [v.key]: e.target.value }))}
                            placeholder={v.defaultValue || v.label}
                            className="w-full border border-line rounded px-2.5 py-1.5 text-xs bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-focus focus:border-act"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-[11px] font-bold text-ink-3 mb-1">Message preview</label>
                  <div className="p-3 bg-sheet border border-line rounded text-xs font-sans text-ink-2 whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto">
                    {currentPreview.body}
                  </div>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-line bg-sheet flex items-center justify-between">
                <div className="text-[11px] text-ink-3">Replaces the empty paragraph or the one you are in</div>
                <button
                  type="button"
                  onClick={handleApply}
                  className="flex items-center gap-1.5 bg-act hover:bg-act-hov text-act-ink font-semibold text-xs px-4 py-2 min-h-[44px] sm:min-h-0 rounded shadow-md transition-colors"
                >
                  <span>Insert into message</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-ink-3 text-xs">
              Select a template from the list to preview
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
