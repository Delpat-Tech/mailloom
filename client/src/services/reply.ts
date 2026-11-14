// Pure reply/forward logic (no imports, so the server tests can run it too).

export interface Addr {
  name?: string;
  address: string;
}

export interface ReplySource {
  from: Addr;
  to: Addr[];
  cc?: Addr[];
  replyTo?: Addr[];
  subject: string;
  messageId?: string;
  references?: string[];
}

export interface ReplyPlan {
  to: string[];
  cc: string[];
  subject: string;
  inReplyTo?: string;
  references: string[];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function uniq(list: string[], exclude: string[] = []): string[] {
  const out: string[] = [];
  for (const a of list) {
    if (!a) continue;
    if (exclude.some((e) => same(e, a))) continue;
    if (out.some((o) => same(o, a))) continue;
    out.push(a);
  }
  return out;
}

export function planReply(msg: ReplySource, ownAddress: string, replyAll: boolean): ReplyPlan {
  const fromIsMe = same(msg.from.address, ownAddress);
  const replyTo = (msg.replyTo || []).map((a) => a.address).filter(Boolean);

  // Answering something I sent: write to its original recipients, not to myself.
  let primary: string[];
  if (fromIsMe) primary = msg.to.map((a) => a.address);
  else if (replyTo.length > 0) primary = replyTo;
  else primary = [msg.from.address];

  let to = uniq(primary, [ownAddress]);
  let cc: string[] = [];
  if (replyAll) {
    const others = [...msg.to, ...(msg.cc || [])].map((a) => a.address);
    if (fromIsMe) {
      cc = uniq((msg.cc || []).map((a) => a.address), [ownAddress, ...to]);
    } else {
      cc = uniq(others, [ownAddress, ...to]);
    }
  }
  if (to.length === 0 && !replyAll) to = uniq(primary);

  const subject = /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`;
  return {
    to,
    cc,
    subject,
    inReplyTo: msg.messageId,
    references: msg.messageId ? [...(msg.references || []), msg.messageId] : msg.references || []
  };
}
