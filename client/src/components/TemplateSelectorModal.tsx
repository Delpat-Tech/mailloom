import React, { useState, useEffect } from 'react';
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

  if (!isOpen) return null;

  const currentPreview = selectedTemplate
    ? fillTemplateVariables(selectedTemplate, variableValues)
    : { subject: '', body: '' };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4 select-none">
      <div className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[600px]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-sky-500 text-white shadow-sm">
              <FileSpreadsheet className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-tight">Email Templates & Canned Responses</h3>
              <p className="text-[11px] text-slate-400">Insert pre-written business letters or create custom drafts</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="bg-slate-800 p-0.5 rounded-lg flex items-center text-xs">
              <button
                onClick={() => setActiveTab('gallery')}
                className={`px-3 py-1 rounded-md font-medium transition-all ${
                  activeTab === 'gallery' ? 'bg-sky-500 text-white font-semibold' : 'text-slate-400 hover:text-white'
                }`}
              >
                Gallery
              </button>
              <button
                onClick={() => setActiveTab('create')}
                className={`px-3 py-1 rounded-md font-medium transition-all flex items-center gap-1 ${
                  activeTab === 'create' ? 'bg-sky-500 text-white font-semibold' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Plus className="w-3 h-3" />
                <span>New</span>
              </button>
            </div>

            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors ml-2"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {feedbackMsg && (
          <div className="bg-emerald-50 text-emerald-800 text-xs px-5 py-2 border-b border-emerald-200 flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5 text-emerald-600" />
            <span>{feedbackMsg}</span>
          </div>
        )}

        {/* Tab 1: Gallery */}
        {activeTab === 'gallery' ? (
          <div className="flex-1 flex overflow-hidden">
            {/* Left Column: Template List */}
            <div className="w-64 border-r border-slate-200 bg-slate-50/50 p-3 overflow-y-auto space-y-1">
              <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Available Templates
              </div>
              {templates.map((tpl) => {
                const isSelected = selectedTemplate?.id === tpl.id;
                return (
                  <div
                    key={tpl.id}
                    onClick={() => handleSelectTemplate(tpl)}
                    className={`w-full p-2.5 rounded-xl text-left cursor-pointer transition-all border ${
                      isSelected
                        ? 'bg-white border-sky-300 shadow-sm text-slate-900'
                        : 'border-transparent text-slate-700 hover:bg-white hover:border-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.2 rounded bg-slate-100 text-slate-500">
                        {tpl.category}
                      </span>
                      {tpl.isCustom && (
                        <button
                          type="button"
                          onClick={(e) => handleDeleteCustom(tpl.id, e)}
                          className="text-slate-300 hover:text-red-500 p-0.5"
                          title="Delete custom template"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    <div className="text-xs font-semibold truncate">{tpl.name}</div>
                    <div className="text-[11px] text-slate-400 truncate mt-0.5">{tpl.subject}</div>
                  </div>
                );
              })}
            </div>

            {/* Right Column: Preview & Interactive Variable Fillers */}
            {selectedTemplate ? (
              <div className="flex-1 flex flex-col overflow-hidden bg-white">
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                  {/* Subject Preview */}
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Subject Preview
                    </label>
                    <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800">
                      {currentPreview.subject}
                    </div>
                  </div>

                  {/* Variables Inputs Section */}
                  {selectedTemplate.variables.length > 0 && (
                    <div className="p-3.5 bg-sky-50/50 border border-sky-100 rounded-xl space-y-2.5">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-sky-800">
                        <Sparkles className="w-3.5 h-3.5 text-sky-600" />
                        <span>Customize Template Placeholders</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        {selectedTemplate.variables.map((v) => (
                          <div key={v.key}>
                            <label className="block text-[10px] font-semibold text-slate-600 mb-0.5 capitalize">
                              {v.label}
                            </label>
                            <input
                              type="text"
                              value={variableValues[v.key] ?? ''}
                              onChange={(e) => handleVariableChange(v.key, e.target.value)}
                              placeholder={v.defaultValue || v.label}
                              className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Body Preview */}
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Body Preview
                    </label>
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs font-sans text-slate-700 whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto">
                      {currentPreview.body}
                    </div>
                  </div>
                </div>

                {/* Footer Action */}
                <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
                  <div className="text-[11px] text-slate-400">
                    Will replace or insert into your active composer draft
                  </div>
                  <button
                    type="button"
                    onClick={handleApply}
                    className="flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs px-4 py-2 rounded-xl shadow-md shadow-sky-600/20 transition-all active:scale-[0.98]"
                  >
                    <span>Insert into Composer</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-xs">
                Select a template from the list to preview
              </div>
            )}
          </div>
        ) : (
          /* Tab 2: Create Custom Template */
          <form onSubmit={handleCreateCustom} className="flex-1 p-6 overflow-y-auto space-y-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Template Name *</label>
              <input
                type="text"
                required
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. Sales Quote Follow-up, NDA Request"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Subject Line *</label>
              <input
                type="text"
                required
                value={customSubject}
                onChange={(e) => setCustomSubject(e.target.value)}
                placeholder="e.g. Follow up on {{project_name}} for {{client_name}}"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">
                Tip: Use double curly braces like &#123;&#123;name&#125;&#125; to create dynamic placeholders.
              </span>
            </div>

            <div className="flex-1 flex flex-col">
              <label className="block font-semibold text-slate-700 mb-1">Message Body *</label>
              <textarea
                required
                rows={8}
                value={customBody}
                onChange={(e) => setCustomBody(e.target.value)}
                placeholder="Dear {{client_name}},&#10;&#10;Following up on our discussion regarding {{project_name}}..."
                className="w-full border border-slate-200 rounded-lg p-3 text-xs text-slate-800 font-sans leading-relaxed focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 resize-none"
              />
            </div>

            <div className="pt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('gallery')}
                className="px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-5 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl shadow-md shadow-sky-600/20 font-semibold transition-all active:scale-[0.98]"
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
