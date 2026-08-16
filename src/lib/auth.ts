import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/**
 * Single-user auth via Google OAuth, with an email allowlist.
 *
 * There is no user table and no signup. Exactly one address is allowed in, and
 * anyone else who completes a Google login is rejected at the callback. Google
 * owns the credential, so this repo never handles a password.
 *
 * Shortcuts can't perform an OAuth flow, so the Siri endpoints keep a separate
 * bearer token. That separation is deliberate: the token lives in plaintext in
 * an iCloud-synced shortcut, and must be revocable without touching the session.
 */

const YEAR = 365 * 24 * 60 * 60;
export const COOKIE = 'sid';
export const STATE_COOKIE = 'oauth_state';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';

const secret = () => process.env.AUTH_SECRET || '';
const clientId = () => process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET || '';

/** Comma-separated, so a second address can be added without a code change. */
export const allowedEmails = (): string[] =>
  (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export const isAllowed = (email: string): boolean =>
  allowedEmails().includes(email.trim().toLowerCase());

export const oauthConfigured = (): boolean =>
  Boolean(clientId() && clientSecret() && secret() && allowedEmails().length);

const sign = (data: string) => createHmac('sha256', secret()).update(data).digest('base64url');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* ---------- session ---------- */

export function issueSession(email: string): { value: string; maxAge: number } {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + YEAR * 1000 })).toString(
    'base64url',
  );
  return { value: `${payload}.${sign(payload)}`, maxAge: YEAR };
}

/** Returns the signed-in email, or null. Re-checks the allowlist on every read
 *  so removing an address takes effect immediately rather than at expiry. */
export function readSession(token: string | undefined): string | null {
  if (!token || !secret()) return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac || !safeEqual(mac, sign(payload))) return null;
  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof exp !== 'number' || exp <= Date.now()) return null;
    if (typeof email !== 'string' || !isAllowed(email)) return null;
    return email;
  } catch {
    return null;
  }
}

/* ---------- oauth ---------- */

export const newState = () => randomBytes(16).toString('base64url');

export function authUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state,
    // Ask every time rather than silently reusing a session — this is a
    // single-user app and picking the wrong Google account is the likely error.
    prompt: 'select_account',
  });
  return `${AUTHORIZE}?${params}`;
}

interface IdTokenClaims {
  email?: string;
  email_verified?: boolean | string;
  aud?: string;
  exp?: number;
}

/**
 * Exchange the authorization code for an ID token and return its claims.
 *
 * The token comes straight from Google's endpoint over TLS in a server-to-server
 * call authenticated with the client secret, so the signature doesn't need
 * separate verification — but the audience and expiry still do.
 */
export async function exchangeCode(code: string, redirectUri: string): Promise<IdTokenClaims | null> {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) return null;
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) return null;

  const payload = body.id_token.split('.')[1];
  if (!payload) return null;

  let claims: IdTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }

  if (claims.aud !== clientId()) return null;
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return null;
  if (claims.email_verified !== true && claims.email_verified !== 'true') return null;
  if (!claims.email) return null;

  return claims;
}

/* ---------- shortcuts bearer ---------- */

export function checkBearer(header: string | null): boolean {
  const expected = process.env.SHORTCUTS_TOKEN || '';
  if (!expected || !header?.startsWith('Bearer ')) return false;
  return safeEqual(header.slice(7).trim(), expected);
}

export type Credential = 'cookie' | 'bearer' | null;

/**
 * Which credential the request presented, not just whether it had one.
 *
 * The caller needs the distinction for CSRF: browsers attach cookies to
 * cross-site requests automatically, so cookie-authenticated writes need an
 * origin check. A bearer token is never attached automatically, so requiring an
 * Origin header there would only break non-browser clients like Shortcuts.
 */
export function authorize(request: Request, cookie: string | undefined): Credential {
  if (checkBearer(request.headers.get('authorization'))) return 'bearer';
  if (readSession(cookie)) return 'cookie';
  return null;
}

/** Same-origin check for state-changing requests that rely on the cookie. */
export function sameOrigin(request: Request, expected: string): boolean {
  const origin = request.headers.get('origin');
  // Absent Origin on a same-origin GET is normal; callers only use this for
  // non-GET, where every current browser sends it.
  if (!origin) return false;
  try {
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}
