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
    subject: 'Job Offer: {{role}} at Delpat Technologies',
    variables: [
      { key: 'candidate_name', label: 'Candidate Name', defaultValue: 'Alex' },
      { key: 'role', label: 'Job Role / Title', defaultValue: 'Software Engineer' },
      { key: 'ctc', label: 'Annual Compensation / CTC', defaultValue: '₹12,00,000 LPA' },
      { key: 'start_date', label: 'Joining Date', defaultValue: 'November 15, 2026' },
      { key: 'response_deadline', label: 'Offer Expiry Date', defaultValue: 'November 5, 2026' }
    ],
    body: `Dear {{candidate_name}},

We are pleased to offer you the position of {{role}} at Delpat Technologies. We were very impressed with your background, skills, and technical aptitude during our interview process, and we believe you will be a fantastic addition to our engineering team.

Here is a summary of your offer details:
• Role: {{role}}
• Annual Compensation (CTC): {{ctc}}
• Proposed Joining Date: {{start_date}}
• Work Location: Vadodara / Hybrid

Please review the attached formal offer letter and employment terms. To accept, kindly sign and return a scanned copy of the agreement by {{response_deadline}}.

If you have any questions regarding your package or joining procedures, please feel free to reach out. We look forward to welcoming you aboard!

Warm regards,
HR Team
Delpat Technologies
`
  },
  {
    id: 'internship-completion',
    name: 'Internship / Project Completion Letter',
    category: 'HR',
    subject: 'Certificate of Internship Completion - {{intern_name}}',
    variables: [
      { key: 'intern_name', label: 'Intern Name', defaultValue: 'Rohan Sharma' },
      { key: 'domain', label: 'Project / Domain Area', defaultValue: 'Full Stack Engineering' },
      { key: 'duration', label: 'Tenure Duration', defaultValue: '3 Months (Aug 2026 - Oct 2026)' },
      { key: 'mentor_name', label: 'Mentor / Lead Name', defaultValue: 'Akash Patel' }
    ],
    body: `To Whom It May Concern,

This is to certify that {{intern_name}} has successfully completed an internship in {{domain}} with Delpat Technologies during the period of {{duration}}.

During the internship tenure, {{intern_name}} worked diligently under the supervision of {{mentor_name}}. Key contributions included system design, API performance optimization, and reliable software delivery.

We observed {{intern_name}} to be hardworking, proactive, and technically sound. We wish them all the best in their academic and future professional endeavors.

Sincerely,
Engineering Management
Delpat Technologies
`
  },
  {
    id: 'interview-invitation',
    name: 'Interview Invitation',
    category: 'Interviews',
    subject: 'Interview Invitation: {{role}} at Delpat Technologies',
    variables: [
      { key: 'candidate_name', label: 'Candidate Name', defaultValue: 'Jordan' },
      { key: 'role', label: 'Role Title', defaultValue: 'Senior Backend Developer' },
      { key: 'interview_time', label: 'Interview Date & Time', defaultValue: 'Tomorrow at 3:00 PM IST' },
      { key: 'meeting_link', label: 'Meeting Link / Platform', defaultValue: 'https://meet.google.com/xyz-abcd-efg' },
      { key: 'interviewer_name', label: 'Interviewer Name', defaultValue: 'Akash Patel' }
    ],
    body: `Hi {{candidate_name}},

Thank you for your interest in joining Delpat Technologies for the {{role}} position. We were very impressed with your profile and would love to invite you for a technical video interview.

Interview Details:
• Position: {{role}}
• Time: {{interview_time}}
• Duration: ~45 minutes
• Meeting Link: {{meeting_link}}
• Interviewer: {{interviewer_name}}

Please confirm if this schedule works for you, or let us know an alternative time slot if you need to reschedule.

Best regards,
Talent Acquisition Team
Delpat Technologies
`
  },
  {
    id: 'business-proposal',
    name: 'General Business Proposal & Follow-up',
    category: 'Business',
    subject: 'Quotation Proposal & Project Scope: {{project_title}}',
    variables: [
      { key: 'client_name', label: 'Client / Contact Name', defaultValue: 'Mr. Verma' },
      { key: 'project_title', label: 'Project / Requirement Title', defaultValue: 'Industrial Fastener Logistics' },
      { key: 'quote_reference', label: 'Quotation Ref #', defaultValue: 'QT-2026-9901' },
      { key: 'valid_until', label: 'Quote Valid Until', defaultValue: 'November 30, 2026' }
    ],
    body: `Dear {{client_name}},

Thank you for taking the time to discuss your requirements for {{project_title}}.

Following up on our conversation, please find attached our formal quotation and project scope breakdown (Reference: {{quote_reference}}).

Key Terms:
• Scope: Complete implementation and delivery as discussed.
• Quotation Validity: {{valid_until}}
• Lead Time: Immediate dispatch upon confirmation.

Please review the attached proposal and let us know if you require any adjustments to specifications or commercial terms.

Looking forward to working together.

Best regards,
Business Development Team
Delpat Technologies
`
  }
];

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
    const val = values[v.key] ?? v.defaultValue ?? `{{${v.key}}}`;
    const pattern = new RegExp(`\\{\\{${v.key}\\}\\}`, 'g');
    subject = subject.replace(pattern, val);
    body = body.replace(pattern, val);
  });

  return { subject, body };
}
