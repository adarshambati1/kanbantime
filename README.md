# Kanban Time

Personal todos for the engineer: half Jira, half timetable. A private,
local-first app. One user, offline-capable, synced across
devices, with Siri and share-sheet access through iOS Shortcuts.

Deploys to `todo.adarshambati.com`. Split out of
[adarshambati.com](https://github.com/adarshambati1/adarshambati.com), the
personal site it used to live inside — they share a design token file but
deploy independently.

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

37 checks: route gating, the OAuth handshake, the sync protocol, field-level
merge, tombstones, the board fields, the Siri endpoints and PWA wiring. The
Google round-trip itself isn't covered — it needs a real browser and account.

## The board model

Every card carries `column`, `rank` and `minutes` alongside the usual fields,
and all three sync with the same per-field merge as everything else.

`rank` is a **fractional index** — a short string sorted lexicographically, with
inserts finding a value between two neighbours. See `src/lib/rank.ts`. The
reason is the sync model: with integer positions, dragging one card renumbers
every card below it, which is a dozen conflicting writes for one gesture. A
fractional rank makes a reorder exactly one field on one row, so two devices
reordering different cards merge cleanly instead of fighting.

`npm run test:rank` property-tests it: 500 appends, 300 inserts into a single
gap, 200 prepends, all asserted to sort strictly where intended.

Known characteristic, documented rather than hidden: repeatedly inserting into
the *same* gap grows the string about a character per insert. Real reordering
spreads out, so it doesn't bite in practice, and re-seeding a column with
`initialRanks()` resets it.

## The board model, continued

`column`, `rank`, and `start` (the timetable's clock position) aren't three
independent fields — they're one, `placement`, merged as a whole. Independent
per-field merge let a concurrent kanban move and a concurrent timetable
retime recombine into a card neither device produced (the moved-to column
with the pre-move start time survived a merge test built specifically to
catch this — see the `placement is one field, not three` section of
`scripts/smoke.sh`). A move is one gesture; it gets one timestamp.
`src/lib/cards.ts`'s `buildPlacement()` is the only place a `Placement` gets
constructed, so no other write path — including a future `update_card`
patch — can bypass the transition rules and reopen that bug.

Full design, written across three rounds of independent review (data-model
correctness, daily-use interaction design, visual consistency with the rest
of the site), lives in `PLAN.md`.

## Still to build

- **Timetable** — the `today` column currently renders as a plain stack, same
  as the kanban columns (Phase 2 of `PLAN.md`'s rollout order). Phase 3 gives
  it its own axis: a vertical day view reading `placement.start`, drag to
  retime, resize to change `minutes`, an unscheduled tray for cards not yet
  placed on the clock.
- **Agent** — natural language over the board, and over the board's own
  presentation (`prefs`, columns). Routes through the same `cards.ts`
  transition layer the UI uses, not a parallel path. Needs a new OpenRouter
  key — the previous one was pasted into a chat transcript by accident and
  was revoked; it must never be reused.
- Web push for due reminders. The installed-PWA plumbing is already there.
- Rate limiting on the OAuth callback.
