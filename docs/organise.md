# Labels, snooze and conversations (server notes)

All routes are session-auth (`X-Mailloom-Account`). Server code: `server/src/routes/organise.ts`,
`server/src/services/organise.ts`, `organise-store.ts`, `snoozer.ts`, `threading.ts`, `bounce.ts`.

## Labels
- Stored on the messages as IMAP keywords `$label_<id>` (id: 10 characters a-z0-9), so they live on the
  mailbox and show in other mail programs that display keywords.
- Definitions (name, colour, order) live in the session sqlite database, per mailbox address.
  The five defaults (Client, Finance, Product, People, Ops) are created the first time a mailbox asks.
- The mail server must allow custom keywords (`\*` in PERMANENTFLAGS). If it does not, creating a label
  or labelling mail answers 501 `LABELS_UNSUPPORTED`. Dovecot allows them.
- Deleting a label removes its keyword from every folder (Inbox and Archive must succeed; others best effort).

## Snooze
- Snoozing records the mailbox address, the Message-ID and the wake time in sqlite (pending), moves the
  mail to a `Snoozed` folder (created when missing), then records the UID it got there. Each copy has its
  own record (mailbox + Message-ID + Snoozed UID). Mail without a Message-ID cannot be snoozed (422).
- At the wake time the copy moves back to the Inbox, unread. If it is no longer in `Snoozed` under that
  UID and Message-ID (moved or deleted elsewhere), the record is dropped and only a code is logged
  (`SNOOZE_MESSAGE_GONE`). A pending record left by an interrupted snooze is resolved by Message-ID.
- A mailbox whose wake-up keeps failing backs off: 1, 5, 15, then every 60 minutes.
- Wake-up needs the mailbox password, which Mailloom keeps only in two places:
  1. **Notifications on:** the push feature stores an encrypted login per device. A server timer
     (every minute) uses it, so mail returns on time even when nobody is signed in.
  2. **Otherwise:** the mail returns at the next sign-in or the next signed-in request for that mailbox.

  **Limit:** without notifications turned on for the mailbox, snoozed mail does not come back while
  nobody uses Mailloom; it appears in the Inbox (unread) as soon as the person next opens Mailloom.
  Mail is never lost: it waits in the `Snoozed` folder, which other mail programs also show.

## Conversations
- `threadId` is a short hash of the root Message-ID (first References entry, otherwise In-Reply-To,
  otherwise the message's own Message-ID).
- `threadCount` counts messages with that id in Inbox, Sent and Archive. GreenMail has no IMAP THREAD,
  so the server keeps a sqlite index (folder, UID, thread id, Message-ID, has-attachments) per mailbox.
  The list never waits for it: threadCount comes from what is indexed (at least 1). A list call runs three
  STATUS commands; up to 200 new UIDs above the stored high-water mark are indexed inline. Anything more
  (first run, UIDVALIDITY change, pruning moved mail) runs in the background on a separate short-lived IMAP
  connection, newest first, saving after each batch of 1,000 UIDs so a broken run resumes where it stopped.
  Until the first background run of a big mailbox finishes, older conversations show a count of 1 and the
  thread view (which waits up to 3 s for a running index) may be missing older messages.
- The index also caches has-attachments, so `filter=attachments` only reads BODYSTRUCTURE for new mail.
- A reply whose References header was trimmed by another mail program may start a conversation of its own.

## Bounces
- Detected from BODYSTRUCTURE (multipart/report; report-type=delivery-status) or a MAILER-DAEMON /
  postmaster sender. Only the report parts are read (16 KB each) for the list summary:
  `bounce: {originalSubject, recipient, reason}` with reason one of "mailbox full",
  "address does not exist", "rejected as spam", "server could not be reached", "could not be delivered".
  originalSubject is capped at 300 characters and recipient at 320.
- `retryable` is true only when the original's Message-ID is found in Sent; `original: {mailbox, uid}`
  then points at that copy, so the client reopens the real message rather than the bounce text.
