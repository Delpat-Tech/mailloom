const REPLACED = new Set(['IMG', 'VIDEO', 'SVG', 'CANVAS', 'IFRAME', 'HR', 'INPUT', 'BUTTON', 'OBJECT', 'EMBED']);

/**
 * How tall a received mail really is: the bottom of its last visible thing (a line of text, a picture,
 * a rule, or a box with a colour or border), plus a 16 px margin. Trailing blank lines, empty
 * paragraphs and spacer blocks do not count, and neither does the height the frame has now.
 * Returns 0 when it cannot tell (the caller keeps the old height).
 */
export function measureMailHeight(doc: Document): number {
  const body = doc.body;
  const view = doc.defaultView;
  if (!body || !view) return 0;
  let bottom = 0;

  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    const parent = (n as Text).parentElement;
    if (parent && view.getComputedStyle(parent).visibility === 'hidden') continue;
    range.selectNodeContents(n);
    for (const r of Array.from(range.getClientRects())) if (r.height > 0) bottom = Math.max(bottom, r.bottom);
  }

  for (const el of Array.from(body.querySelectorAll('*'))) {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) continue;
    const cs = view.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const painted =
      REPLACED.has(el.tagName.toUpperCase()) ||
      (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') ||
      cs.backgroundImage !== 'none' ||
      parseFloat(cs.borderBottomWidth) > 0;
    if (painted) bottom = Math.max(bottom, rect.bottom);
  }

  if (bottom === 0) return 0;
  return Math.ceil(bottom + view.scrollY + 16);
}
