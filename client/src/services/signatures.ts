export interface AccountSignature {
  name: string;
  designation: string;
  phone: string;
  website: string;
  customText: string;
  enabled: boolean;
}

const STORAGE_PREFIX = 'mailloom_sig_';

// Nobody has a signature until they set one.
export function getDefaultSignature(_name?: string, _email?: string): AccountSignature {
  return { name: '', designation: '', phone: '', website: '', customText: '', enabled: false };
}

// Placeholder signature older versions saved automatically for every account.
function isOldPlaceholder(sig: Partial<AccountSignature>): boolean {
  return sig.phone === '+91 98250 12345' || Boolean(sig.customText?.startsWith('Confidentiality Notice: This message'));
}

export function getSignatureForAccount(email: string, _fallbackName = ''): AccountSignature {
  if (!email) return getDefaultSignature();
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${email.toLowerCase()}`);
    if (raw) {
      const parsed = JSON.parse(raw) as AccountSignature;
      if (!isOldPlaceholder(parsed)) return { ...getDefaultSignature(), ...parsed };
    }
  } catch {
    // Ignore JSON parse errors
  }
  return getDefaultSignature();
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
  const lines = [sig.name, sig.designation, [sig.phone, sig.website].filter(Boolean).join(' | '), sig.customText]
    .map((l) => (l || '').trim())
    .filter(Boolean);
  return lines.length > 0 ? ['--', ...lines].join('\n') : '';
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
