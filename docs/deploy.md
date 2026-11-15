# Deploying Mailloom (runbook for Om)

Target: the Ubuntu EC2 server that already runs iRedMail (Dovecot, Postfix, Nginx). Mailloom runs there as one
Node process under pm2, behind Nginx, talking to Dovecot and Postfix on 127.0.0.1.

Nothing in this document has been run against the real server yet. Do the **trial** (section 9) with a test
mailbox before any staff member signs in.

## 0. Read this first

- The old files `deploy/server.mjs` and `mailloom-standalone.tar.gz` were removed from git. They contained old,
  insecure code. Never deploy anything that was not produced by `pnpm release` (section 2).
- The secrets that used to be committed in the old deploy files (and the old `.env`) are **leaked**. Treat them as
  public. Do not reuse them anywhere. The server refuses to start if `SESSION_SECRET` is one of them. If the
  production server ever ran with them, replace every secret there (section 10).
- You need Node.js **22.13 or newer** on the server. Mailloom stores sessions with the built-in `node:sqlite`, which
  is only available without a flag from 22.13. On an older Node the server stops at once and says so.

## 1. Prerequisites on the server (once)

Run as an admin user with sudo.

```bash
# Node 22 (NodeSource), then check the version: it must print v22.13.0 or higher
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v

# pm2
sudo npm install -g pm2

# A dedicated user that owns nothing else and cannot log in
sudo useradd --system --create-home --home-dir /home/mailloom --shell /usr/sbin/nologin mailloom

# Folders
sudo mkdir -p /opt/mailloom/releases /etc/mailloom /var/lib/mailloom
sudo chown -R mailloom:mailloom /opt/mailloom /var/lib/mailloom
sudo chmod 700 /var/lib/mailloom          # the sessions database lives here (SESSION_DB_PATH)
sudo chown root:mailloom /etc/mailloom
sudo chmod 750 /etc/mailloom
```

Also needed:

- A DNS name for Mailloom (for example `webmail.delpat.in`) pointing at this server, and a TLS certificate for it
  (Let's Encrypt with `certbot --nginx` works). Use a name of its own: the web app and the install-to-phone
  feature expect to live at the top of a host, not under `/mail`.
- Outbound https from the server to the browser push services (fcm.googleapis.com, `*.push.services.mozilla.com`,
  `*.notify.windows.com`, `web.push.apple.com`, `*.push.apple.com`), only if you turn on push notifications.

## 2. Build the release (on your computer, not on the server)

```bash
git checkout main && git pull
pnpm install
pnpm release
```

`pnpm release` builds the client and the server from the committed source, starts the result twice with throwaway
settings (once with no secrets, which must refuse to start; once with a full set, which must serve the app and
create its sqlite file), and writes `release/mailloom-<commit>.tar.gz`. The commit is in the file name. If the name
ends in `-dirty` there were uncommitted changes: do not deploy it.

The tarball holds: `server.mjs` (launcher that checks the Node version), `server.bundle.mjs` (the server with every
dependency inside; the server needs no `npm install`), `public/` (the web app), `ecosystem.config.cjs`
(pm2), `.env.example` and `VERSION`.

## 3. Put it on the server

Copy the tarball over (`scp release/mailloom-<commit>.tar.gz you@server:/tmp/`), then on the server:

```bash
cd /opt/mailloom/releases
sudo -u mailloom tar -xzf /tmp/mailloom-<commit>.tar.gz     # creates mailloom-<commit>/
sudo -u mailloom ln -sfn /opt/mailloom/releases/mailloom-<commit> /opt/mailloom/current
```

`/opt/mailloom/current` always points at the release that runs. Old release folders stay for rollback (section 8).

## 4. The settings file

```bash
sudo cp /opt/mailloom/current/.env.example /etc/mailloom/mailloom.env
sudo chown mailloom:mailloom /etc/mailloom/mailloom.env
sudo chmod 600 /etc/mailloom/mailloom.env
sudo -u mailloom nano /etc/mailloom/mailloom.env
```

pm2 passes the file's location to the server (`DOTENV_CONFIG_PATH` in `ecosystem.config.cjs`). The server
refuses to start, and lists every problem at once, if a required value is missing or unsafe.

| Variable | Set it to | How to get it / what it does |
|---|---|---|
| `NODE_ENV` | `production` | |
| `HOST` | `127.0.0.1` | Listen on this machine only. Nginx is the only way in. (In production, if left unset the server listens on 127.0.0.1 only; it listens on every address only when `HOST` is set to `0.0.0.0` on purpose.) |
| `PORT` | `3000` | Any free port; must match the Nginx `proxy_pass`. |
| `SESSION_SECRET` | 64 hex characters | **Required.** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Encrypts the mail passwords kept in sessions, agent keys and push devices. Never reuse a value from anywhere else. |
| `SESSION_DB_PATH` | `/var/lib/mailloom/sessions.db` | The sqlite file. Folder must be `chmod 700`, owned by `mailloom`. If empty, sessions live in memory and everyone is signed out on every restart. |
| `SESSION_IDLE_MINUTES`, `SESSION_SHORT_MAX_HOURS`, `SESSION_REMEMBER_DAYS` | `30`, `12`, `30` | Session lifetimes. Defaults are fine. | `SESSION_REMEMBER_MAX_DAYS` (default `180`) caps a Remember Me session from sign-in.
| `MAIL_IMAP_HOST`, `MAIL_IMAP_PORT`, `MAIL_IMAP_SECURE` | `127.0.0.1`, `993`, `true` | **Required** host. Dovecot on this machine. |
| `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT` | `127.0.0.1`, `587` | **Required** host. Postfix submission (STARTTLS). Use 465 for implicit TLS. SMTP without encryption is refused. |
| `MAIL_TLS_SERVERNAME` | the certificate name of the mail host, e.g. `mail.delpat.in` | Mailloom connects to 127.0.0.1, but the certificate Dovecot and Postfix show is for the mail host name. This is the name the server checks it against. Find it with `openssl s_client -connect 127.0.0.1:993 -servername mail.delpat.in </dev/null 2>/dev/null \| openssl x509 -noout -subject -ext subjectAltName`. Leave `MAIL_TLS_REJECT_UNAUTHORIZED=true`; never switch certificate checks off on a real server. |
| `MAIL_TLS_CA_FILE` | `/etc/mailloom/mail-ca.pem` | Optional. A PEM file with the certificate (or CA) to trust for the mail server, read once at start-up; Mailloom refuses to start if it is unreadable or holds no certificate. Checks stay on, and the name is still checked against `MAIL_TLS_SERVERNAME`. See "Self-signed mail certificate" below. |
| `MAIL_DOMAINS` | `delpat.in,houseofhumanity.in` | **Required.** Only these domains can sign in. Only domains whose mailboxes live on this iRedMail server belong here. |
| `MAIL_MAX_MESSAGE_BYTES` | see below | Largest attachment total of one outgoing mail (raw bytes). Default 10485760 (10 MB). |
| `COOKIE_SECURE` | `true` | Always. Sign-in cookies become `__Host-` Secure cookies and sign-in over plain http is refused. |
| `TRUST_PROXY` | `127.0.0.1` | The Nginx address. Gives the server the real visitor address (sign-in throttling, agent API check). Never `true`, never a hop count when the agent API is on. |
| `CORS_ORIGINS` | empty | Other web origins allowed to call the API from a browser. Same origin needs nothing; leave empty. |
| `MAILLOOM_PUBLIC_URL` | `https://mail.delpat.in/mail` | The public address; agent API responses carry a `web_url` for each message. Must be https. **Required when Connect is on**: it is the `iss` of the authorisation reply and where the consent screen opens. |
| `AGENT_ALLOWED_IPS` | the Work OS server's public IP | Comma list of IPs or CIDR ranges allowed to call `/api/agent/v1/*`. Empty = agent API off. Ranges wider than /8 are refused. |
| `AGENT_CLIENT_ID` | `work-os` | Connect Mailloom ("one click" link from Work OS). Not secret. Connect is on only when this, the secret and the redirect list are all set, and `AGENT_ALLOWED_IPS` is set too. With these set, `MAILLOOM_PUBLIC_URL` is **required** (Mailloom refuses to start without it). |
| `AGENT_CLIENT_SECRET` | 32+ random characters | Same value as Work OS's `MAILLOOM_CLIENT_SECRET`. Mailloom refuses to start with a shorter one. Never logged. |
| `AGENT_CLIENT_REDIRECT_URIS` | `https://<work os>/api/mail/callback` | Comma list, matched exactly. https only (http only for `localhost` or `127.0.0.1`). Anything else is refused and the browser is never sent there. `localhost` and `127.0.0.1` entries are refused when `NODE_ENV=production`. |
| `AGENT_CLIENT_NAME` | `Work OS` | Optional. The name people see as the headline of the consent screen and in Connections. |
| `AGENT_SENDS_PER_HOUR`, `AGENT_MAX_RECIPIENTS`, `AGENT_MAX_TEXT_CHARS`, `AGENT_MAX_ATTACHMENT_BYTES` | defaults | Optional guard rails, see `docs/agent-api.md`. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | key pair + `mailto:it@delpat.in` | Phone/desktop notifications while the app is closed. All three or none. Generate the pair once, on your computer, in the repo: `pnpm --filter mailloom-server exec web-push generate-vapid-keys`. Keep the private key secret. |
| `DEMO_MODE` | `0` | Leave off on the real server. |

**Self-signed mail certificate (iRedMail default).** Run `openssl s_client -connect 127.0.0.1:993 -servername mail.delpat.in </dev/null 2>/dev/null | openssl x509 -noout -issuer -subject`. If issuer and subject are the same (iRedMail's own certificate, for example CN `mail.houseofhumanity.in`), Mailloom rejects it, correctly. Two fixes:

1. Preferred: point Dovecot (`ssl_cert`, `ssl_key`) and Postfix (`smtpd_tls_cert_file`, `smtpd_tls_key_file`) at the Let's Encrypt certificate the box already has for `mail.delpat.in`, reload both, and set `MAIL_TLS_SERVERNAME=mail.delpat.in`. No `MAIL_TLS_CA_FILE` is needed.
2. Otherwise trust that one certificate. Save it (as root) and let the `mailloom` user read it:

   ```
   sudo mkdir -p /etc/mailloom
   openssl s_client -connect 127.0.0.1:993 </dev/null 2>/dev/null | openssl x509 | sudo tee /etc/mailloom/mail-ca.pem >/dev/null
   sudo chown root:mailloom /etc/mailloom/mail-ca.pem && sudo chmod 640 /etc/mailloom/mail-ca.pem
   ```

   Then set `MAIL_TLS_CA_FILE=/etc/mailloom/mail-ca.pem` and restart. Set `MAIL_TLS_SERVERNAME` to a DNS name from the certificate's `subjectAltName` (see `openssl x509 -noout -ext subjectAltName`). If the certificate has any, Node ignores the CN, so the CN is only right when the certificate has no subjectAltName at all. Postfix on 587 may show a different certificate; check, and if it differs, append it to the same file:

   ```
   openssl s_client -starttls smtp -connect 127.0.0.1:587 </dev/null 2>/dev/null | openssl x509 | sudo tee -a /etc/mailloom/mail-ca.pem >/dev/null
   ```

   Certificate checks stay on. If iRedMail renews its certificate, repeat the save.


**`MAIL_MAX_MESSAGE_BYTES` and Postfix.** Attachments grow by about a third when mail is encoded. Postfix refuses a
message bigger than `message_size_limit`. Look it up (`postconf message_size_limit`; iRedMail often sets 15728640,
15 MB) and set `MAIL_MAX_MESSAGE_BYTES` to at most 70% of it: 10485760 for a 15 MB Postfix limit. A larger value
lets people attach something that Postfix then refuses after a long upload.

## 5. Nginx

Create `/etc/nginx/sites-available/mailloom.conf` (or the place iRedMail keeps its sites) and link it into
`sites-enabled`. Replace the name and certificate paths.

```nginx
# Sign-in attempts: 5 per minute per visitor address, small bursts allowed. (Put this line in the http block,
# e.g. a file in /etc/nginx/conf.d/.)
limit_req_zone $binary_remote_addr zone=mailloom_login:10m rate=5r/m;

server {
    listen 80;
    server_name webmail.delpat.in;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name webmail.delpat.in;

    ssl_certificate     /etc/letsencrypt/live/webmail.delpat.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/webmail.delpat.in/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;

    # Security headers for the app shell. The server sets the same ones itself (so it is safe without Nginx);
    # repeating them here also covers Nginx error pages. Remember: add_header in a location block replaces
    # the ones from the server block, so repeat them there if you add your own.
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'" always;

    # Largest request body. Must be at least MAIL_MAX_MESSAGE_BYTES plus a little; 16m covers the 10 MB default.
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;                       # cookie and origin checks use it
        proxy_set_header X-Forwarded-For $remote_addr;     # the real visitor; not appended to anything a client sent
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;        # sign-in over plain http is refused
    }

    location = /api/auth/connect {
        limit_req zone=mailloom_login burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Sending mail with big attachments is slow: allow longer here only.
    location = /api/messages/send {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
        client_max_body_size 16m;
    }
}
```

The default 60 second timeouts are right for everything else. No websockets are used, so there are no `Upgrade`
headers. Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

If the Work OS server reaches Mailloom through another proxy or CDN, `AGENT_ALLOWED_IPS` is checked against the
address Nginx sees; adjust `X-Forwarded-For` for that case and keep the rule that only your own proxy can set it.

## 6. Start it with pm2

```bash
sudo -u mailloom -H pm2 start /opt/mailloom/current/ecosystem.config.cjs
sudo -u mailloom -H pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u mailloom --hp /home/mailloom     # prints one command; run it
sudo -u mailloom -H pm2 logs mailloom --lines 50        # should say "Mailloom Webmail Server running"
```

One process only (`instances: 1`): sessions and the push watchers live inside it. If the system `node` is older
than 22.13, install a newer one and set `interpreter` in `ecosystem.config.cjs` before starting.

## 7. Check from outside

- `https://webmail.delpat.in/` shows the sign-in page, padlock valid. `http://` redirects to https.
- Sign-in over a wrong password fails with a plain message; five wrong tries in 15 minutes locks that address out.

## 8. Update and roll back

Update: build a new tarball (section 2), unpack beside the old one (section 3), then switch the link and restart:

```bash
sudo -u mailloom ln -sfn /opt/mailloom/releases/mailloom-<new> /opt/mailloom/current
sudo -u mailloom -H pm2 restart mailloom --update-env
```

**Roll back** to the previous release: the old folder is still there.

```bash
ls -1 /opt/mailloom/releases                       # pick the previous one
sudo -u mailloom ln -sfn /opt/mailloom/releases/mailloom-<previous> /opt/mailloom/current
sudo -u mailloom -H pm2 restart mailloom --update-env
```

The sessions database is shared by all releases. A new release may add tables; an older one ignores them, so
rolling back keeps everyone signed in. Delete release folders older than the last three once a month.

## 9. Trial checklist (test mailbox, before staff)

Create a test mailbox (for example `mailloom-test@delpat.in`) in iRedAdmin. Tick each item:

1. Sign-in page loads over https, wrong password is refused, right password opens the inbox.
2. An external address sends a mail to the test mailbox; it shows up within a minute.
3. Reply from Mailloom to an outside address you own; it arrives, and a copy is in Sent.
4. Send with a 5 MB attachment; it arrives. Try one over `MAIL_MAX_MESSAGE_BYTES`; a clear message says it is too big.
5. Open a mail with an image from outside: images are blocked until you choose to load them.
6. Move, flag, delete (goes to Trash), mark read and unread.
7. Sign out, sign in again; "Remember me" survives closing the browser; `pm2 restart mailloom` does not sign anyone out.
8. Install on a phone and on a desktop ("Add to home screen" / "Install"); turn notifications on, send a mail to the
   test mailbox with the app closed, tap the notification: the mail opens.
9. Open a link of the form `https://webmail.delpat.in/#/m/<url-encoded Message-ID>` after signing in: it opens that
   mail, also when it has been moved to another folder; a made-up id shows "This message was moved or deleted".
10. Agent API: from the Work OS server, `GET /api/agent/v1/whoami` with a key made in Connections answers 200; the same
    call from any other address answers 403 `IP_NOT_ALLOWED`.
11. `curl -I http://127.0.0.1:3000` works from the server but the port is not reachable from outside (check the
    EC2 security group allows only 80, 443 and the mail ports).
12. `pm2 logs mailloom` shows no errors and no passwords or mail text.

Only after all twelve pass, give staff the address.

## 10. Rotating secrets

Edit `/etc/mailloom/mailloom.env`, then `sudo -u mailloom -H pm2 restart mailloom --update-env`.

| Secret | Generate | What it breaks |
|---|---|---|
| `SESSION_SECRET` | the `randomBytes(32)` command above | Everyone is signed out. **Push notifications stop** on every device (stored passwords cannot be opened; people turn them on again). **Agent keys stop working** (Work OS gets `KEY_BROKEN`; each person makes a new key in Connections and Work OS stores it). Do it at a quiet time and tell people. |
| `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` | `web-push generate-vapid-keys` | Every device's notifications stop until turned on again. Only rotate if the private key leaked. |
| Agent key (one person) | Mailloom > Connections > rotate | The old key stops at once; paste the new one into Work OS. |
| A person's mail password | iRedAdmin | Their Mailloom sessions, push and agent key are refused by the mail server; they sign in again and rotate the key. |
| `AGENT_CLIENT_SECRET` | edit | Change it together with Work OS's `MAILLOOM_CLIENT_SECRET`; until both match, Connect fails at the token step. Keys already minted keep working. |
| `AGENT_ALLOWED_IPS` | edit | Only the listed callers get in. Empty turns the agent API off. |

After the old committed secrets (section 0): generate a new `SESSION_SECRET` for the real server, and if the real
mail or admin passwords were ever kept in the old files, change those in iRedAdmin too.

## 11. If something is wrong

- `pm2 logs mailloom` first. A startup problem is printed as `Mailloom cannot start:` followed by the list.
- "Needs Node.js 22.13": `node -v` as the `mailloom` user; set `interpreter` in the pm2 file.
- "SESSION_SECRET is not set": pm2 is not reading the file; check `DOTENV_CONFIG_PATH` and that `mailloom` can read it.
- Sign-in says it needs https: Nginx is not sending `X-Forwarded-Proto`, or `TRUST_PROXY` is not `127.0.0.1`.
- Sign-in works but is signed out on the next click: `Host` header not forwarded, or `COOKIE_SECURE` not `true`.
- Certificate errors to the mail server: fix `MAIL_TLS_SERVERNAME`, or trust the server's self-signed certificate with `MAIL_TLS_CA_FILE`; do not turn checks off.
- Stuck: roll back (section 8).
