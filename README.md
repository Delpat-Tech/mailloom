# Mailloom ✉️
### Lightweight Modern Webmail Client for Delpat Infrastructure (Roundcube Replacement)

> **Repository:** [https://github.com/Delpat-Tech/mailloom.git](https://github.com/Delpat-Tech/mailloom.git)  
> **Architecture:** Option A (Live IMAP/SMTP Proxy Architecture)  
> **Design Target:** Ubuntu EC2 (`t3/t4g`) low-memory runtime, iRedMail stack (Dovecot + Postfix + Nginx).

---

## 🌟 Why Mailloom?

Mailloom is built to replace legacy PHP Roundcube on Delpat's production servers (`delpat.in`, `houseofhumanity.in`, `ydco.in`) with a blazing-fast, ultra-lightweight modern webmail interface.

### 🛡️ Strictly Engineered for Low-RAM EC2 Performance:
1. **Ultra-Low Memory Footprint (Fastify + Vite)**:
   - Uses **Fastify** instead of heavy frameworks. Idles at under ~35MB RAM.
   - Frontend is compiled into optimized static assets with relative base paths (`base: './'`), allowing it to be served either directly by Nginx or natively by Fastify on port 3000.
2. **Dovecot Safe Connection Pooling & Auto-Cleanup**:
   - `imapflow` connections are managed in an in-memory pool with a **60-second inactivity reaper**.
   - If a user closes their tab or stays idle, their TCP socket to Dovecot is automatically closed gracefully.
   - Calling `/api/auth/logout` terminates sockets immediately. This completely prevents hitting Dovecot’s `max_user_connections` limit.
3. **True Memory Streaming (Zero Attachment Buffering in RAM)**:
   - Attachment downloads stream directly from Dovecot to the HTTP response socket with backpressure.
   - 25MB attachments consume 0 bytes of persistent Node RAM, protecting the EC2 instance from out-of-memory crashes.
4. **Stateless Authentication (Zero Local Database)**:
   - No Postgres, MySQL, or Mongo containers required.
   - User credentials are encrypted server-side using **AES-256-GCM** with dynamic initialization vectors (IV) and authentication tags.
5. **Auto-Append to Sent**:
   - Outgoing messages sent via Postfix SMTP (`nodemailer`) are automatically compiled and appended to the user’s IMAP `Sent` folder (`\Sent`).
6. **Sandboxed Email Rendering**:
   - Rendered inside sandboxed `<iframe>` elements (`sandbox="allow-popups allow-popups-to-escape-sandbox"`) with HTML sanitization via `sanitize-html`. Prevents CSS bleed and malicious script execution.
7. **1-Click Demo Mailbox**:
   - Built-in realistic mock mail provider pre-loaded with fastener quotes, dispatches, and PDF invoices for instant offline or team evaluation.

---

## 🛠️ Tech Stack

| Component | Technology | Rationale |
|---|---|---|
| **Backend API** | Fastify, TypeScript, Node.js | Ultra-low memory, fast routing, built-in chunked streaming |
| **IMAP Client** | `imapflow` | High-performance IMAP, connection pooling, raw stream download |
| **SMTP Transport** | `nodemailer` | Direct Postfix loopback dispatch with Sent mailbox append |
| **MIME Decoding** | `mailparser` | Multipart message parser, UTF-8 charsets, attachment detection |
| **Security** | `crypto` (AES-256-GCM), `sanitize-html` | Sealed stateless cookies & anti-XSS email sanitization |
| **Frontend** | React 18, Vite, Tailwind CSS, Lucide Icons | Responsive 3-pane desktop webmail layout |

---

## 🚀 Deployment & Running

### 1. Local Development
```bash
# Install dependencies
pnpm install

# Start backend (:3000) and frontend with hot-reload (:3000 proxy)
pnpm dev
```
Open **[http://localhost:3000](http://localhost:3000)**.

### 2. Production Build
```bash
pnpm build
```
This builds both `server/dist` and `client/dist`.

### 3. Production Start (Single Self-Contained Daemon)
Fastify serves both the REST API and the React Single Page App on port 3000:
```bash
pnpm start
# or via PM2:
pm2 start server/dist/index.js --name mailloom
```

### 4. Running Integration Tests
Verifies health, demo connect, auth recovery, mailboxes, messages, flags, send, sent-append, attachment streaming, and socket reaper:
```bash
pnpm test
```

---

## 🌐 Nginx Configuration on iRedMail Server

In `/etc/nginx/sites-available/` (e.g. for `mail.delpat.in`), configure the reverse proxy block:

```nginx
location /mail/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Since the backend and Dovecot/Postfix live on the same Ubuntu instance:
- **IMAP**: `127.0.0.1:993` (SSL) or `127.0.0.1:143` (STARTTLS) — latency is `~0ms`.
- **SMTP**: `127.0.0.1:587` (STARTTLS) or `127.0.0.1:25` — latency is `~0ms`.

---

## 📬 Login Presets & Domain Support

The login screen includes one-click presets:
- **Delpat Mail (Dovecot / Postfix)**: Pre-configures `127.0.0.1:993` (IMAP) and `127.0.0.1:587` (SMTP). Auto-detects emails ending in:
  - `@delpat.in`
  - `@houseofhumanity.in`
  - `@ydco.in`
- **Gmail / Google Workspace**: `imap.gmail.com:993` & `smtp.gmail.com:465`.
- **Outlook / Office 365**: `outlook.office365.com:993` & `smtp.office365.com:587`.
- **cPanel / Custom**: Custom host/port inputs.
- **1-Click Instant Demo**: No server credentials required.
