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
 *
 * The caller's address is req.ip, so behind a proxy TRUST_PROXY must name that proxy.
 */
export interface AgentConfig {
  /** null = agent API off. */
  allowList: net.BlockList | null;
  allowedIps: string[];
  sendsPerHour: number;
  maxRecipients: number;
  maxTextChars: number;
  maxAttachmentBytes: number;
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
    maxAttachmentBytes: int(env, 'AGENT_MAX_ATTACHMENT_BYTES', 10 * 1024 * 1024)
  };
}

export function ipAllowed(config: AgentConfig, ip: string): boolean {
  if (!config.allowList || !ip) return false;
  const addr = normaliseIp(ip);
  const family = net.isIP(addr);
  if (!family) return false;
  return config.allowList.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}
