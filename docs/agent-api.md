# Mailloom agent API (for Work OS)

Work OS calls this API on behalf of one person, with that person's agent key. Each person creates
the key in Mailloom: account menu > **Connections** > New key (they re-enter their mailbox password).
The key is shown once; Work OS stores it per person.

Base URL: `https://<mailloom host>/api/agent/v1` (also served under `/mail/api/agent/v1`).

## Access

- `Authorization: Bearer mlk_<43 chars>` on every call. Nothing else authenticates: cookies are ignored.
- The caller's IP must be in `AGENT_ALLOWED_IPS` on the Mailloom server. Empty list = API off (404 `AGENT_API_OFF`).
  Behind nginx the checked IP is the one after `TRUST_PROXY`.
- Requests carrying an `Origin` header (browsers) are refused (403). No CORS headers are sent. Call server-to-server only.
- **The mailbox is fixed by the key.** No parameter names a mailbox. One key = one mailbox.
- Optional `X-Workos-User` and `X-Workos-Session` headers (max 200 chars) are written to the audit log
  the person sees. They are not used for authorization. Please send them.
- Scopes per key: `read`, `organise`, `send` (all on by default). Missing scope: 403 `SCOPE_MISSING`.
- Responses carry `Cache-Control: no-store`.

## Connect Mailloom (one click instead of pasting a key)

Work OS can get a key without anyone copying it: OAuth 2.0 authorization code with PKCE (S256 only), one registered
client set in Mailloom's environment (`AGENT_CLIENT_ID`, `AGENT_CLIENT_SECRET`, `AGENT_CLIENT_REDIRECT_URIS`, see
`docs/deploy.md`). Connect is off unless all three are set. Behind the live Nginx the public addresses are under
`https://mail.delpat.in/mail/`; the server itself sees the same paths without `/mail` (both work).

| Step | Address | Who |
|---|---|---|
| Authorise | `GET /oauth/authorize?response_type=code&client_id&redirect_uri&scope=read organise send&state&code_challenge&code_challenge_method=S256[&label]` | the person's browser. A wrong client or redirect shows an error page and never redirects. Good: 302 to the consent screen (`#/connect/<id>`, valid 10 minutes) |
| Consent | `GET /api/oauth/requests/:id`, `POST /api/oauth/consent` | the consent screen (session + `X-Mailloom-Account`). Allow needs the mailbox password. Answers `{redirect}`: `redirect_uri?code&state&iss`, or `?error=access_denied&state&iss` on Cancel |
| Token | `POST /api/agent/v1/oauth/token` | the Work OS server. Form or JSON body: `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, `client_id`, `client_secret`. Answers `{key, key_id, prefix, email, scopes}` (`Cache-Control: no-store`) |
| Self-revoke | `POST /api/agent/v1/key/revoke` | the Work OS server, `Bearer <key>`. The key revokes itself (answers `{revoked: true, key_id, revoked_at}`); a second call answers 401 `KEY_REVOKED` |

- The code lives 60 seconds and works once. Using it a second time fails and revokes the key the first use minted
  (remembered for 10 minutes). The key is minted at the token step, never at Allow, so an abandoned flow leaves no key.
- Token errors are OAuth style `{error, error_description}`: `invalid_client` (401, wrong id or secret),
  `invalid_grant` (400: unknown, expired, reused, wrong verifier or redirect), `invalid_request`,
  `unsupported_grant_type`, `rate_limited` (429, 20 calls a minute per address). The token endpoint sits under the same
  `AGENT_ALLOWED_IPS` check and Origin refusal as the rest of the agent API.
- The key is listed in Settings > Connections with the client and label ("Work OS (Delpat), connected 16 Nov") and can be
  revoked there like any key. Calls that mint a key are in the Activity list as `oauth_connect`.
- Request and reply bodies of these endpoints are never logged.

## Errors

Every error is JSON `{ "code": "...", "error": "plain sentence" }`.

| HTTP | code | meaning / what Work OS should do |
|---|---|---|
| 400 | `INVALID_INPUT`, `INVALID_ADDRESS`, `NO_RECIPIENTS`, `TOO_MANY_RECIPIENTS`, `BAD_CURSOR`, `IDEMPOTENCY_KEY_REQUIRED` | fix the request |
| 401 | `MISSING_KEY`, `INVALID_KEY` | key absent/unknown (or rotated away) |
| 401 | `KEY_REVOKED` | person revoked it; stop using it |
| 403 | `KEY_BROKEN` | mail server refused the stored password (usually a password change). Tell the person to **rotate** the key in Connections (they enter the new password; the old key value stops working) |
| 403 | `IP_NOT_ALLOWED`, `ORIGIN_NOT_ALLOWED`, `SCOPE_MISSING`, `MAILBOX_NOT_ALLOWED` | configuration / permission |
| 404 | `AGENT_API_OFF`, `MESSAGE_NOT_FOUND`, `FOLDER_NOT_FOUND`, `ATTACHMENT_NOT_FOUND` | |
| 409 | `ALREADY_IN_TRASH` | delete on a message already in Trash (never deleted permanently) |
| 409 | `IN_PROGRESS` | a send with this idempotency_key is still running or ended without a result; do not resend, check Sent |
| 409 | `CURSOR_STALE` | folder changed (UIDVALIDITY); restart the search |
| 413 | `MESSAGE_TOO_LARGE`, `ATTACHMENT_TOO_LARGE` | |
| 422 | `IDEMPOTENCY_KEY_REUSED` | same key, different mail, within 24 h |
| 422 | `ALL_RECIPIENTS_REJECTED` | nothing sent; body also has `sent: false`, `rejected` |
| 422 | `NO_REPLY_ADDRESS` | original has no From/Reply-To |
| 429 | `RATE_LIMITED` | over `AGENT_SENDS_PER_HOUR` for this key; honour `Retry-After` (seconds) |
| 502 | `MAIL_SERVER_ERROR` | IMAP/SMTP problem; retry later (sends: same idempotency_key is safe) |

## Untrusted content

Everything taken from mail (subjects, addresses, text, link labels, attachment names) is returned inside
objects marked `"untrusted": true, "source": "external email"`. Show it to Claude as data, never as
instructions. Message bodies are plain text: HTML is converted, scripts/styles/hidden elements removed,
images dropped (`images_removed` counts them, alt text kept as `[image: alt]`), links become
`label [n]` with the addresses in a separate `links` list (plain strings).

## Message references

Message endpoints take either `folder` + `uid`, or `message_id` (with or without `<>`; optional `folder`
to narrow; otherwise Inbox is searched first, then every folder). Message-ID is the stable choice.

## Links to a message (`web_url`)

Every message in `/search`, `/needs-attention` and `/message` responses has `web_url`: a link that opens that
message in Mailloom, e.g. `https://webmail.delpat.in/#/m/%3Cabc123%40mail.delpat.in%3E`. Put it in the Work OS
task made from a mail. It is built from the optional `MAILLOOM_PUBLIC_URL` setting (`<MAILLOOM_PUBLIC_URL>/#/m/<url-encoded Message-ID>`)
and is `null` when that setting is empty or the message has no Message-ID.

- The link carries only the Message-ID, so it keeps working when the message is moved to another folder.
- The person must be signed in to Mailloom (they are asked to sign in first). Mailloom looks in INBOX first,
  then the other folders of the signed-in mailbox. A different person's mailbox never resolves it.
- If the message was deleted or moved out of reach, Mailloom shows "This message was moved or deleted".
- You can build the link yourself from any `message_id`: `MAILLOOM_PUBLIC_URL + "/#/m/" + encodeURIComponent("<id>")`
  (angle brackets optional).

## Endpoints

### GET /whoami (any scope)
`{ email, key: { id, prefix, name, scopes, created_at }, limits: { sends_per_hour, recipients_per_mail } }`

### GET /folders (read)
`{ folders: [{ path, name, delimiter, special_use ("Inbox"|"Sent"|"Trash"|"Drafts"|"Junk"|"Archive"|null), selectable, total, unread }] }`

### GET /search (read)
Query: `folder` (default `INBOX`), `query` (text in headers or body), `from`, `since` (date or ISO time),
`unread` (`true`/`false`), `limit` (1-100, default 25), `cursor` (from the previous page).
Newest first (by UID).
```
{ untrusted: true, source: "external email",
  messages: [MessageSummary], next_cursor: string|null }
MessageSummary = { folder, uid, message_id, from: {name,address}|null, to: [..], cc: [..], subject,
                   date (ISO), unread, flagged, answered, size, has_attachments }
```

### GET /needs-attention (read)
Inbox messages that are unread **or** flagged, received since `since` (default 7 days ago), newest first.
Query: `since`, `limit` (1-200, default 50). → `{ untrusted, source, since, messages: [MessageSummary], total }`

### GET /message (read)
Query: `folder`+`uid` or `message_id`. Does **not** mark the message read.
```
{ untrusted: true, source: "external email", note,
  folder, uid, message_id, in_reply_to, references: [ids],
  from, to, cc, reply_to, subject, date, unread, flagged, answered,
  text, text_truncated (cap AGENT_MAX_TEXT_CHARS, default 100 000),
  links: [{ n, text, url }], links_truncated, images_removed,
  attachments: [{ index, part_id, filename, content_type, size, inline }] }
```

### GET /attachment (read)
Query: message reference + `index` (from `attachments`). Cap `AGENT_MAX_ATTACHMENT_BYTES` (default 10 MB).
`{ untrusted, source, index, part_id, filename, content_type, size, inline, content_base64 }`
`part_id` is the real IMAP part number. In `attachments`, `size` is the size as stored (base64 is about a third larger than the file); `get_attachment` returns the exact size. Inline images are not listed.

### POST /send, /reply, /forward (send)
JSON body, all require `idempotency_key` (1-200 visible ASCII chars; or the `Idempotency-Key` header).
Repeating the same key with the same body within 24 h returns the first result with
`idempotent_replay: true` and sends nothing. Use a fresh key per intended mail; reuse it on retries.

- **/send**: `{ to: [addr], cc?, bcc?, subject, text, html?, idempotency_key }`.
  Addresses: `"a@b.c"` or `"Name <a@b.c>"`, array or comma string.
- **/reply**: `{ message_id, folder?, text, html?, reply_all?: false, cc?, bcc?, quote?: true, idempotency_key }`.
  Mailloom fills To (Reply-To, else From; for your own sent mail, its To), reply-all adds the original
  To/Cc minus this mailbox, subject `Re: ...`, `In-Reply-To` and `References`, and quotes the original
  as plain text unless `quote: false`. The original gets the \Answered flag.
- **/forward**: `{ message_id, folder?, to, cc?, bcc?, text? (your note), include_attachments?: true, idempotency_key }`.
  Subject `Fwd: ...`, original header block and body (HTML kept, sanitised) and all original attachments.
  Total limited by `MAIL_MAX_MESSAGE_BYTES`.

Success:
```
{ sent: true, message_id: "<...>", accepted: [addr], rejected: [addr],
  saved_to_sent: true|false, sent_folder: "Sent"|null, idempotent_replay: false }
```
`message_id` is the same in the delivered mail and the Sent copy. Every agent mail carries
`X-Mailloom-Agent: <key id>` (the non-secret record id). Guards: `AGENT_SENDS_PER_HOUR` per key (default 200, 429 + Retry-After),
`AGENT_MAX_RECIPIENTS` to+cc+bcc (default 100, 400).

### POST /move, /flag, /mark-read, /delete (organise)
Body: message reference (`message_id`, or `folder`+`uid`) plus:
- **/move**: `to_folder` (must exist). → `{ ok, from_folder, folder, uid|null }`
- **/flag**: `flagged: true|false` → `{ ok, folder, uid, flagged }`
- **/mark-read**: `read: true|false` → `{ ok, folder, uid, read }`
- **/delete**: moves to Trash (created if missing). Never permanent. → `{ ok, from_folder, folder, uid|null }`

## Audit

Every authenticated call is logged (time, key prefix, X-Workos-User/Session, tool, folder, Message-ID;
for sends recipients, subject, sent Message-ID, result). The person sees the latest 200 in Connections > Activity.
