import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError } from '../src/config.js';
import { createImapClient } from '../src/services/imap.js';
import { createSmtpTransport } from '../src/services/smtp.js';
import type { AccountConfig } from '../src/types.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const certPath = path.join(dir, 'selfsigned-cert.pem');
const keyPath = path.join(dir, 'selfsigned-key.pem');
const certPem = fs.readFileSync(certPath, 'utf8');

const baseEnv = () => ({
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  MAIL_IMAP_HOST: '127.0.0.1',
  MAIL_SMTP_HOST: '127.0.0.1',
  MAIL_DOMAINS: 'delpat.test'
});

// A tiny implicit-TLS server that speaks just enough SMTP and IMAP for a connection check.
const CRLF = String.fromCharCode(13, 10);
let server: tls.Server;
let imapServer: tls.Server;
let startServer: net.Server;
let port = 0;
let imapPort = 0;
let startPort = 0;
const imapLines: string[] = [];
before(async () => {
  server = tls.createServer({ key: fs.readFileSync(keyPath), cert: certPem }, (sock) => {
    sock.on('error', () => {});
    sock.write('220 mail.test.local ESMTP\r\n');
    sock.on('data', (d) => {
      for (const line of d.toString().split('\r\n').filter(Boolean)) {
        if (/^EHLO|^HELO/i.test(line)) sock.write('250 mail.test.local\r\n');
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;

  // Implicit-TLS IMAP that refuses every login, so reaching LOGIN proves the handshake passed.
  imapServer = tls.createServer({ key: fs.readFileSync(keyPath), cert: certPem }, (sock) => {
    sock.on('error', () => {});
    sock.write('* OK IMAP ready\r\n');
    sock.on('data', (d) => {
      for (const line of d.toString().split('\r\n').filter(Boolean)) {
        imapLines.push(line);
        const [tag, cmd = ''] = line.split(' ');
        if (/^CAPABILITY$/i.test(cmd)) sock.write('* CAPABILITY IMAP4rev1' + CRLF + tag + ' OK done' + CRLF);
        else if (/^LOGIN$/i.test(cmd)) sock.write(tag + ' NO [AUTHENTICATIONFAILED] refused' + CRLF);
        else sock.write(tag + ' OK done' + CRLF);
      }
    });
  });
  await new Promise<void>((r) => imapServer.listen(0, '127.0.0.1', r));
  imapPort = (imapServer.address() as AddressInfo).port;

  // Port-587 style SMTP: plain greeting, then STARTTLS.
  startServer = net.createServer((raw) => {
    raw.on('error', () => {});
    raw.write('220 mail.test.local ESMTP' + CRLF);
    const onPlain = (d: Buffer) => {
      for (const line of d.toString().split('\r\n').filter(Boolean)) {
        if (/^EHLO|^HELO/i.test(line)) raw.write('250-mail.test.local' + CRLF + '250 STARTTLS' + CRLF);
        else if (/^STARTTLS/i.test(line)) {
          raw.write('220 go ahead' + CRLF);
          raw.off('data', onPlain);
          const secure = new tls.TLSSocket(raw, { isServer: true, key: fs.readFileSync(keyPath), cert: certPem });
          secure.on('error', () => {});
          secure.on('data', (c) => {
            for (const l of c.toString().split('\r\n').filter(Boolean)) {
              if (/^EHLO|^HELO/i.test(l)) secure.write('250 mail.test.local' + CRLF);
              else if (/^QUIT/i.test(l)) secure.end('221 bye' + CRLF);
            }
          });
        }
      }
    };
    raw.on('data', onPlain);
  });
  await new Promise<void>((r) => startServer.listen(0, '127.0.0.1', r));
  startPort = (startServer.address() as AddressInfo).port;
});
after(async () => {
  for (const sv of [server, imapServer, startServer]) await new Promise<void>((r) => sv.close(() => r()));
});

function account(tlsOpts: AccountConfig['tls'], over: Partial<AccountConfig> = {}): AccountConfig {
  return {
    imapHost: '127.0.0.1', imapPort, imapSecure: true, imapUser: 'u@delpat.test', imapPass: 'x',
    smtpHost: '127.0.0.1', smtpPort: port, smtpSecure: true, smtpRequireTLS: true,
    tls: tlsOpts,
    ...over
  } as AccountConfig;
}

test('config: MAIL_TLS_CA_FILE is read and passed through', () => {
  const cfg = loadConfig({ ...baseEnv(), MAIL_TLS_CA_FILE: certPath });
  assert.equal(cfg.mail.tls.ca?.trim(), certPem.trim());
  assert.equal(cfg.mail.tls.rejectUnauthorized, true);
  assert.equal(loadConfig(baseEnv()).mail.tls.ca, undefined);
});

test('config: missing or non-PEM CA file stops start-up', () => {
  assert.throws(() => loadConfig({ ...baseEnv(), MAIL_TLS_CA_FILE: path.join(dir, 'nope.pem') }), (e) => e instanceof ConfigError && /MAIL_TLS_CA_FILE.*cannot be read/.test(e.message));
  const junk = path.join(os.tmpdir(), `junk-${process.pid}.pem`);
  fs.writeFileSync(junk, 'not a certificate');
  try {
    assert.throws(() => loadConfig({ ...baseEnv(), MAIL_TLS_CA_FILE: junk }), (e) => e instanceof ConfigError && /PEM certificate/.test(e.message));
  } finally {
    fs.unlinkSync(junk);
  }
});

test('smtp: self-signed certificate fails without the CA, succeeds with it, fails for a wrong name', async () => {
  await assert.rejects(createSmtpTransport(account({ rejectUnauthorized: true, servername: 'mail.test.local' })).verify(), /self.signed|SELF_SIGNED|certificate/i);
  assert.equal(await createSmtpTransport(account({ rejectUnauthorized: true, servername: 'mail.test.local', ca: certPem })).verify(), true);
  await assert.rejects(createSmtpTransport(account({ rejectUnauthorized: true, servername: 'wrong.example.com', ca: certPem })).verify(), /altnames|hostname|certificate/i);
});

async function imapError(t: AccountConfig['tls']): Promise<string> {
  const c = createImapClient(account(t), { connectionTimeout: 3000, greetingTimeout: 3000 });
  c.on('error', () => {});
  try {
    await c.connect();
    return 'connected';
  } catch (e) {
    return `${(e as { code?: string }).code ?? ''} ${(e as Error).message}`;
  } finally {
    c.close();
  }
}

test('imap: same CA rules apply', async () => {
  const certErr = /SELF_SIGNED|self.signed|altnames|hostname|certificate/i;
  assert.match(await imapError({ rejectUnauthorized: true, servername: 'mail.test.local' }), certErr);
  assert.match(await imapError({ rejectUnauthorized: true, servername: 'wrong.example.com', ca: certPem }), certErr);
  // With the CA and right name the handshake passes and the client reaches the login stage, where the fake server refuses it.
  imapLines.length = 0;
  const result = await imapError({ rejectUnauthorized: true, servername: 'mail.test.local', ca: certPem });
  assert.ok(imapLines.some((l) => l.split(' ')[1] === 'LOGIN' || l.split(' ')[1] === 'AUTHENTICATE'), `no login attempt seen (${result}; saw ${JSON.stringify(imapLines)})`);
  assert.doesNotMatch(result, certErr);
});

test('smtp STARTTLS (port 587 style): fails without the CA, succeeds with it', async () => {
  const over = { smtpPort: startPort, smtpSecure: false, smtpRequireTLS: true };
  await assert.rejects(createSmtpTransport(account({ rejectUnauthorized: true, servername: 'mail.test.local' }, over)).verify(), /self.signed|SELF_SIGNED|certificate/i);
  assert.equal(await createSmtpTransport(account({ rejectUnauthorized: true, servername: 'mail.test.local', ca: certPem }, over)).verify(), true);
});

test('config: corrupt certificate body stops start-up; key block is dropped', () => {
  const tmp = path.join(os.tmpdir(), `ca-${process.pid}.pem`);
  try {
    fs.writeFileSync(tmp, ['-----BEGIN CERTIFICATE-----', 'bm90IGEgY2VydA==', '-----END CERTIFICATE-----', ''].join(String.fromCharCode(10)));
    assert.throws(() => loadConfig({ ...baseEnv(), MAIL_TLS_CA_FILE: tmp }), (e) => e instanceof ConfigError && /cannot be parsed/.test(e.message));
    fs.writeFileSync(tmp, fs.readFileSync(keyPath, 'utf8') + certPem);
    const ca = loadConfig({ ...baseEnv(), MAIL_TLS_CA_FILE: tmp }).mail.tls.ca ?? '';
    assert.match(ca, /BEGIN CERTIFICATE/);
    assert.doesNotMatch(ca, /PRIVATE KEY/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
