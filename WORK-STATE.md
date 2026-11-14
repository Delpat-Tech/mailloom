# Work state

Plan: plan v2, approved by Om on 14 Nov 2026 (copy in the session notes folder, mailloom-plan-v2.md). Work OS project: Mailloom.
Testing only against local GreenMail (greenmail-a: IMAPS 1993 / IMAP 1143 / SMTP 1587; greenmail-b: 2993 / 2143 / 2587;
users tester@ and colleague@delpat.test). Never the live mail server.

## Now
- Merged and reviewed on main: sign-in and sessions, sending, organising, reading, drafts, live list, phone and
  keyboard basics, per-person agent keys and agent API (docs/agent-api.md). Browser check 1 done (notes folder,
  mailloom-browser-check-1.md).

## Next
1. Builder B: fix browser check 1 bugs (inline logos sent as attachment+Content-ID, desktop toolbar overlap at 1024 px,
   unnamed buttons, state-dependent organise test).
2. Design round 2 (round 1 rejected by Om: too dark, colours all look the same); Om picks; apply it across the app.
3. Work OS mail tools (separate worktree of the Work OS repo, branch mail-tools), calling docs/agent-api.md.
4. Signature logo inline, push notifications, full acceptance run, final security review.
5. Trial on the real server with a test mailbox (waits on Om's go-ahead).

## Later
- Drafts do not keep attachments; reopened drafts cannot restore them (needs multipart draft save).
- Folder create/rename/delete, drag to folder (wait on v1 in daily use).
- Mail 'Message-ID' header search for drafts on servers without UIDPLUS is untested on real Dovecot.
- Production secrets: deploy/.env.example committed real-looking secrets; if production copied them, rotate there (waits on Om).
- deploy/server.mjs and mailloom-standalone.tar.gz are stale (old insecure code); rebuild from source before any deploy (waits on deploy).
- Threads view, contacts book, out-of-office via ManageSieve, offline reading, undo send, search all folders (wait on v1 in daily use).
- Forwarding rules and change password need iRedAdmin access (waits on Om).
- Per-email sign-in throttle (10/15 min) lets anyone lock a known mailbox out of sign-in; consider CAPTCHA-free alternatives (waits on real use).
- Agent API: outgoing sends limited only by the 12 MB body limit; MAILBOX_NOT_ALLOWED not audited; safeHtmlFragment keeps
  the reader's link warnings in sent HTML and drops <style>; routes/agent.ts has raw control bytes in regexes (git sees it
  as binary) — use \u escapes (none blocking; next agent-API touch).
- Push: no cap on watcher IMAP connections (one per mailbox with notifications on; fine for staff numbers, revisit at scale).
- Push: browser-rotated subscriptions (pushsubscriptionchange) are not re-registered; the old one 410s and is deleted,
  the person turns notifications on again (waits on real-phone use).
- Push: 60 s poll path (servers without IDLE) not covered by a test; GreenMail has IDLE (waits on real Dovecot check).
