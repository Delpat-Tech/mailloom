import { usePresence } from './Presence.js';
import React, { useState, useEffect, useRef } from 'react';
import { useDialog } from '../hooks/useDialog.js';
import {
  X,
  FileSpreadsheet,
  Plus,
  Trash2,
  Check,
  ChevronRight,
  Sparkles
} from 'lucide-react';
import {
  type EmailTemplate,
  getAllTemplates,
  saveCustomTemplate,
  deleteCustomTemplate,
  fillTemplateVariables
} from '../services/templates.js';

interface TemplateSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplyTemplate: (result: { subject: string; body: string }) => void;
}

export const TemplateSelectorModal: React.FC<TemplateSelectorModalProps> = ({
  isOpen,
  onClose,
  onApplyTemplate
}) => {
  const [activeTab, setActiveTab] = useState<'gallery' | 'create'>('gallery');
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});

  // New template form state
  const [customName, setCustomName] = useState('');
  const [customSubject, setCustomSubject] = useState('');
  const [customBody, setCustomBody] = useState('');
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  const loadTemplates = () => {
    const all = getAllTemplates();
    setTemplates(all);
    if (!selectedTemplate && all.length > 0) {
      handleSelectTemplate(all[0]);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadTemplates();
      setFeedbackMsg(null);
    }
  }, [isOpen]);

  const handleSelectTemplate = (t: EmailTemplate) => {
    setSelectedTemplate(t);
    // Initialize variable values with default values
    const initialVals: Record<string, string> = {};
    t.variables.forEach((v) => {
      initialVals[v.key] = v.defaultValue || '';
    });
    setVariableValues(initialVals);
  };

  const handleVariableChange = (key: string, val: string) => {
    setVariableValues((prev) => ({ ...prev, [key]: val }));
  };

  const handleApply = () => {
    if (!selectedTemplate) return;
    const filled = fillTemplateVariables(selectedTemplate, variableValues);
    onApplyTemplate(filled);
    onClose();
  };

  const handleCreateCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName || !customSubject || !customBody) return;

    const created = saveCustomTemplate({
      name: customName,
      subject: customSubject,
      body: customBody
    });

    loadTemplates();
    handleSelectTemplate(created);
    setActiveTab('gallery');
    setCustomName('');
    setCustomSubject('');
    setCustomBody('');
    setFeedbackMsg('Custom template created successfully!');
    setTimeout(() => setFeedbackMsg(null), 3000);
  };

  const handleDeleteCustom = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteCustomTemplate(id);
    const updated = getAllTemplates();
    setTemplates(updated);
    if (selectedTemplate?.id === id) {
      handleSelectTemplate(updated[0] || null);
    }
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
        {/* Header */}
        <div className="px-5 py-3.5 bg-surface text-ink flex items-center justify-between border-b border-line">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-act" aria-hidden="true" />
            <div>
              <h3 id="templates-title" className="text-sm font-extrabold tracking-tight">Email Templates & Canned Responses</h3>
              <p className="text-[11px] text-ink-3">Insert pre-written business letters or create custom drafts</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="bg-sheet border border-line p-0.5 rounded flex items-center text-xs">
              <button
                onClick={() => setActiveTab('gallery')}
                className={`px-3 py-1 min-h-[44px] sm:min-h-0 rounded font-medium transition-colors ${
                  activeTab === 'gallery' ? 'bg-act text-act-ink font-semibold' : 'text-ink-2 hover:bg-hover'
                }`}
              >
                Gallery
              </button>
              <button
                onClick={() => setActiveTab('create')}
                className={`px-3 py-1 min-h-[44px] sm:min-h-0 rounded font-medium transition-colors flex items-center gap-1 ${
                  activeTab === 'create' ? 'bg-act text-act-ink font-semibold' : 'text-ink-2 hover:bg-hover'
                }`}
              >
                <Plus className="w-3 h-3" />
                <span>New</span>
              </button>
            </div>

            <button
              onClick={onClose}
              aria-label="Close templates"
              className="p-1 text-ink-3 hover:text-ink hover:bg-hover rounded transition-colors ml-2 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {feedbackMsg && (
          <div className="bg-toast-bg text-ok-ink text-xs px-5 py-2 border-b border-line flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5 text-ok-ink" />
            <span>{feedbackMsg}</span>
          </div>
        )}

        {/* Tab 1: Gallery */}
        {activeTab === 'gallery' ? (
          <div className="flex-1 flex flex-col sm:flex-row overflow-hidden">
            {/* Left Column: Template List */}
            <div className="w-full sm:w-64 max-h-40 sm:max-h-none shrink-0 border-b sm:border-b-0 sm:border-r border-r-0 border-line bg-sheet p-3 overflow-y-auto space-y-1">
              <div className="px-2 pb-1 text-[11px] font-bold text-ink-3">
                Available Templates
              </div>
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
                        {tpl.category}
                      </span>
                      {tpl.isCustom && (
                        <button
                          type="button"
                          onClick={(e) => handleDeleteCustom(tpl.id, e)}
                          className="text-ink-3 hover:text-warn-ink p-0.5"
                          title="Delete custom template"
                          aria-label={`Delete template ${tpl.name}`}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    <div className="text-xs font-semibold truncate">{tpl.name}</div>
                    <div className="text-[11px] text-ink-3 truncate mt-0.5">{tpl.subject}</div>
                  </div>
                );
              })}
            </div>

            {/* Right Column: Preview & Interactive Variable Fillers */}
            {selectedTemplate ? (
              <div className="flex-1 flex flex-col overflow-hidden bg-surface">
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                  {/* Subject Preview */}
                  <div>
                    <label className="block text-[11px] font-bold text-ink-3 mb-1">
                      Subject Preview
                    </label>
                    <div className="p-2.5 bg-sheet border border-line rounded text-xs font-semibold text-ink">
                      {currentPreview.subject}
                    </div>
                  </div>

                  {/* Variables Inputs Section */}
                  {selectedTemplate.variables.length > 0 && (
                    <div className="p-3.5 bg-sel border border-line rounded space-y-2.5">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-act">
                        <Sparkles className="w-3.5 h-3.5 text-act" />
                        <span>Customize Template Placeholders</span>
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
                              onChange={(e) => handleVariableChange(v.key, e.target.value)}
                              placeholder={v.defaultValue || v.label}
                              className="w-full border border-line rounded px-2.5 py-1.5 text-xs bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-focus focus:border-act"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Body Preview */}
                  <div>
                    <label className="block text-[11px] font-bold text-ink-3 mb-1">
                      Body Preview
                    </label>
                    <div className="p-3 bg-sheet border border-line rounded text-xs font-sans text-ink-2 whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto">
                      {currentPreview.body}
                    </div>
                  </div>
                </div>

                {/* Footer Action */}
                <div className="px-5 py-3 border-t border-line bg-sheet flex items-center justify-between">
                  <div className="text-[11px] text-ink-3">
                    Will replace or insert into your active composer draft
                  </div>
                  <button
                    type="button"
                    onClick={handleApply}
                    className="flex items-center gap-1.5 bg-act hover:bg-act-hov text-act-ink font-semibold text-xs px-4 py-2 min-h-[44px] sm:min-h-0 rounded shadow-md transition-colors"
                  >
                    <span>Insert into Composer</span>
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
        ) : (
          /* Tab 2: Create Custom Template */
          <form onSubmit={handleCreateCustom} className="flex-1 p-6 overflow-y-auto space-y-4 text-xs">
            <div>
              <label htmlFor="tpl-name" className="block font-semibold text-ink-2 mb-1">Template Name *</label>
              <input
                id="tpl-name"
                type="text"
                required
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. Sales Quote Follow-up, NDA Request"
                className="w-full border border-line rounded px-3 py-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-focus focus:border-act"
              />
            </div>

            <div>
              <label htmlFor="tpl-subject" className="block font-semibold text-ink-2 mb-1">Subject Line *</label>
              <input
                id="tpl-subject"
                type="text"
                required
                value={customSubject}
                onChange={(e) => setCustomSubject(e.target.value)}
                placeholder="e.g. Follow up on {{project_name}} for {{client_name}}"
                className="w-full border border-line rounded px-3 py-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-focus focus:border-act"
              />
              <span className="text-[11px] text-ink-3 mt-1 block">
                Tip: Use double curly braces like &#123;&#123;name&#125;&#125; to create dynamic placeholders.
              </span>
            </div>

            <div className="flex-1 flex flex-col">
              <label htmlFor="tpl-body" className="block font-semibold text-ink-2 mb-1">Message Body *</label>
              <textarea
                id="tpl-body"
                required
                rows={8}
                value={customBody}
                onChange={(e) => setCustomBody(e.target.value)}
                placeholder="Dear {{client_name}},&#10;&#10;Following up on our discussion regarding {{project_name}}..."
                className="w-full border border-line rounded p-3 text-xs text-ink font-sans leading-relaxed focus:outline-none focus:ring-2 focus:ring-focus focus:border-act resize-none"
              />
            </div>

            <div className="pt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('gallery')}
                className="px-4 py-2 min-h-[44px] sm:min-h-0 border border-line text-ink-2 rounded hover:bg-sheet transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-5 py-2 min-h-[44px] sm:min-h-0 bg-act hover:bg-act-hov text-act-ink rounded shadow-md font-semibold transition-colors"
              >
                Save Custom Template
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
