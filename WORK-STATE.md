# Work state

Plan: plan v2, approved by Om on 14 Nov 2026 (copy in the session notes folder, mailloom-plan-v2.md). Work OS project: Mailloom.
Testing only against local GreenMail (greenmail-a: IMAPS 1993 / IMAP 1143 / SMTP 1587; greenmail-b: 2993 / 2143 / 2587;
users tester@ and colleague@delpat.test). Never the live mail server.

## Now
- Day 1: an honest, safe mailbox. Builder A (Opus, worktree mailloom-A): security hotfix and server-side sessions.
  Builder B (Sonnet, worktree mailloom-B): GreenMail test harness, then writing and sending fixes.

## Next
1. Day 1 rest: phone and keyboard basics; browser check of organising, reading, drafts and live list (done in code and
   GreenMail tests by builder B, not yet seen in a browser).
2. Day 2: per-person keys and agent API in Mailloom; mail tools in Work OS; 2-3 design directions for Om.
3. Day 3: chosen design, signature logo inline, push notifications, full acceptance run, security review.
4. Trial on the real server with a test mailbox (waits on Om's go-ahead).

## Later
- Drafts do not keep attachments; reopened drafts cannot restore them (needs multipart draft save).
- Batch Restore / Not spam, folder create/rename/delete, drag to folder (wait on v1 in daily use).
- Mail 'Message-ID' header search for drafts on servers without UIDPLUS is untested on real Dovecot.
- Production secrets: deploy/.env.example committed real-looking secrets; if production copied them, rotate there (waits on Om).
- Threads view, contacts book, out-of-office via ManageSieve, offline reading, undo send, search all folders (wait on v1 in daily use).
- Forwarding rules and change password need iRedAdmin access (waits on Om).
