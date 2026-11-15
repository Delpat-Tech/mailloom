# Work state

Plan: plan v2, approved by Om on 14 Nov 2026 (copy in the session notes folder, mailloom-plan-v2.md). Work OS project: Mailloom.
Testing only against local GreenMail (greenmail-a: IMAPS 1993 / IMAP 1143 / SMTP 1587; greenmail-b: 2993 / 2143 / 2587;
users tester@ and colleague@delpat.test). Never the live mail server.

## Now
- On main and pushed to GitHub on 15 Nov, reviewed and tested (server 203, client 121): sign-in and sessions, sending, organising, reading, drafts,
  live list, phone and keyboard, agent keys and API, push notifications, rich-text composer with inline images and
  signature logo, release build, deploy runbook, deep links, whole-app security fixes, and the Sky rail design in
  Delpat colours with filters, starred and snoozed views, labels, snooze, conversations, bounce rows, shortcuts,
  optimistic actions with undo, and motion. Acceptance run in the browser on 15 Nov (desktop and phone, light and dark): send, forward
  with attachments (byte-identical), drafts, labels, star, snooze, archive and undo, filters, search, phone reader and reply.
- Work OS mail tools: branch mail-tools in Om/wos-mail, reviewed, 64 e2e checks + 36 live checks against real Mailloom;
  not merged into Work OS master (waits on Om).

## Next
0. Live at https://mail.delpat.in/mail/ (v2026.11.16, installed by Om 16 Nov with `sudo mailloom-update`; rollback
   `sudo mailloom-update --rollback`, the intern's build in /opt/www/mailloom.intern, Nginx backup /root/roundcube.tmpl.bak).
   systemd mailloom.service (www-data, /opt/www/mailloom with its .env); Nginx /etc/nginx/templates/roundcube.tmpl.
1. Settings live 16 Nov (v2026.11.16b): avatar menu (accounts, Settings, Sign out); sections General, Writing, Notifications,
   Labels, Accounts, Connections, App; settings stored per mailbox on the server; sidebar back to mail only. Full tests, built-app
   check, then release for Om.
2. New icon and motion (Aurora app icon, Dusk in-app mark, intro, step loader, run-off outro) released as v2026.11.16c; pull-to-refresh fix and versioned icon URLs in v2026.11.16d (3ff0c2d)
   (8c08763) on 16 Nov; waits on Om running `sudo mailloom-update`. All explorations kept in design/brand/.
3. Real phone checks (back gesture, keyboard in composer, PDF on iPhone, Write shortcut, mailto) wait on Om using the phone.
4. Server: "System restart required", 96 package updates (1 security) (waits on Om; not Mailloom).

## Later
- Brand: MarkLoader (inline loader) exists but is unused; button spinners unchanged. index.html theme-color is #2F6CB5 while the launch screen is navy; first paint is white before JS (needs index.html/CSP touch) (waits on Om's view after phone use).
- Spam learning (Dovecot imapsieve + sa-learn): reporting only moves mail today. Om said not for now (16 Nov).
- Deploy notes: docs/deploy.md describes pm2 at its own host name; the live setup is systemd under /mail/ (update the runbook to match). Nginx also sends iRedMail's loose CSP next to ours (browsers apply both; harmless).
- Earlier note: Om first said local only; Mail server is 43.205.158.10; its Dovecot/Postfix use iRedMail's self-signed certificate (MAIL_TLS_CA_FILE, merged, covers it) (waits on Om deciding to deploy).
- ydco.in mail is on Google (MX), so it cannot sign in to Mailloom; dropped from MAIL_DOMAINS examples (builder-a).
- Snooze wake-up without notifications on waits for the next sign-in or request for that mailbox; on time only with a stored push login (docs/organise.md; waits on real use, or on a decision to keep a separate wake-up login).
- Labels server side (builder-a): 501 path for servers without custom keywords is untested (GreenMail and Dovecot allow them); conversation index rows are never pruned for folders renamed away or for mailboxes no longer used (waits on real use).
- Conversation index on a big mailbox: until the first background run ends, older threads count 1 and the thread view may miss older messages (docs/organise.md; waits on real-mailbox timing).
- Rich composer built on builder-b (TipTap): needs a browser check (typing, paste from Word/Gmail, picture paste/drop, signature logo, phone width).
- Signatures (and the logo) are still stored per browser in localStorage; move to server account settings (waits on a settings store).
- Pictures in a message are sent as data: in the request JSON and turned into cid parts on the server; large messages could use multipart upload instead.
- Drafts do not keep attachments; reopened drafts cannot restore them (needs multipart draft save).
- Folder create/rename/delete, drag to folder (wait on v1 in daily use).
- Mail 'Message-ID' header search for drafts on servers without UIDPLUS is untested on real Dovecot.
- Production secrets: the old committed secrets are leaked; if production ever used them, rotate there (docs/deploy.md section 10; waits on Om).
- Release: `pnpm release` builds and packs from source (build output no longer in git). Runbook docs/deploy.md is untested on the real server (waits on trial go-ahead).
- Deep links `#/m/<Message-ID>` open the active account only; a link for another signed-in account shows "moved or deleted" (revisit if staff use several accounts).
- Threads view, contacts book, out-of-office via ManageSieve, offline reading, undo send, search all folders (wait on v1 in daily use).
- Forwarding rules and change password need iRedAdmin access (waits on Om).
- Agent API: outgoing sends limited only by the 12 MB body limit; MAILBOX_NOT_ALLOWED not audited; safeHtmlFragment keeps
  the reader's link warnings in sent HTML and drops <style>; routes/agent.ts has raw control bytes in regexes (git sees it
  as binary) — use \u escapes (none blocking; next agent-API touch).
- Push: no cap on watcher IMAP connections (one per mailbox with notifications on; fine for staff numbers, revisit at scale).
- Push: browser-rotated subscriptions (pushsubscriptionchange) are not re-registered; the old one 410s and is deleted,
  the person turns notifications on again (waits on real-phone use).
- Push: 60 s poll path (servers without IDLE) not covered by a test; GreenMail has IDLE (waits on real Dovecot check).
- Work OS: unattended dispatcher sessions can mail outside Delpat (notice only, no hold); Om said no extra limits (waits on Om if he changes his mind).
- Deep links open only in the active account when several are signed in (waits on real use).
- Agent API and web composer use different outgoing HTML sanitisers; align them (next agent-API touch).
- No sign-out-everywhere; a password change is the only way to end stolen sessions (waits on settings page).
- Sign-in lockout by email (10/15 min) can be triggered by anyone; Dovecot sees all Mailloom logins from 127.0.0.1 — consider passing client IP via IMAP ID and login_trusted_networks (waits on real use).
- Inter font loads from Google Fonts (allowed in CSP); self-hosting would let the CSP drop the two Google hosts (waits on a decision).
- Unicode (IDN) domains are refused in recipients; punycode works (waits on real use).
- @tiptap packages are on 2.x; the last audit finding (@tiptap/core <3.30.4) needs the 3.x major, which changes extensions and the editor API (waits on a compatibility pass of the rich-text composer).

## Settings page (builder-b, 15 Nov, not merged)
- Done on builder-b: avatar menu, Settings (7 sections), clean sidebar, server-backed signature/templates/pictures with importLocal on version 0.
- Later: a disabled old local signature is not imported (empty = off on the server); theme choice stays per device (server theme is only the default).
