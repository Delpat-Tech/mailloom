export interface TemplateVariable {
  key: string;
  label: string;
  defaultValue?: string;
}

export interface EmailTemplate {
  id: string;
  name: string;
  category: 'HR' | 'Interviews' | 'Business' | 'Custom';
  subject: string;
  body: string;
  variables: TemplateVariable[];
  isCustom?: boolean;
}

const CUSTOM_TEMPLATES_KEY = 'mailloom_custom_templates';

export const BUILT_IN_TEMPLATES: EmailTemplate[] = [
  {
    id: 'offer-letter',
    name: 'Job Offer Letter',
    category: 'HR',
    subject: 'Job offer: {{role}}',
    variables: [
      { key: 'candidate_name', label: 'Candidate name' },
      { key: 'role', label: 'Role' },
      { key: 'compensation', label: 'Compensation' },
      { key: 'start_date', label: 'Joining date' },
      { key: 'work_location', label: 'Work location' },
      { key: 'response_deadline', label: 'Reply by' },
      { key: 'sender_name', label: 'Your name' }
    ],
    body: `Dear {{candidate_name}},

We are pleased to offer you the position of {{role}}.

Offer details:
- Role: {{role}}
- Compensation: {{compensation}}
- Joining date: {{start_date}}
- Work location: {{work_location}}

Please review the attached offer and reply by {{response_deadline}}.

If you have any questions, please get in touch.

Regards,
{{sender_name}}
`
  },
  {
    id: 'internship-completion',
    name: 'Internship / Project Completion Letter',
    category: 'HR',
    subject: 'Internship completion: {{intern_name}}',
    variables: [
      { key: 'intern_name', label: 'Intern name' },
      { key: 'domain', label: 'Project or area' },
      { key: 'duration', label: 'Period' },
      { key: 'mentor_name', label: 'Mentor name' },
      { key: 'sender_name', label: 'Your name' }
    ],
    body: `To whom it may concern,

This is to certify that {{intern_name}} completed an internship in {{domain}} during {{duration}}, under the supervision of {{mentor_name}}.

Regards,
{{sender_name}}
`
  },
  {
    id: 'interview-invitation',
    name: 'Interview Invitation',
    category: 'Interviews',
    subject: 'Interview invitation: {{role}}',
    variables: [
      { key: 'candidate_name', label: 'Candidate name' },
      { key: 'role', label: 'Role' },
      { key: 'interview_time', label: 'Date and time' },
      { key: 'duration', label: 'Length' },
      { key: 'meeting_link', label: 'Meeting link or place' },
      { key: 'interviewer_name', label: 'Interviewer' },
      { key: 'sender_name', label: 'Your name' }
    ],
    body: `Hi {{candidate_name}},

Thank you for your interest in the {{role}} position. We would like to invite you to an interview.

- Time: {{interview_time}}
- Length: {{duration}}
- Where: {{meeting_link}}
- Interviewer: {{interviewer_name}}

Please confirm that this works for you, or suggest another time.

Regards,
{{sender_name}}
`
  },
  {
    id: 'business-proposal',
    name: 'Business Proposal and Follow-up',
    category: 'Business',
    subject: 'Quotation: {{project_title}}',
    variables: [
      { key: 'client_name', label: 'Contact name' },
      { key: 'project_title', label: 'Project or requirement' },
      { key: 'quote_reference', label: 'Quotation reference' },
      { key: 'valid_until', label: 'Valid until' },
      { key: 'sender_name', label: 'Your name' }
    ],
    body: `Dear {{client_name}},

Thank you for discussing your requirements for {{project_title}}.

Please find our quotation attached (reference {{quote_reference}}), valid until {{valid_until}}.

Let us know if you would like any changes to the specification or the terms.

Regards,
{{sender_name}}
`
  }
];

/** The first {{placeholder}} left in the text, or null. */
export function findPlaceholder(text: string): string | null {
  const m = /\{\{\s*[A-Za-z0-9_ -]+\s*\}\}/.exec(text);
  return m ? m[0] : null;
}

export function hasPlaceholders(text: string): boolean {
  return findPlaceholder(text) !== null;
}

export function getCustomTemplates(): EmailTemplate[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TEMPLATES_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function saveCustomTemplate(template: {
  name: string;
  subject: string;
  body: string;
  variables?: TemplateVariable[];
}): EmailTemplate {
  const customTemplates = getCustomTemplates();
  // Extract any {{variable}} tags from subject and body automatically if none provided
  const foundVars: TemplateVariable[] = [];
  const regex = /\{\{([a-zA-Z0-9_]+)\}\}/g;
  let match;
  const combined = `${template.subject} ${template.body}`;
  while ((match = regex.exec(combined)) !== null) {
    const key = match[1];
    if (!foundVars.some((v) => v.key === key)) {
      foundVars.push({ key, label: key.replace(/_/g, ' ') });
    }
  }

  const newTemplate: EmailTemplate = {
    id: `custom-${Date.now()}`,
    name: template.name,
    category: 'Custom',
    subject: template.subject,
    body: template.body,
    variables: template.variables && template.variables.length > 0 ? template.variables : foundVars,
    isCustom: true
  };

  customTemplates.unshift(newTemplate);
  localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(customTemplates));
  return newTemplate;
}

export function deleteCustomTemplate(id: string): void {
  try {
    const updated = getCustomTemplates().filter((t) => t.id !== id);
    localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(updated));
  } catch {
    // Ignore
  }
}

export function getAllTemplates(): EmailTemplate[] {
  return [...BUILT_IN_TEMPLATES, ...getCustomTemplates()];
}

export function fillTemplateVariables(
  template: EmailTemplate,
  values: Record<string, string>
): { subject: string; body: string } {
  let subject = template.subject;
  let body = template.body;

  template.variables.forEach((v) => {
    // An empty field leaves the {{placeholder}} in place, so it cannot be sent by mistake.
    const typed = (values[v.key] ?? v.defaultValue ?? '').trim();
    const val = typed || `{{${v.key}}}`;
    const pattern = new RegExp(`\\{\\{${v.key}\\}\\}`, 'g');
    subject = subject.replace(pattern, () => val);
    body = body.replace(pattern, () => val);
  });

  return { subject, body };
}
