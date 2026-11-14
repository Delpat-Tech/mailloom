import React, { useRef, useState } from 'react';
import { fullDate } from '../services/time.js';
import { api } from '../services/api.js';
import { avatarClass, initialsOf } from '../services/avatar.js';
import { threadSummary, type ThreadInfo, type ThreadMessage } from '../services/threads.js';
import type { ParsedEmailMessage } from '../types.js';

function when(d: string): string {
  return fullDate(d) || d;
}

const Collapsed: React.FC<{ m: ThreadMessage }> = ({ m }) => {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ParsedEmailMessage | null>(null);
  const [error, setError] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const who = m.isOwn ? 'You' : m.from.name || m.from.address;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      setError(false);
      try {
        // peek: reading an earlier message here does not change its read state.
        setDetail(await api.getMessageDetail(m.mailbox, m.uid, { peek: true }));
      } catch {
        setError(true);
      }
    }
  };

  return (
    <div className="bg-surface border border-line -mt-px first:mt-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="t-fast w-full min-h-[48px] px-3 sm:px-4 grid grid-cols-[28px_auto_minmax(0,1fr)] sm:grid-cols-[28px_auto_minmax(0,1fr)_auto] gap-3 items-center text-left text-[13.5px] hover:bg-hover"
      >
        <span
          aria-hidden="true"
          className={`cut-av w-7 h-7 grid place-items-center text-[10.5px] font-extrabold text-white ${avatarClass(m.from.address || who)}`}
        >
          {initialsOf(who)}
        </span>
        <b className="font-bold text-ink">{who}</b>
        <span className="truncate text-[13px] text-ink-3">{m.snippet}</span>
        <time className="hidden sm:block text-xs font-semibold text-ink-3">{when(m.date)}</time>
      </button>
      {open && (
        <div className="anim-rise px-4 pb-4 border-t border-line">
          {error ? (
            <p className="pt-3 text-[13px] text-warn-ink">This message could not be loaded.</p>
          ) : !detail ? (
            <div className="skel h-4 w-1/2 mt-4" aria-label="Loading message" role="status" />
          ) : detail.html ? (
            <div className="bg-white rounded border border-line overflow-hidden mt-3">
              <iframe
                ref={frame}
                title={`Message from ${who}`}
                srcDoc={detail.html}
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                scrolling="no"
                className="w-full border-0 block"
                style={{ height: '160px' }}
                onLoad={() => {
                  const f = frame.current;
                  const h = f?.contentDocument?.documentElement?.scrollHeight;
                  if (f && h) f.style.height = `${Math.max(60, h)}px`;
                }}
              />
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words text-[15px] text-ink leading-relaxed pt-3">{detail.text}</div>
          )}
        </div>
      )}
    </div>
  );
};

interface Props {
  info: ThreadInfo;
  current: { mailbox: string; uid: number };
  myAddress?: string;
  /** "before": the summary and earlier messages (above the open one); "after": later messages. */
  part: 'before' | 'after';
}

/** "N messages with X and Y", and the other messages of the conversation as one-line rows. */
export const ThreadView: React.FC<Props> = ({ info, current, myAddress, part }) => {
  if (info.messages.length < 2) return null;
  const idx = info.messages.findIndex((m) => m.uid === current.uid && m.mailbox === current.mailbox);
  const before = idx < 0 ? info.messages.slice(0, -1) : info.messages.slice(0, idx);
  const after = idx < 0 ? [] : info.messages.slice(idx + 1);
  if (part === 'after') {
    return after.length === 0 ? null : (
      <section aria-label="Later messages in this conversation" className="mt-2">
        {after.map((m) => (
          <Collapsed key={`${m.mailbox}:${m.uid}`} m={m} />
        ))}
      </section>
    );
  }
  return (
    <section aria-label="Conversation" className="mb-2">
      <p className="text-[13px] font-semibold text-ink-3 mb-2">{threadSummary(info, myAddress)}</p>
      {before.map((m) => (
        <Collapsed key={`${m.mailbox}:${m.uid}`} m={m} />
      ))}
    </section>
  );
};
