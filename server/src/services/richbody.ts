import { randomUUID } from 'node:crypto';
import { sanitizeOutgoingHtml, htmlToPlainText } from '../utils/outgoing.js';

/** One image that travels inside the mail (multipart/related), never as an attachment. */
export interface InlineImage {
  cid: string; // without angle brackets
  filename: string;
  contentType: string;
  content: Buffer;
}

/** A single inline image may not be larger than this (decoded bytes). */
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

export class RichBodyError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = 'RichBodyError';
  }
}

export interface RichBody {
  html: string;
  text: string;
  inline: InlineImage[];
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** The real type of an image from its first bytes (a mislabelled file is not sent as an image). */
export function sniffImage(b: Buffer): string | undefined {
  if (b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG') return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return undefined;
}

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.floor(bytes / 1024 / 1024)} MB` : `${Math.floor(bytes / 1024)} KB`;
}

/**
 * Turn composer HTML into a safe html part, a plain-text alternative and the inline image parts.
 *  - cid: references are removed by the sanitiser (only data: images come in)
 *  - data:image/... URIs are decoded and converted to new cid parts
 *  - every image is capped at MAX_INLINE_IMAGE_BYTES; all inline images together at `maxTotal`
 */
export function prepareRichBody(
  dirtyHtml: string,
  domain: string,
  opts: { maxTotal: number }
): RichBody {
  const clean = sanitizeOutgoingHtml(dirtyHtml);

  const inline: InlineImage[] = [];
  let total = 0;
  const byData = new Map<string, string>(); // identical data URI -> one part
  let n = 0;

  const add = (img: InlineImage) => {
    if (img.content.length > MAX_INLINE_IMAGE_BYTES) {
      throw new RichBodyError(
        `A picture is larger than the ${formatLimit(MAX_INLINE_IMAGE_BYTES)} limit for pictures in a message.`,
        413
      );
    }
    total += img.content.length;
    if (total > opts.maxTotal) {
      throw new RichBodyError(`The pictures together are larger than the ${formatLimit(opts.maxTotal)} limit.`, 413);
    }
    inline.push(img);
  };

  const html = clean.replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi, (whole, pre: string, srcRaw: string, post: string) => {
    const src = srcRaw.replace(/&amp;/g, '&');
    const m = /^data:(image\/[a-z+.-]+);base64,([a-z0-9+/=\s]+)$/i.exec(src);
    if (!m) return whole;
    const known = byData.get(src);
    if (known) return `${pre}cid:${known}${post}`;
    const b64 = m[2].replace(/\s+/g, '');
    if (Math.floor((b64.length * 3) / 4) > MAX_INLINE_IMAGE_BYTES + 3) {
      throw new RichBodyError(
        `A picture is larger than the ${formatLimit(MAX_INLINE_IMAGE_BYTES)} limit for pictures in a message.`,
        413
      );
    }
    const content = Buffer.from(b64, 'base64');
    const type = sniffImage(content);
    if (!type) throw new RichBodyError('One of the pictures is not a PNG, JPEG, GIF or WebP image.', 400);
    n++;
    const cid = `${randomUUID()}@${domain}`;
    add({ cid, filename: `image-${n}.${EXT[type]}`, contentType: type, content });
    byData.set(src, cid);
    return `${pre}cid:${cid}${post}`;
  });

  return { html, text: htmlToPlainText(html), inline };
}
