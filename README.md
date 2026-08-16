# todo.adarshambati.com

A private, local-first todo app. One user, offline-capable, synced across
devices, with Siri and share-sheet access through iOS Shortcuts.

Split out of [adarshambati.com](https://github.com/adarshambati1/adarshambati.com),
which is the personal site it used to live inside. They share a design token
file but deploy independently.

## Why it's built this way

The binding constraint was a **corporate laptop**: no app installs, browser
only. That forces web-first, and once you're web-first every other platform is a
thin shell over the same app rather than a separate client to keep in sync.

| Device | What runs |
| --- | --- |
| Corporate laptop | A browser tab. No install, nothing to approve. |
| iPhone / iPad | The PWA on the home screen, plus Shortcuts for Siri, share sheet and Apple Watch. |
| Personal Mac | Safari → File → Add to Dock. |

## Local-first

The UI reads only from IndexedDB and never awaits the network. Offline isn't a
mode, it's sync not having run yet.

**Sync.** Every row carries a server-assigned monotonic `seq`. A client
remembers the highest it has seen and asks for everything above it — a change
token, not a timestamp cursor, so there's no dependence on device clocks for
ordering and no boundary bug when two records share a millisecond.

Clocks are still used, but only for conflict resolution and **per field**.
Checking a box on your phone while editing the same task's title on your laptop
merges cleanly; per-record last-write-wins would discard one of the two.

Deletes are tombstones. A hard delete is invisible to a device that was offline
when it happened.

```
POST /api/sync   { cursor, changes[] }  ->  { cursor, changes[], more }
```

The response carries the post-merge version of the caller's own writes, so
clients converge without special-casing. `more` means the server paged the
result and the client should ask again — pulls are capped, and advancing the
cursor past what was actually sent would skip rows permanently.

## Auth

Google OAuth with an email allowlist. No signup, no password, no user table —
exactly the addresses in `ALLOWED_EMAILS` get in, and the allowlist is
re-checked on every request, so removing one takes effect immediately rather
than at session expiry.

The point isn't hiding a todo list from a determined attacker. It's that an
unauthenticated app is an open write endpoint on the internet, and Certificate
Transparency logs get scraped within minutes of a cert issuing.

Two credentials, deliberately separate:

- **Session cookie** — browsers. Signed, `HttpOnly`, `SameSite=Lax`, one year.
  Writes additionally require a matching `Origin`, because browsers attach
  cookies to cross-site requests whether you meant it or not.
- **Bearer token** (`SHORTCUTS_TOKEN`) — iOS Shortcuts, which can't perform an
  OAuth flow. Exempt from the origin check, since non-browser clients don't send
  `Origin` at all. Separate from the session because it sits in plaintext inside
  an iCloud-synced shortcut and must be rotatable on its own.

Astro's built-in `checkOrigin` is disabled in `astro.config.mjs` because it
rejects *every* non-GET without an `Origin`, which would break Shortcuts. The
equivalent check is reimplemented in `src/middleware.ts`, applied only where
it's load-bearing.

## Siri, share sheet and Apple Watch

A PWA can't register with Siri — App Intents is native-only. Shortcuts bridges
it by calling the API directly, so Apple Reminders is never involved.

**"What's on my list"** — Get Contents of URL → `GET /api/list?format=text` with
header `Authorization: Bearer <SHORTCUTS_TOKEN>` → Speak Text. Siri invokes any
shortcut by its name.

**"Add to my list"** — Ask for Input → `POST /api/quick-add`, same header, body
is the dictated text. Accepts raw text or `{"title": "..."}`.

Enable "receive input from share sheet" on the second one for share-to-todo.
Shortcuts runs on watchOS, so both work from your wrist.

## Running it

```bash
npm install
cp .env.example .env   # fill in, see below
npm run dev            # http://localhost:4322
npm test               # in another terminal
```

`tsconfig.json` extends `astro/tsconfigs/strictest` with
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. `npm run verify`
must report 0 errors.

## Environment

In production these live in the Vercel dashboard, never in a file.

| Variable | What it's for |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client, from Google Cloud Console |
| `ALLOWED_EMAILS` | Comma-separated allowlist |
| `AUTH_SECRET` | Signs the session cookie (`openssl rand -hex 32`) |
| `SHORTCUTS_TOKEN` | Bearer token for Siri (`openssl rand -hex 32`) |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Blank locally — falls back to a SQLite file in `data/` |

Authorised OAuth redirect URIs must include
`http://localhost:4322/api/auth/callback` and
`https://todo.adarshambati.com/api/auth/callback`.

## Deploying

Vercel. Storage is libSQL rather than a local SQLite file because Vercel's
filesystem is ephemeral — the same client speaks to a local file in development
and Turso in production, so there's one code path.

## Design

`src/styles/index.css` is a deliberate copy of the same file in the site repo,
so the two stay visually identical. It's ~250 lines that change rarely; a shared
npm package for one person would be more ceremony than the problem deserves. If
you retune the site's tokens, copy them here.

## Testing

```bash
npm run dev   # one terminal
npm test      # another
```

33 checks: route gating, the OAuth handshake, the sync protocol, field-level
merge, tombstones, the Siri endpoints and PWA wiring. The Google round-trip
itself isn't covered — it needs a real browser and account.

## Next

- **Board** — kanban columns. Needs `column` and `rank` on each todo, which
  touches the schema, the sync protocol and both merge functions. Use fractional
  ranks, not integer indices: with per-field last-write-wins, integer positions
  make one drag rewrite every row below it.
- **Timetable** — the last column laid out from a start time, draggable and
  resizable. Needs `duration` and `startAt`.
- **Agent** — natural language over the board, driving the same API the UI does
  rather than a parallel path.
- Web push for due reminders. The installed-PWA plumbing is already there.
- Rate limiting on the OAuth callback.
