# Notes, Memory, and MCP — the "everything app" module

A second content type alongside `Todo`: freeform notes/ideas, searchable by
folder, date, full text, and (later) meaning — browsable as a calendar
heatmap, editable from a small in-app editor or from Claude via MCP, and
optionally publishable, with the personal site (adarshambati.com) reduced to
a thin preview-and-link layer over whatever's marked public here.

Status: **plan only.** Written from the decisions made in conversation:
full-text + folder + date search now, semantic search as a fast-follow once
an embeddings key exists (Turso/libSQL has native vector search — `F32_BLOB`
columns, `vector_top_k()`, DiskANN indexing — so this never needs a new
database, only a provider to turn text into vectors); the existing auth
model is enough (no field-level encryption); calendar/heatmap for the visual
view; "forget" is a soft delete/tombstone, same as todos; the site drops its
own Notes/Thoughts tabs and pages entirely, replaced by homepage preview
blocks fed from a public feed the app exposes — public content only, never
private, enforced at the query level not by convention.

---

## 1. Data model: `Note`

A note is not a task — separate table, own sync channel, same underlying
patterns (field-level LWW, monotonic `seq` cursor, tombstone deletes) the
todo sync already uses, because those patterns are what makes any of this
safe across devices, not something specific to todos.

```ts
interface Note {
  id: string;
  title: string;
  body: string;           // markdown
  folder: string;         // e.g. "robotics" — default "general"
  visibility: 'private' | 'public';
  deleted: number;
  ts: Partial<Record<Field, number>>;
  seq: number;
}
const FIELDS = ['title', 'body', 'folder', 'visibility', 'deleted'] as const;
```

Own `notes` table, own `idx_notes_seq`, own `/api/notes/sync` — not folded
into the todo sync endpoint, since it's a different shape of resource with
different fields; sharing a cursor/protocol with todos would just be two
unrelated things pretending to be one.

### 1.1 The publish lock

**"You can't change a public note unless you make it private first"** —
enforced as a write-time check in the one function that patches a note
(`updateNote()`, server-side, called by both the in-app editor and the MCP
tool — one place, like `moveCard()`/`buildPlacement()` already is for
placement):

> If the note's *current* `visibility` is `'public'`, any write that changes
> `title`, `body`, or `folder` is rejected **unless that same write also
> sets `visibility: 'private'`.** Unpublish-and-edit in one call is fine;
> unpublish, then edit, in two calls is also fine. What's not allowed is a
> content change landing while the note stays public.

This is a real rejection (like `setColumnsSafe()`'s blocking-card-count
rejection), not a soft merge — it's a deliberate business rule, not the
sync protocol's own offline-resilience guarantee, so "always accept and
merge" doesn't apply here the way it does to the todo sync path.

---

## 2. Search — composable primitives, not one fuzzy box

Matches "like grep agents... explore it" from conversation: a human and an
agent both get the same small set of tools and compose them, rather than
one opaque "smart search" endpoint deciding what you meant.

- `listNotes(folder?)` — plain listing, newest first.
- `notesByDate(from, to)` — date-range filter.
- `grepNotes(query, { folder?, from?, to? })` — full-text, via SQLite
  FTS5. A `notes_fts` virtual table mirrors `title`/`body`, kept in sync
  inside the same write path `updateNote()`/`createNote()` already goes
  through — not a separate reindex job that can drift.
- `notesByFolder(folder)` — same as `listNotes(folder)`, kept as its own
  named tool since it's a distinct mental action ("show me the X folder")
  even though the implementation is trivial.

### 2.1 Fast-follow: semantic search

Deferred until an embeddings provider key exists (same shape of blocker as
`OPENROUTER_API_KEY` — don't double up on two unresolved external keys at
once). When it does:

- `notes.embedding F32_BLOB` column, populated by calling the embeddings
  provider inside `createNote()`/`updateNote()` (re-embed on content change,
  not on `folder`/`visibility`-only edits).
- `libsql_vector_idx` over that column; `semanticSearchNotes(query)` embeds
  the query the same way and calls `vector_top_k()`.
- No new database, no new infra — same Turso instance, one new column and
  one index.

---

## 3. Visual view: calendar / heatmap

A month grid, each day shaded by note count that day (quiet — reuse
`--color-*` tokens, no new palette, matching §7's design constraints from
`PLAN.md`), click a day to see that day's notes. Navigable month-to-month.
Folder filter as a plain text control above the grid, same visual language
as the board's tray toggle.

---

## 4. Mini editor

**In-app**: title field, a markdown textarea, a folder picker (existing
folder or type a new one — no separate "create folder" step, matching how
kanban columns work), a visibility toggle, save. Attempting to save a
content change to a public note surfaces the lock rule directly (disable
the fields, one line: "unpublish to edit," a single button that does both).

**MCP** (see §6): `create_note`, `update_note` (same lock rule, enforced
server-side either way — the in-app editor isn't a special path with looser
rules than the tool a client can call), `forget_note`.

---

## 5. Public routes and the site feed

New **unauthenticated** routes on the app's own domain — the one deliberate
carve-out in a deployment where "everything is gated" has been the rule
since the app existed:

- `GET /public` — list of public notes, essay-style previews.
- `GET /public/:id` — single "public essay view": clean typography, no
  board chrome, closer to the site's existing `Prose` component than to
  anything else in this app. (The two repos already duplicate the design
  token file on purpose — this view duplicates the *typographic* pattern
  the same deliberate way, not by sharing code across repos.)
- `GET /api/public/feed?limit=N&type=notes` — JSON, for the site to fetch:
  `{ title, summary, url, date }[]`, newest first.

**Hard invariant, not a convention**: every one of these routes' queries
filters `WHERE visibility = 'public' AND deleted = 0` *at the SQL level* —
there is no code path where a private note is ever loaded into memory for a
public-route response and then filtered out afterward. A smoke test asserts
this directly: create a private note, hit `/api/public/feed`, assert its
title never appears in the response body at all — not just "isn't rendered."

Middleware: `/public` and `/api/public` get an explicit exemption from the
"everything is gated" rule (the login/OAuth routes are the only other
exemption today) — not a missing check, a stated one, so it reads as a
decision if someone else (or a future agent) touches `middleware.ts` later.

---

## 6. MCP server

A small local process (stdio transport — the standard shape for Claude
Code/Desktop) that makes authenticated HTTPS calls to the deployed app.
Lives in this repo, `mcp-server/`, versioned alongside the API it calls.

**Auth**: a new `MCP_TOKEN`, not a reuse of `SHORTCUTS_TOKEN` — same reason
that token is already split from the session cookie: independently
revocable, lives in a different plaintext location (your Claude config)
than either Shortcuts or a browser session.

**New REST endpoints** the MCP process actually calls (`/api/mcp/*`,
bearer-gated on `MCP_TOKEN` specifically — not the general session/Shortcuts
credential, so revoking Claude's access doesn't touch your phone or your
browser): the MCP server is a thin client over these, not a second copy of
the write logic — the endpoints call the same `agentTools.ts`/`notesTools.ts`
functions the in-app agent already uses.

| Tool | Maps to |
| --- | --- |
| `list_cards` / `add_card` / `move_card` / `update_card` / `delete_card` | existing `agentTools.ts`, reused as-is |
| `list_notes` / `notes_by_date` / `notes_by_folder` / `grep_notes` | §2 |
| `read_note(id)` | full note by id |
| `create_note` / `update_note` (lock rule applies) / `forget_note` | §1.1, §4 |
| `publish_note(id)` / `unpublish_note(id)` | sugar over `update_note`'s `visibility`, kept as separate tools since "publish this" is a distinct action from "edit this," same reasoning as `notesByFolder` above |

---

## 7. Site changes

- Remove the site's own `notes`/`thoughts` content collections, pages, and
  nav links entirely — undoes today's earlier "Notes on Interests"/"Thoughts"
  build on the site side, in favor of the app owning that content instead of
  two content pipelines existing in parallel.
- Homepage keeps its highlight-block *shape* (a few recent items + "view
  all →"), but the data comes from `GET /api/public/feed` (fetched at
  request time, since the site is server-rendered per-page already, not a
  fully static build) instead of `astro:content`. "View all" and each
  item link out to the app's `/public`/`/public/:id`.
- Nav: `Projects` (unchanged, anchors the homepage), a single `Notes` link
  replacing both `Notes on Interests` and `Thoughts`, pointing straight at
  the app's `/public` — the site no longer distinguishes "notes" from
  "thoughts" as a category; that distinction, if it still matters, becomes
  a `folder` in the app instead of two separate site sections.

---

## 8. Rollout order

1. `Note` data model, its own sync endpoint, FTS5 + folder + date search,
   a minimal list UI and the in-app mini editor (no calendar yet, no
   publishing yet) — get the core read/write/search loop solid and tested
   before layering visibility and MCP on top of it.
2. Calendar/heatmap view.
3. Visibility + the publish lock + public routes + the feed endpoint,
   including the private-note-never-leaks smoke test.
4. Site changes — remove the site's own content, wire the homepage to the
   feed. Done after §3 exists, not before, so there's something real to
   link to.
5. MCP server: the `/api/mcp/*` endpoints, then the actual stdio process.
6. Fast-follow, whenever an embeddings key exists: semantic search (§2.1).

Each step keeps the existing `npm test`/`npm run verify` green, plus new
smoke coverage for whatever that step added, before moving to the next —
same discipline `PLAN.md`'s rollout used.
