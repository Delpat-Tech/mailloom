import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AccountConfig } from '../types.js';
import type { AppConfig } from '../config.js';
import type { Session, SessionStore } from '../services/sessions.js';
import type { LoginThrottle } from '../services/login-throttle.js';
import { closeSessionConnection, createImapClient } from '../services/imap.js';

/**
 * Sign-in, sign-out and the requireAuth pre-handler.
 *
 * Multi-account design: every signed-in account in a browser has its own session
 * and its own httpOnly cookie named after a short public handle:
 *   mls_<handle> = <session id>          (on localhost)
 *   __Host-mls_<handle> = <session id>   (everywhere else; Secure)
 * The client names the account a request is for with the X-Mailloom-Account
 * header (or ?account= on GET links such as attachment downloads). The session
 * id itself never reaches JavaScript. Requiring a custom header on API calls also
 * blocks cross-site form posts (CSRF), on top of SameSite=Strict.
 */

export interface MailloomContext {
  config: AppConfig;
  sessions: SessionStore;
  throttle: LoginThrottle;
}

declare module 'fastify' {
  interface FastifyInstance {
    mailloom: MailloomContext;
  }
  interface FastifyRequest {
    accountConfig?: AccountConfig;
    mailSession?: Session;
  }
}

export const ACCOUNT_HEADER = 'x-mailloom-account';
const HANDLE_RE = /^[A-Za-z0-9_-]{12}$/;
const COOKIE_RE = /^(?:__Host-)?mls_([A-Za-z0-9_-]{12})$/;

export const AUTH_ERRORS = {
  NOT_SIGNED_IN: 'Please sign in.',
  SESSION_EXPIRED: 'Your session has ended. Please sign in again.',
  BAD_CREDENTIALS: 'Wrong email or password.',
  MAIL_SERVER_UNREACHABLE: 'Mail server unreachable. Please try again in a few minutes.',
  INVALID_INPUT: 'Enter your email address and password.',
  DEMO_DISABLED: 'Demo mode is not available on this server.'
} as const;

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').replace(/:\d+$/, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function useSecureCookies(req: FastifyRequest): boolean {
  return req.server.mailloom.config.cookieAlwaysSecure || !isLoopbackHost(req.hostname || '');
}

function cookieName(req: FastifyRequest, handle: string): string {
  return `${useSecureCookies(req) ? '__Host-' : ''}mls_${handle}`;
}

function cookieOptions(req: FastifyRequest) {
  return { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: useSecureCookies(req) };
}

function clearAccountCookie(req: FastifyRequest, reply: FastifyReply, handle: string): void {
  reply.clearCookie(cookieName(req, handle), cookieOptions(req));
}

/** Handles of all account cookies this browser sent, mapped to their session ids. */
function accountCookies(req: FastifyRequest): Map<string, string> {
  const secure = useSecureCookies(req);
  const found = new Map<string, string>();
  for (const [name, value] of Object.entries(req.cookies || {})) {
    const m = COOKIE_RE.exec(name);
    if (!m || !value) continue;
    // Only accept the cookie form this host issues (no unprefixed cookie on a secure host).
    if (name.startsWith('__Host-') !== secure) continue;
    found.set(m[1]!, value);
  }
  return found;
}

function requestedHandle(req: FastifyRequest): string | null {
  const header = req.headers[ACCOUNT_HEADER];
  let handle = Array.isArray(header) ? header[0] : header;
  // Query form only for safe reads (download links); state changes need the header.
  if (!handle && (req.method === 'GET' || req.method === 'HEAD')) {
    const q = (req.query as Record<string, unknown> | undefined)?.account;
    handle = typeof q === 'string' ? q : undefined;
  }
  return handle && HANDLE_RE.test(handle) ? handle : null;
}

export function accountConfigFor(session: Session, config: AppConfig): AccountConfig {
  const mail = config.mail;
  return {
    email: session.email,
    name: session.name,
    imapHost: mail.imapHost,
    imapPort: mail.imapPort,
    imapSecure: mail.imapSecure,
    imapUser: session.email,
    imapPass: session.password,
    smtpHost: mail.smtpHost,
    smtpPort: mail.smtpPort,
    smtpSecure: mail.smtpSecure,
    smtpUser: session.email,
    smtpPass: session.password,
    tls: { ...mail.tls },
    sessionKey: session.key,
    isDemo: session.isDemo
  };
}

function publicAccount(session: Session) {
  return {
    handle: session.handle,
    email: session.email,
    name: session.name,
    isDemo: session.isDemo,
    rememberMe: session.remember,
    expiresAt: new Date(session.expiresAt).toISOString()
  };
}

function sendAuthError(reply: FastifyReply, status: number, code: keyof typeof AUTH_ERRORS, extra: object = {}) {
  return reply.status(status).send({ error: AUTH_ERRORS[code], code, ...extra });
}

/** preHandler: resolves the session for the requested account, or answers 401. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { sessions, config } = req.server.mailloom;
  const handle = requestedHandle(req);
  const sessionId = handle ? accountCookies(req).get(handle) : undefined;
  if (!handle || !sessionId) {
    sendAuthError(reply, 401, 'NOT_SIGNED_IN');
    return reply;
  }

  const result = sessions.resolve(sessionId);
  // Unknown (forged, signed out), expired, or a cookie whose name does not match its session.
  // Any pooled connection of a dead session is unusable (keyed by session) and idles out.
  if (
    result.status !== 'ok' ||
    result.session.handle !== handle ||
    (result.session.isDemo && !config.demoMode)
  ) {
    clearAccountCookie(req, reply, handle);
    sendAuthError(reply, 401, 'SESSION_EXPIRED');
    return reply;
  }

  sessions.touch(result.session);
  req.mailSession = result.session;
  req.accountConfig = accountConfigFor(result.session, config);
}

type LoginOutcome = 'ok' | 'bad_credentials' | 'unreachable';

async function verifyMailLogin(account: AccountConfig, log: FastifyInstance['log']): Promise<LoginOutcome> {
  const client = createImapClient(account, { connectionTimeout: 10000, greetingTimeout: 8000 });
  client.on('error', () => {
    // Handled via the connect() rejection below.
  });
  try {
    await client.connect();
    await client.logout().catch(() => undefined);
    return 'ok';
  } catch (err) {
    const e = err as { authenticationFailed?: boolean; serverResponseCode?: string; code?: string; message?: string };
    if (e.authenticationFailed || e.serverResponseCode === 'AUTHENTICATIONFAILED') {
      return 'bad_credentials';
    }
    log.warn({ code: e.code, msg: e.message }, 'IMAP login check failed (server problem)');
    return 'unreachable';
  } finally {
    client.close();
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

export async function authRoutes(fastify: FastifyInstance) {
  // 1. Sign in (creates a new server-side session for this browser)
  fastify.post('/api/auth/connect', async (req, reply) => {
    const { config, sessions, throttle } = fastify.mailloom;
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown; rememberMe?: unknown; isDemo?: unknown };
    const remember = body.rememberMe === true;

    if (body.isDemo === true) {
      if (!config.demoMode) return sendAuthError(reply, 403, 'DEMO_DISABLED');
      const { sessionId, session } = sessions.create({
        email: 'sales@poojafasteners.example',
        name: 'Ramesh Dave (Pooja Fasteners)',
        password: 'demo',
        isDemo: true,
        remember
      });
      setSessionCookie(req, reply, session, sessionId);
      return { account: publicAccount(session) };
    }

    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!EMAIL_RE.test(email) || !password || password.length > 1024) {
      return sendAuthError(reply, 400, 'INVALID_INPUT');
    }

    const retryMs = throttle.retryAfterMs(email, req.ip);
    if (retryMs > 0) {
      const minutes = Math.ceil(retryMs / 60000);
      reply.header('Retry-After', String(Math.ceil(retryMs / 1000)));
      return reply.status(429).send({
        code: 'TOO_MANY_ATTEMPTS',
        error: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
      });
    }

    const name = email.split('@')[0]!;
    const candidate: AccountConfig = accountConfigFor(
      {
        key: '',
        handle: '',
        email,
        name,
        isDemo: false,
        remember,
        createdAt: 0,
        lastUsedAt: 0,
        expiresAt: 0,
        password
      },
      config
    );
    delete candidate.sessionKey;

    const outcome = await verifyMailLogin(candidate, req.log);
    if (outcome === 'bad_credentials') {
      throttle.recordFailure(email, req.ip);
      return sendAuthError(reply, 401, 'BAD_CREDENTIALS');
    }
    if (outcome === 'unreachable') {
      return sendAuthError(reply, 503, 'MAIL_SERVER_UNREACHABLE');
    }
    throttle.recordSuccess(email, req.ip);

    // Signing in again to an account this browser already has replaces that session.
    for (const [handle, oldId] of accountCookies(req)) {
      const old = sessions.resolve(oldId);
      if (old.status === 'ok' && old.session.email.toLowerCase() === email.toLowerCase()) {
        sessions.deleteByKey(old.session.key);
        await closeSessionConnection(old.session.key);
        clearAccountCookie(req, reply, handle);
      }
    }

    const { sessionId, session } = sessions.create({ email, name, password, isDemo: false, remember });
    setSessionCookie(req, reply, session, sessionId);
    return { account: publicAccount(session) };
  });

  // 2. The account a request names (via X-Mailloom-Account)
  fastify.get('/api/auth/me', { preHandler: [requireAuth] }, async (req) => {
    return { account: publicAccount(req.mailSession!) };
  });

  // 3. All accounts signed in in this browser (valid sessions only; dead cookies are cleared)
  fastify.get('/api/auth/accounts', async (req, reply) => {
    const { sessions } = fastify.mailloom;
    const accounts = [];
    for (const [handle, sessionId] of accountCookies(req)) {
      const result = sessions.resolve(sessionId);
      if (result.status === 'ok' && result.session.handle === handle) {
        accounts.push(publicAccount(result.session));
      } else {
        clearAccountCookie(req, reply, handle);
      }
    }
    return { accounts };
  });

  // 4. Sign out of one account in this browser. Other accounts and other devices stay signed in.
  fastify.post('/api/auth/logout', async (req, reply) => {
    const { sessions } = fastify.mailloom;
    const handle = requestedHandle(req);
    if (!handle) {
      return reply.status(400).send({ code: 'NO_ACCOUNT', error: 'No account was named for sign-out.' });
    }
    const sessionId = accountCookies(req).get(handle);
    if (sessionId) {
      const result = sessions.resolve(sessionId);
      if (result.status === 'ok' && result.session.handle === handle) {
        sessions.deleteByKey(result.session.key);
        await closeSessionConnection(result.session.key);
      }
    }
    clearAccountCookie(req, reply, handle);
    // Either way, this browser no longer has a session for that account.
    return { success: true };
  });
}

function setSessionCookie(req: FastifyRequest, reply: FastifyReply, session: Session, sessionId: string) {
  const { config } = req.server.mailloom;
  reply.setCookie(cookieName(req, session.handle), sessionId, {
    ...cookieOptions(req),
    // Remember Me: persistent cookie. Otherwise a browser-session cookie (server idle timeout still applies).
    ...(session.remember ? { maxAge: Math.floor(config.sessionRememberMs / 1000) } : {})
  });
}
