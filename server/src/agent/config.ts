import net from 'node:net';
import { ConfigError } from '../config.js';

/**
 * Agent API settings (Work OS reaching mail on a person's behalf).
 *
 *   AGENT_ALLOWED_IPS           comma list of IPs or CIDR ranges allowed to call /api/agent/v1/*.
 *                               Empty or unset: the agent API is off (every call answers 404).
 *   AGENT_SENDS_PER_HOUR        mails one key may send per rolling hour (default 200).
 *   AGENT_MAX_RECIPIENTS        to+cc+bcc per mail (default 100).
 *   AGENT_MAX_TEXT_CHARS        message text returned by get-message (default 100000 characters).
 *   AGENT_MAX_ATTACHMENT_BYTES  largest attachment returned as base64 (default 10 MB).
 *   MAILLOOM_PUBLIC_URL         optional public address of Mailloom (https://mail.example.com, a path like /mail is
 *                               allowed). When set, every message in agent responses carries a web_url that opens it.
 *   AGENT_CLIENT_ID,            "Connect Mailloom" (OAuth authorization code + PKCE for Work OS). All three must be set
 *   AGENT_CLIENT_SECRET,        or Connect is off. The secret needs 32+ characters (a shorter one stops start-up);
 *   AGENT_CLIENT_REDIRECT_URIS  redirect URIs are a comma list matched exactly, https only (http for localhost).
 *                               MAILLOOM_PUBLIC_URL is then required too (issuer and consent address); localhost
 *                               redirect URIs are refused when NODE_ENV=production.
 *   AGENT_CLIENT_NAME           optional name shown to people and kept with the key (default "Work OS").
 *
 * The caller's address is req.ip, so behind a proxy TRUST_PROXY must name that proxy.
 */
export interface ConnectClient {
  id: string;
  secret: string;
  name: string;
  redirectUris: string[];
}

export interface AgentConfig {
  /** null = agent API off. */
  allowList: net.BlockList | null;
  allowedIps: string[];
  sendsPerHour: number;
  maxRecipients: number;
  maxTextChars: number;
  maxAttachmentBytes: number;
  /** MAILLOOM_PUBLIC_URL without a trailing slash, or null. */
  publicUrl: string | null;
  /** The one registered Connect client, or null when Connect is off. */
  connect: ConnectClient | null;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, def: number): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`${name} must be a whole number of at least 1 (got "${raw}").`);
  return n;
}

/** Strips the IPv4-mapped IPv6 prefix so ::ffff:10.0.0.5 matches 10.0.0.5. */
export function normaliseIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

function parsePublicUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`MAILLOOM_PUBLIC_URL "${v}" is not a web address like https://mail.example.com.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new ConfigError('MAILLOOM_PUBLIC_URL must start with https:// (http:// only for localhost).');
  }
  if (u.search || u.hash || u.username || u.password) {
    throw new ConfigError('MAILLOOM_PUBLIC_URL must be only the address, without query, # part or login.');
  }
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** Link that opens one message in the web app: <public url>/#/m/<url-encoded Message-ID>. Null when no public URL is set or the message has no id. */
export function messageWebUrl(config: { publicUrl: string | null }, messageId: string | null | undefined): string | null {
  if (!config.publicUrl || !messageId) return null;
  const id = messageId.trim().replace(/^<|>$/g, '');
  return `${config.publicUrl}/#/m/${encodeURIComponent(`<${id}>`)}`;
}

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isLocalHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

function parseConnect(env: Env): ConnectClient | null {
  const id = env.AGENT_CLIENT_ID?.trim() || '';
  const secret = env.AGENT_CLIENT_SECRET?.trim() || '';
  const uriList = (env.AGENT_CLIENT_REDIRECT_URIS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (!id || !secret || uriList.length === 0) return null;
  if (!CLIENT_ID_RE.test(id)) throw new ConfigError('AGENT_CLIENT_ID may only use letters, digits, ".", "_" and "-" (1 to 64 characters).');
  if (secret.length < 32) throw new ConfigError('AGENT_CLIENT_SECRET must be at least 32 characters; the server will not start with a shorter one.');
  const redirectUris = uriList.map((raw) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new ConfigError(`AGENT_CLIENT_REDIRECT_URIS entry "${raw}" is not a web address.`);
    }
    if (isLocalHost(u.hostname) && env.NODE_ENV === 'production') {
      throw new ConfigError('AGENT_CLIENT_REDIRECT_URIS must not point at localhost when NODE_ENV=production.');
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname))) {
      throw new ConfigError('AGENT_CLIENT_REDIRECT_URIS entries must start with https:// (http:// only for localhost or 127.0.0.1).');
    }
    if (u.hash || u.username || u.password) {
      throw new ConfigError(`AGENT_CLIENT_REDIRECT_URIS entry "${raw}" must not have a # part or a login.`);
    }
    if (raw.length > 500) throw new ConfigError('AGENT_CLIENT_REDIRECT_URIS entries may be at most 500 characters.');
    return raw;
  });
  const name = (env.AGENT_CLIENT_NAME || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'Work OS';
  if (!parsePublicUrl(env.MAILLOOM_PUBLIC_URL)) {
    throw new ConfigError('Connect needs MAILLOOM_PUBLIC_URL (the address people use to open Mailloom, e.g. https://mail.delpat.in/mail); the server will not start without it.');
  }
  return { id, secret, name, redirectUris };
}

export function loadAgentConfig(env: Env): AgentConfig {
  const entries = (env.AGENT_ALLOWED_IPS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  let allowList: net.BlockList | null = null;
  if (entries.length > 0) {
    allowList = new net.BlockList();
    for (const entry of entries) {
      const [addr, bitsRaw] = entry.split('/');
      const family = net.isIP(addr || '');
      if (!family) throw new ConfigError(`AGENT_ALLOWED_IPS entry "${entry}" is not an IP address or CIDR range.`);
      const type = family === 4 ? 'ipv4' : 'ipv6';
      if (bitsRaw === undefined) {
        allowList.addAddress(addr!, type);
        continue;
      }
      const bits = Number(bitsRaw);
      const max = family === 4 ? 32 : 128;
      if (!/^\d+$/.test(bitsRaw) || bits > max) throw new ConfigError(`AGENT_ALLOWED_IPS entry "${entry}" has a bad prefix length.`);
      if (bits < 8) throw new ConfigError(`AGENT_ALLOWED_IPS entry "${entry}" is far too wide; list the Work OS server address.`);
      allowList.addSubnet(addr!, bits, type);
    }
  }
  return {
    allowList,
    allowedIps: entries,
    sendsPerHour: int(env, 'AGENT_SENDS_PER_HOUR', 200),
    maxRecipients: int(env, 'AGENT_MAX_RECIPIENTS', 100),
    maxTextChars: int(env, 'AGENT_MAX_TEXT_CHARS', 100_000),
    maxAttachmentBytes: int(env, 'AGENT_MAX_ATTACHMENT_BYTES', 10 * 1024 * 1024),
    publicUrl: parsePublicUrl(env.MAILLOOM_PUBLIC_URL),
    connect: parseConnect(env)
  };
}

export function ipAllowed(config: AgentConfig, ip: string): boolean {
  if (!config.allowList || !ip) return false;
  const addr = normaliseIp(ip);
  const family = net.isIP(addr);
  if (!family) return false;
  return config.allowList.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}
