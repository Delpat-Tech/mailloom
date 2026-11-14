import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
let server: tls.Server;
let port = 0;
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
});
after(() => new Promise<void>((r) => server.close(() => r())));

function account(tlsOpts: AccountConfig['tls']): AccountConfig {
  return {
    imapHost: '127.0.0.1', imapPort: port, imapSecure: true, imapUser: 'u@delpat.test', imapPass: 'x',
    smtpHost: '127.0.0.1', smtpPort: port, smtpSecure: true, smtpRequireTLS: true,
    tls: tlsOpts
  } as AccountConfig;
}

test('config: MAIL_TLS_CA_FILE is read and passed through', () => {
  const cfg = loadConfig({ ...baseEnv(), MAIL_TLS_CA_FILE: certPath });
  assert.equal(cfg.mail.tls.ca, certPem);
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
  // With the CA and right name, TLS succeeds; the fake server then fails the IMAP conversation, not the certificate.
  assert.doesNotMatch(await imapError({ rejectUnauthorized: true, servername: 'mail.test.local', ca: certPem }), certErr);
});
