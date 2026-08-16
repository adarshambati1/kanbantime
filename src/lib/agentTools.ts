import { getCard, cardsInColumn, currentSeq, push, type Field, type Todo } from './db';
import { getColumns, setColumnsSafe, setPref } from './prefs';
import { buildPlacement, type MoveInput } from './cards';
import { rankBetween } from './rank';
import type { ColumnDef } from './columns';

/**
 * The agent's tool surface — a fixed, closed set, executed server-side
 * through the same functions everything else uses (`push()`, `prefs.ts`),
 * not a parallel write path. See PLAN.md §4.1.
 *
 * Every tool here maps to exactly the actions a human could take through
 * the UI, through the same validation. There is no tool that runs raw SQL,
 * touches the filesystem, or accepts an unvalidated blob.
 */

const now = () => Date.now();
const stampAll = (fields: readonly Field[]): Partial<Record<Field, number>> =>
  Object.fromEntries(fields.map((f) => [f, now()])) as Partial<Record<Field, number>>;

export interface CardSummary {
  id: string;
  title: string;
  done: boolean;
  column: string;
  start: number | null;
  minutes: number;
}

const summarize = (t: Todo): CardSummary => ({
  id: t.id,
  title: t.title,
  done: Boolean(t.done),
  column: t.placement.column,
  start: t.placement.start,
  minutes: t.minutes,
});

export async function listCards(column?: string): Promise<CardSummary[]> {
  if (column) return (await cardsInColumn(column)).map(summarize);
  const columns = await getColumns();
  const all = await Promise.all(columns.map((c) => cardsInColumn(c.id)));
  return all.flat().map(summarize);
}

async function writeCard(
  id: string,
  base: Todo | undefined,
  patch: Partial<Pick<Todo, 'title' | 'notes' | 'done' | 'due' | 'deleted' | 'placement' | 'minutes'>>,
  fields: readonly Field[],
): Promise<Todo> {
  const ts = stampAll(fields);
  const merged = {
    id,
    title: base?.title ?? '',
    notes: base?.notes ?? '',
    done: base?.done ?? 0,
    due: base?.due ?? null,
    deleted: base?.deleted ?? 0,
    placement: base?.placement ?? { column: 'backlog', rank: 'm', start: null },
    minutes: base?.minutes ?? 30,
    ...patch,
    ts: { ...base?.ts, ...ts },
  };
  const cursor = await currentSeq();
  await push([merged], cursor);
  const written = await getCard(id);
  if (!written) throw new Error(`card ${id} vanished immediately after write`);
  return written;
}

export async function addCard(
  title: string,
  column: string,
  opts: { minutes?: number; start?: number } = {},
): Promise<CardSummary> {
  const id = crypto.randomUUID();
  const existing = await cardsInColumn(column);
  const last = existing.length > 0 ? existing[existing.length - 1]!.placement.rank : null;
  const placement = { column, rank: rankBetween(last, null), start: opts.start ?? null };
  const written = await writeCard(
    id,
    undefined,
    { title: title.trim(), placement, minutes: opts.minutes ?? 30 },
    ['title', 'notes', 'done', 'due', 'deleted', 'placement', 'minutes'],
  );
  return summarize(written);
}

export interface MoveCardArgs {
  id: string;
  column?: string;
  before?: string | null;
  after?: string | null;
  start?: number;
}

/** The only tool that can change `placement` — every entry goes through
 *  `buildPlacement()` (src/lib/cards.ts), so the transition rules PLAN.md
 *  §1.3 documents apply here exactly as they do on the client. */
export async function moveCard(args: MoveCardArgs): Promise<CardSummary | null> {
  const card = await getCard(args.id);
  if (!card || card.deleted) return null;

  const columns = await getColumns();
  const targetId = args.column ?? card.placement.column;
  const target = columns.find((c) => c.id === targetId);
  const kind: MoveInput['kind'] = target?.kind ?? 'kanban';

  const input: MoveInput = { column: targetId, kind };
  if (args.before !== undefined) input.before = args.before;
  if (args.after !== undefined) input.after = args.after;
  if (args.start !== undefined) input.start = args.start;

  const placement = buildPlacement(card.placement, input);
  const written = await writeCard(args.id, card, { placement }, ['placement']);
  return summarize(written);
}

export interface UpdateCardArgs {
  title?: string;
  notes?: string;
  done?: boolean;
  minutes?: number;
}

/** Deliberately excludes `placement` from what it can patch — same
 *  restriction as the client's `store.update()`, and for the same reason:
 *  only `moveCard()` constructs a `Placement`. */
export async function updateCard(id: string, patch: UpdateCardArgs): Promise<CardSummary | null> {
  const card = await getCard(id);
  if (!card || card.deleted) return null;

  const fields: Field[] = [];
  const write: Partial<Pick<Todo, 'title' | 'notes' | 'done' | 'minutes'>> = {};
  if (patch.title !== undefined) {
    write.title = patch.title;
    fields.push('title');
  }
  if (patch.notes !== undefined) {
    write.notes = patch.notes;
    fields.push('notes');
  }
  if (patch.done !== undefined) {
    write.done = patch.done ? 1 : 0;
    fields.push('done');
  }
  if (patch.minutes !== undefined) {
    write.minutes = patch.minutes;
    fields.push('minutes');
  }
  if (fields.length === 0) return summarize(card);

  const written = await writeCard(id, card, write, fields);
  return summarize(written);
}

export async function deleteCard(id: string): Promise<boolean> {
  const card = await getCard(id);
  if (!card || card.deleted) return false;
  await writeCard(id, card, { deleted: 1 }, ['deleted']);
  return true;
}

/** One push() call, one transaction — see PLAN.md §4.1's note on why
 *  bulk_retime routes every entry through the same moveCard() transition
 *  construction rather than a raw field patch. */
export async function bulkRetime(
  changes: { id: string; start?: number; minutes?: number; column?: string }[],
): Promise<CardSummary[]> {
  const columns = await getColumns();
  const cursor = await currentSeq();
  const items: Parameters<typeof push>[0] = [];
  const touched: string[] = [];

  for (const change of changes) {
    const card = await getCard(change.id);
    if (!card || card.deleted) continue;

    const targetId = change.column ?? card.placement.column;
    const kind = columns.find((c) => c.id === targetId)?.kind ?? 'kanban';
    const input: MoveInput = { column: targetId, kind };
    if (change.start !== undefined) input.start = change.start;
    const placement = buildPlacement(card.placement, input);

    const fields: Field[] = ['placement'];
    const patch: Partial<Pick<Todo, 'placement' | 'minutes'>> = { placement };
    if (change.minutes !== undefined) {
      patch.minutes = change.minutes;
      fields.push('minutes');
    }
    const ts = stampAll(fields);
    items.push({ ...card, ...patch, ts: { ...card.ts, ...ts } });
    touched.push(change.id);
  }

  if (items.length > 0) await push(items, cursor);
  const results = await Promise.all(touched.map((id) => getCard(id)));
  return results.filter((t): t is Todo => Boolean(t)).map(summarize);
}

export async function listColumns(): Promise<ColumnDef[]> {
  return getColumns();
}

export interface SetColumnsResult {
  ok: boolean;
  blocking?: { column: string; count: number }[];
}

export async function setColumns(columns: ColumnDef[]): Promise<SetColumnsResult> {
  const result = await setColumnsSafe(columns, now());
  return result.ok ? { ok: true } : { ok: false, blocking: result.blocking };
}

/** Only these keys — an agent shouldn't be able to invent new preference
 *  namespaces the UI never reads. */
const ALLOWED_UI_PREFS = new Set(['ui.accent', 'ui.density', 'ui.snapMinutes', 'ui.quickAddColumn']);

export async function setUiPref(key: string, value: unknown): Promise<boolean> {
  if (!ALLOWED_UI_PREFS.has(key)) return false;
  await setPref(key, value, now());
  return true;
}
