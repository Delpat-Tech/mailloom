export interface AccountSignature {
  name: string;
  designation: string;
  phone: string;
  website: string;
  customText: string;
  enabled: boolean;
}

const STORAGE_PREFIX = 'mailloom_sig_';

export function getDefaultSignature(name: string, email: string): AccountSignature {
  const userName = name && name.trim() ? name.trim() : email.split('@')[0];
  const capitalized = userName
    .split(/[._-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  return {
    name: capitalized || 'Team Member',
    designation: 'Operations & Engineering',
    phone: '+91 98250 12345',
    website: 'https://delpat.in',
    customText: 'Confidentiality Notice: This message and any attachments are intended exclusively for the individual or entity addressed.',
    enabled: true
  };
}

export function getSignatureForAccount(email: string, fallbackName = ''): AccountSignature {
  if (!email) return getDefaultSignature('', '');
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${email.toLowerCase()}`);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {
    // Ignore JSON parse errors
  }

  const def = getDefaultSignature(fallbackName, email);
  saveSignatureForAccount(email, def);
  return def;
}

export function saveSignatureForAccount(email: string, signature: AccountSignature): void {
  if (!email) return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${email.toLowerCase()}`, JSON.stringify(signature));
  } catch {
    // Ignore quota errors
  }
}

export function formatSignatureText(sig: AccountSignature): string {
  if (!sig.enabled) return '';
  const lines = [
    '--',
    sig.name,
    `${sig.designation} | Delpat Technologies`,
    `Phone: ${sig.phone} | Web: ${sig.website}`
  ];
  if (sig.customText && sig.customText.trim()) {
    lines.push(`\n${sig.customText.trim()}`);
  }
  return lines.join('\n');
}

export function formatSignatureHtml(sig: AccountSignature): string {
  if (!sig.enabled) return '';
  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #334155; margin-top: 16px; border-top: 1px solid #e2e8f0; padding-top: 12px;">
  <div style="font-weight: 700; color: #0f172a; font-size: 14px;">${sig.name}</div>
  <div style="color: #64748b; margin-top: 2px;">${sig.designation} &middot; <span style="color: #0284c7; font-weight: 600;">Delpat Technologies</span></div>
  <div style="margin-top: 4px; color: #475569;">
    <span>Phone: <strong>${sig.phone}</strong></span> &middot; 
    <span>Web: <a href="${sig.website}" style="color: #0284c7; text-decoration: none;" target="_blank">${sig.website.replace(/^https?:\/\//, '')}</a></span>
  </div>
  ${sig.customText ? `<div style="margin-top: 8px; font-size: 11px; color: #94a3b8; line-height: 1.4;">${sig.customText}</div>` : ''}
</div>
`.trim();
}
