# Work state

Plan: plan v2, approved by Om on 14 Nov 2026 (copy in the session notes folder, mailloom-plan-v2.md). Work OS project: Mailloom.
Testing only against local GreenMail (greenmail-a: IMAPS 1993 / IMAP 1143 / SMTP 1587; greenmail-b: 2993 / 2143 / 2587;
users tester@ and colleague@delpat.test). Never the live mail server.

## Now
- Day 1: an honest, safe mailbox. Builder A (Opus, worktree mailloom-A): security hotfix and server-side sessions.
  Builder B (Sonnet, worktree mailloom-B): GreenMail test harness, then writing and sending fixes.

## Next
1. Day 1 rest: organising (delete to Trash, honest results), reading (inline logos, styling, image blocking,
   attachment parts), drafts, live list, phone and keyboard basics.
2. Day 2: per-person keys and agent API in Mailloom; mail tools in Work OS; 2-3 design directions for Om.
3. Day 3: chosen design, signature logo inline, push notifications, full acceptance run, security review.
4. Trial on the real server with a test mailbox (waits on Om's go-ahead).

## Later
- Production secrets: deploy/.env.example committed real-looking secrets; if production copied them, rotate there (waits on Om).
- Threads view, contacts book, out-of-office via ManageSieve, offline reading, undo send, search all folders (wait on v1 in daily use).
- Forwarding rules and change password need iRedAdmin access (waits on Om).
