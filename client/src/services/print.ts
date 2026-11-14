import { escapeHtml } from './richtext.js';
import { fullDate } from './time.js';
import type { EmailAddress, EmailAttachment, ParsedEmailMessage } from '../types.js';

/*
 * Printing a message (or a whole conversation) from its own document, in a hidden frame: no app chrome,
 * light colours, and long mail runs over as many pages as it needs.
 */

export interface PrintMessage {
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  date: string;
  /** The mail as a full HTML document (as the reader gets it), or null for plain text only. */
  html?: string | null;
  text?: string;
  attachments?: Pick<EmailAttachment, 'filename' | 'size'>[];
}

export function toPrintMessage(m: ParsedEmailMessage): PrintMessage {
  return {
    subject: m.subject,
    from: m.from,
    to: m.to,
    cc: m.cc,
    date: m.date,
    html: m.html,
    text: m.text,
    attachments: m.attachments
  };
}

const addr = (a: EmailAddress) => (a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address);
const addrList = (l?: EmailAddress[]) => (l ?? []).map(addr).join(', ');

function sizeText(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The style and body parts of a mail document. The mail's own selectors for body and html are moved onto a wrapper. */
export function splitMailDocument(html: string): { css: string; body: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const css = Array.from(doc.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join('\n')
    .replace(/(^|[,{}\s])(?:html|body)(?=[\s,{.:#[>+~])/gi, '$1.mailroot');
  doc.querySelectorAll('script, style, base, link, meta, iframe, object, embed').forEach((n) => n.remove());
  return { css, body: doc.body.innerHTML };
}

/**
 * The print document: one block per message (subject, From/To/Cc/Date, attachment names, then the body).
 * The mail bodies are left as empty hosts with data-mail="<n>"; `fillMailHosts` puts each into its own
 * shadow root, so one mail's styles cannot reach another or the header.
 */
export function buildPrintDocument(messages: PrintMessage[]): string {
  const blocks = messages
    .map((m, i) => {
      const cc = addrList(m.cc);
      const atts = (m.attachments ?? []).filter((a) => a.filename);
      return `<article class="msg">
  <h1>${escapeHtml(m.subject || '(No subject)')}</h1>
  <table class="hdr">
    <tr><th>From</th><td>${escapeHtml(addr(m.from))}</td></tr>
    <tr><th>To</th><td>${escapeHtml(addrList(m.to) || 'undisclosed recipients')}</td></tr>
    ${cc ? `<tr><th>Cc</th><td>${escapeHtml(cc)}</td></tr>` : ''}
    <tr><th>Date</th><td>${escapeHtml(fullDate(m.date) || m.date)}</td></tr>
  </table>
  ${
    atts.length
      ? `<p class="atts"><b>Attachments (${atts.length}):</b> ${atts
          .map((a) => escapeHtml(a.filename + (sizeText(a.size) ? ` (${sizeText(a.size)})` : '')))
          .join(', ')}</p>`
      : ''
  }
  <div class="body" data-mail="${i}"></div>
</article>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src * data:">
<title>${escapeHtml(messages[0]?.subject || 'Message')}</title>
<style>
  :root { color-scheme: light; }
  html, body { background: #fff; color: #000; margin: 0; }
  body { font: 11pt/1.45 Arial, Helvetica, sans-serif; padding: 0; }
  .msg { padding: 0 0 14pt; margin: 0 0 14pt; border-bottom: 1px solid #999; }
  .msg:last-child { border-bottom: 0; margin-bottom: 0; }
  h1 { font-size: 16pt; margin: 0 0 8pt; line-height: 1.25; overflow-wrap: anywhere; }
  .hdr { border-collapse: collapse; margin: 0 0 8pt; font-size: 10pt; }
  .hdr th { text-align: left; color: #444; font-weight: 700; padding: 1pt 10pt 1pt 0; vertical-align: top; white-space: nowrap; }
  .hdr td { padding: 1pt 0; overflow-wrap: anywhere; }
  .atts { font-size: 10pt; margin: 0 0 8pt; overflow-wrap: anywhere; }
  .body { border-top: 1px solid #ccc; padding-top: 8pt; overflow: visible; overflow-wrap: anywhere; }
  .body pre { white-space: pre-wrap; font: inherit; margin: 0; }
  img { max-width: 100%; height: auto; }
  @page { margin: 16mm; }
</style></head><body>
${blocks}
</body></html>`;
}

/** Puts each mail's own styles and content into its host (see buildPrintDocument). */
export function fillMailHosts(doc: Document, messages: PrintMessage[]): void {
  messages.forEach((m, i) => {
    const host = doc.querySelector<HTMLElement>(`[data-mail="${i}"]`);
    if (!host) return;
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    if (m.html) {
      const { css, body } = splitMailDocument(m.html);
      root.innerHTML = `<style>.mailroot{background:#fff;color:#000;font:11pt/1.45 Arial,Helvetica,sans-serif;overflow:visible;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}${css}</style><div class="mailroot">${body}</div>`;
    } else {
      const pre = doc.createElement('pre');
      pre.textContent = m.text || 'No text content available for this message.';
      root.appendChild(pre);
    }
  });
}

/** Waits (at most `ms`) for the pictures of a document to load or fail. */
function picturesSettled(doc: Document, ms: number): Promise<void> {
  const imgs = Array.from(doc.images).concat(
    ...Array.from(doc.querySelectorAll<HTMLElement>('[data-mail]')).map((h) => Array.from(h.shadowRoot?.querySelectorAll('img') ?? []))
  );
  const pending = imgs.filter((i) => !i.complete);
  if (pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let left = pending.length;
    const done = () => {
      if (--left <= 0) resolve();
    };
    pending.forEach((i) => {
      i.addEventListener('load', done, { once: true });
      i.addEventListener('error', done, { once: true });
    });
    setTimeout(resolve, ms);
  });
}

/** Prints the messages (oldest first for a conversation) from a hidden frame, then removes the frame. */
export function printMessages(messages: PrintMessage[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (messages.length === 0) {
      resolve();
      return;
    }
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.title = 'Print';
    // Same-origin so that we can fill and print it; no scripts, so mail content cannot run anything.
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      frame.remove();
    };
    frame.onload = () => {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc) {
        cleanup();
        reject(new Error('The print view could not be prepared.'));
        return;
      }
      fillMailHosts(doc, messages);
      void picturesSettled(doc, 4000).then(() => {
        win.addEventListener('afterprint', () => {
          cleanup();
          resolve();
        });
        // Some browsers never send afterprint: the frame goes away after a while anyway.
        setTimeout(() => {
          cleanup();
          resolve();
        }, 120000);
        win.focus();
        win.print();
      });
    };
    frame.srcdoc = buildPrintDocument(messages);
    document.body.appendChild(frame);
  });
}
