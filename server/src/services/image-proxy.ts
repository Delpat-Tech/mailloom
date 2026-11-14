import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { sniffImage } from './richbody.js';

/**
 * Remote image proxy.
 *
 * Mail shows remote images through GET /api/image-proxy so the sender never sees the reader's IP,
 * browser or cookies. Because that makes the server fetch URLs on a stranger's behalf, it is
 * locked down hard:
 *  - every URL is signed (HMAC with a key derived from SESSION_SECRET) when the message HTML is
 *    rendered, so the endpoint is not an open proxy; the caller must also be signed in;
 *  - http/https only, ports 80/443 only;
 *  - the host is resolved here, every address is checked, and the connection goes to that vetted
 *    address (no second lookup, so DNS rebinding cannot swap in a private address);
 *  - at most 3 redirects, each hop checked again; 8 s overall; 8 MB at most;
 *  - no cookies, no Referer, a generic User-Agent;
 *  - only bytes that really are a raster image are passed on (SVG is refused).
 */

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 8000;
export const IMAGE_MAX_REDIRECTS = 3;

export type ImageProxyErrorCode =
  | 'BAD_URL'
  | 'BAD_SIGNATURE'
  | 'BLOCKED_ADDRESS'
  | 'BLOCKED_PORT'
  | 'DNS_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'TOO_LARGE'
  | 'NOT_AN_IMAGE'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT';

export class ImageProxyError extends Error {
  constructor(public code: ImageProxyErrorCode) {
    super(code);
    this.name = 'ImageProxyError';
  }
  get status(): number {
    switch (this.code) {
      case 'BAD_URL':
        return 400;
      case 'BAD_SIGNATURE':
      case 'BLOCKED_ADDRESS':
      case 'BLOCKED_PORT':
        return 403;
      case 'TOO_LARGE':
        return 413;
      case 'NOT_AN_IMAGE':
        return 415;
      case 'TIMEOUT':
        return 504;
      default:
        return 502;
    }
  }
}

// ---- signing ----

function signingKey(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'mailloom:image-proxy:v1', 32));
}

export function signImageUrl(secret: string, url: string): string {
  return crypto.createHmac('sha256', signingKey(secret)).update(url, 'utf8').digest('base64url');
}

export function verifyImageSignature(secret: string, url: string, sig: string): boolean {
  if (typeof sig !== 'string' || sig.length !== 43) return false;
  const want = Buffer.from(signImageUrl(secret, url));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** Proxy path for a remote image URL, e.g. "/api/image-proxy?u=...&sig=...&account=...". */
export function proxyImageUrl(secret: string, url: string, base: { prefix?: string; account?: string } = {}): string {
  const q = new URLSearchParams({ u: url, sig: signImageUrl(secret, url) });
  if (base.account) q.set('account', base.account);
  return `${base.prefix ?? ''}/api/image-proxy?${q.toString()}`;
}

// ---- address vetting ----

function v4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved + broadcast
];
const V4_RANGES = V4_BLOCKED.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { net: v4ToInt(base) & mask, mask };
});

function publicV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return !V4_RANGES.some((r) => ((n & r.mask) >>> 0) === (r.net >>> 0));
}

/** Eight 16-bit groups of an IPv6 address (handles "::" and a trailing dotted IPv4). */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (!net.isIPv4(dotted[1]!)) return null;
    const n = v4ToInt(dotted[1]!);
    s = s.slice(0, -dotted[1]!.length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.length === 8 && out.every((x) => !Number.isNaN(x)) ? out : null;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True only for a globally routable unicast address. Everything unparseable is refused. */
export function isPublicAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return publicV4(ip);
  if (kind !== 6) return false;
  const g = expandV6(ip);
  if (!g) return false;
  const [a, b, c, d, e, f, x, y] = g as [number, number, number, number, number, number, number, number];
  // ::/96 (unspecified, loopback, IPv4-compatible): never.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return false;
  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::/96: judged by the embedded IPv4 address.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return publicV4(v4FromGroups(x, y));
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return publicV4(v4FromGroups(x, y));
  // 6to4 2002::/16 embeds an IPv4 address.
  if (a === 0x2002) return publicV4(v4FromGroups(b, c));
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2001 && b === 0) return false; // Teredo
  if ((a & 0xe000) !== 0x2000) return false; // only 2000::/3 is global unicast
  return true;
}

// ---- fetching ----

export interface ImageFetchOptions {
  /** Resolves a host name to its addresses. Tests inject this; default is the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Decides whether an address may be connected to. Tests may widen it to loopback; default isPublicAddress. */
  addressAllowed?: (ip: string) => boolean;
  /** Decides whether a port may be used. Default: 80 and 443 only. */
  portAllowed?: (port: number) => boolean;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface FetchedImage {
  body: Buffer;
  contentType: string;
}

async function systemResolve(host: string): Promise<string[]> {
  const all = await dns.promises.lookup(host, { all: true, verbatim: true });
  return all.map((a) => a.address);
}

const defaultPortAllowed = (p: number) => p === 80 || p === 443;

/** Checks a URL and returns the vetted address to connect to. */
async function vet(url: URL, o: Required<Pick<ImageFetchOptions, 'resolve' | 'addressAllowed' | 'portAllowed'>>): Promise<string> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImageProxyError('BAD_URL');
  if (url.username || url.password) throw new ImageProxyError('BAD_URL');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!o.portAllowed(port)) throw new ImageProxyError('BLOCKED_PORT');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new ImageProxyError('BAD_URL');
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await o.resolve(host);
    } catch {
      throw new ImageProxyError('DNS_FAILED');
    }
  }
  if (addresses.length === 0) throw new ImageProxyError('DNS_FAILED');
  // One bad address is enough to refuse: a host that also points inside is not trusted.
  if (!addresses.every((a) => o.addressAllowed(a))) throw new ImageProxyError('BLOCKED_ADDRESS');
  return addresses[0]!;
}

function sniffProxyImage(b: Buffer): string | undefined {
  const common = sniffImage(b);
  if (common) return common;
  if (b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(b.subarray(8, 12).toString('latin1'))) {
    return 'image/avif';
  }
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d && b.readUInt32LE(14) >= 12 && b.readUInt32LE(14) <= 256) return 'image/bmp';
  if (b.length > 22 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b.readUInt16LE(4) > 0) return 'image/x-icon';
  return undefined;
}

interface Hop {
  status: number;
  location?: string;
  body?: Buffer;
}

function requestOnce(url: URL, ip: string, deadline: number, maxBytes: number): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new ImageProxyError('TIMEOUT'));
    const secure = url.protocol === 'https:';
    const lib = secure ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const req = lib.request(
      {
        host: ip, // the vetted address: no further DNS lookup happens
        port: Number(url.port || (secure ? 443 : 80)),
        path: url.pathname + url.search,
        method: 'GET',
        agent: false,
        ...(secure && !net.isIP(host) ? { servername: host } : {}),
        headers: {
          Host: url.host,
          'User-Agent': 'Mozilla/5.0 (compatible; ImageFetcher/1.0)',
          Accept: 'image/*',
          'Accept-Encoding': 'identity'
        }
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return finish(() => resolve({ status, location: String(res.headers.location || '') }));
        }
        if (status !== 200) {
          res.resume();
          return finish(() => reject(new ImageProxyError('UPSTREAM_ERROR')));
        }
        const declared = Number(res.headers['content-length'] || 0);
        if (declared > maxBytes) {
          finish(() => reject(new ImageProxyError('TOO_LARGE')));
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            finish(() => reject(new ImageProxyError('TOO_LARGE')));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => finish(() => resolve({ status, body: Buffer.concat(chunks) })));
        res.on('error', () => finish(() => reject(new ImageProxyError('UPSTREAM_ERROR'))));
        res.on('aborted', () => finish(() => reject(new ImageProxyError('UPSTREAM_ERROR'))));
      }
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new ImageProxyError('TIMEOUT')));
    }, left);
    req.on('error', () => finish(() => reject(new ImageProxyError('UPSTREAM_ERROR'))));
    req.end();
  });
}

/** Fetches a remote image under all of the rules above, or throws ImageProxyError. */
export async function fetchRemoteImage(rawUrl: string, options: ImageFetchOptions = {}): Promise<FetchedImage> {
  const o = {
    resolve: options.resolve ?? systemResolve,
    addressAllowed: options.addressAllowed ?? isPublicAddress,
    portAllowed: options.portAllowed ?? defaultPortAllowed
  };
  const maxBytes = options.maxBytes ?? IMAGE_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? IMAGE_MAX_REDIRECTS;
  const deadline = Date.now() + (options.timeoutMs ?? IMAGE_TIMEOUT_MS);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageProxyError('BAD_URL');
  }
  for (let hop = 0; ; hop++) {
    const ip = await vet(url, o);
    const r = await requestOnce(url, ip, deadline, maxBytes);
    if (r.body) {
      const type = sniffProxyImage(r.body);
      if (!type) throw new ImageProxyError('NOT_AN_IMAGE');
      return { body: r.body, contentType: type };
    }
    if (hop >= maxRedirects) throw new ImageProxyError('TOO_MANY_REDIRECTS');
    if (!r.location) throw new ImageProxyError('UPSTREAM_ERROR');
    try {
      url = new URL(r.location, url);
    } catch {
      throw new ImageProxyError('BAD_URL');
    }
  }
}
