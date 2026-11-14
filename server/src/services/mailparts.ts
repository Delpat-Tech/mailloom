import type { MessageStructureObject } from 'imapflow';
import { cleanFilename } from '../utils/mime.js';

export interface LeafPart {
  /** IMAP part number, usable with BODY[<part>] and client.download */
  partId: string;
  type: string;
  size: number;
  encoding?: string;
  charset?: string;
  disposition?: string;
  filename?: string;
  cid?: string;
  /** True when the part sits inside a multipart/related container. */
  related?: boolean;
}

export interface MessageParts {
  text?: LeafPart[];
  html?: LeafPart[];
  /** Real attachments (listed and downloadable). */
  attachments: LeafPart[];
  /** Inline images referenced by Content-ID (not listed as attachments). */
  inline: LeafPart[];
  all: LeafPart[];
}

function leaves(node: MessageStructureObject, out: LeafPart[], isRoot: boolean, related = false): void {
  const type = (node.type || 'application/octet-stream').toLowerCase();
  const isContainer = Array.isArray(node.childNodes) && node.childNodes.length > 0 && type !== 'message/rfc822';
  if (isContainer) {
    const rel = related || type === 'multipart/related';
    for (const c of node.childNodes!) leaves(c, out, false, rel);
    return;
  }
  const params = node.parameters || {};
  const dparams = node.dispositionParameters || {};
  const rawName = dparams.filename || params.name;
  out.push({
    partId: node.part || (isRoot ? '1' : ''),
    type,
    size: node.size || 0,
    encoding: node.encoding,
    charset: params.charset,
    disposition: node.disposition ? node.disposition.toLowerCase() : undefined,
    filename: rawName ? cleanFilename(rawName, '') || undefined : undefined,
    cid: node.id ? node.id.replace(/^<|>$/g, '') : undefined,
    related
  });
}

/**
 * A part with a Content-ID that the HTML references via cid: is inline whatever its disposition.
 * `referencedCids` (lower-case) is known once the HTML body is read; without it (message list)
 * an image with a Content-ID inside multipart/related counts as inline.
 */
function isInline(p: LeafPart, referencedCids?: Set<string>): boolean {
  if (!p.cid) return false;
  const image = p.type.startsWith('image/');
  if (referencedCids?.has(p.cid.toLowerCase())) return true;
  if (!image) return false;
  if (p.disposition !== 'attachment') return true;
  return !referencedCids && Boolean(p.related);
}

export function classifyParts(root: MessageStructureObject | undefined, referencedCids?: Set<string>): MessageParts {
  const all: LeafPart[] = [];
  if (root) leaves(root, all, true);
  const res: MessageParts = { attachments: [], inline: [], all };
  for (const p of all) {
    if (!p.partId) continue;
    const isBodyText =
      (p.type === 'text/plain' || p.type === 'text/html') && p.disposition !== 'attachment' && !p.filename;
    if (isBodyText) {
      const key = p.type === 'text/html' ? 'html' : 'text';
      (res[key] ||= []).push(p);
    } else if (isInline(p, referencedCids)) {
      res.inline.push(p);
    } else {
      res.attachments.push(p);
    }
  }
  return res;
}

export function findPart(root: MessageStructureObject | undefined, partId: string): LeafPart | undefined {
  return classifyParts(root).all.find((p) => p.partId === partId);
}

export function isValidPartId(partId: string): boolean {
  return /^\d{1,4}(\.\d{1,4}){0,10}$/.test(partId);
}
