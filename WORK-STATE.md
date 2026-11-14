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
- Rich composer built on builder-b (TipTap): needs a browser check (typing, paste from Word/Gmail, picture paste/drop, signature logo, phone width).
- Signatures (and the logo) are still stored per browser in localStorage; move to server account settings (waits on a settings store).
- Pictures in a message are sent as data: in the request JSON and turned into cid parts on the server; large messages could use multipart upload instead.
- Drafts do not keep attachments; reopened drafts cannot restore them (needs multipart draft save).
- Folder create/rename/delete, drag to folder (wait on v1 in daily use).
- Mail 'Message-ID' header search for drafts on servers without UIDPLUS is untested on real Dovecot.
- Production secrets: the old committed secrets are leaked; if production ever used them, rotate there (docs/deploy.md section 10; waits on Om).
- Release: `pnpm release` builds and packs from source (build output no longer in git). Runbook docs/deploy.md is untested on the real server (waits on trial go-ahead).
- Deep links `#/m/<Message-ID>` open the active account only; a link for another signed-in account shows "moved or deleted" (revisit if staff use several accounts).
- Server HOST defaults to 0.0.0.0 when unset; the runbook sets 127.0.0.1 (consider defaulting to 127.0.0.1).
- Threads view, contacts book, out-of-office via ManageSieve, offline reading, undo send, search all folders (wait on v1 in daily use).
- Forwarding rules and change password need iRedAdmin access (waits on Om).
- Per-email sign-in throttle (10/15 min) lets anyone lock a known mailbox out of sign-in; consider CAPTCHA-free alternatives (waits on real use).
- Agent API: outgoing sends limited only by the 12 MB body limit; MAILBOX_NOT_ALLOWED not audited; safeHtmlFragment keeps
  the reader's link warnings in sent HTML and drops <style>; routes/agent.ts has raw control bytes in regexes (git sees it
  as binary) — use \u escapes (none blocking; next agent-API touch).
- No sign-out-everywhere route; DELETE /api/push/devices only turns notifications off for all devices (waits on settings page).
- Push: no cap on watcher IMAP connections (one per mailbox with notifications on; fine for staff numbers, revisit at scale).
- Push: browser-rotated subscriptions (pushsubscriptionchange) are not re-registered; the old one 410s and is deleted,
  the person turns notifications on again (waits on real-phone use).
- Push: 60 s poll path (servers without IDLE) not covered by a test; GreenMail has IDLE (waits on real Dovecot check).
- No sign-out-everywhere; a password change is the only way to end stolen sessions (waits on settings page).
- Sign-in lockout by email (10/15 min) can be triggered by anyone; Dovecot sees all Mailloom logins from 127.0.0.1 — consider passing client IP via IMAP ID and login_trusted_networks (waits on real use).
- nodemailer 7.0.13 still has audit advisories whose fixes are only in 8.x to 10.x (breaking major); revisit the upgrade (waits on a compatibility check). Draft-save recipients are not yet strictly parsed like send.
- Inter font loads from Google Fonts (allowed in CSP); self-hosting would let the CSP drop the two Google hosts (waits on a decision).
