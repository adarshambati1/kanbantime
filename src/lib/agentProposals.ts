import { db } from './db';

/**
 * Server-persisted, single-use proposals for bulky agent actions — never a
 * client-trusted action list. See PLAN.md §4.2.
 *
 * The client only ever holds a proposal `id`. Confirming re-reads the
 * server's own stored actions (never anything the client sends), atomically
 * flips `pending` to `consumed` before applying anything (closing the
 * replay gap — resending the same id after confirmation is a no-op, not a
 * second application), and re-checks each action's precondition against
 * current state so a card that changed between propose and confirm is
 * skipped, not silently applied against stale intent.
 */

export type ProposedActionKind =
  | { tool: 'move_card'; args: { id: string; column?: string; before?: string | null; after?: string | null; start?: number } }
  | { tool: 'delete_card'; args: { id: string } }
  | { tool: 'bulk_retime'; args: { changes: { id: string; start?: number; minutes?: number; column?: string }[] } }
  | { tool: 'set_columns'; args: { columns: unknown[] } };

/** `& { description }` distributes over the union, so each variant keeps
 *  its own `tool`/`args` shape — an `interface ... extends` here wouldn't
 *  compile against a union. */
export type ProposedAction = ProposedActionKind & {
  /** Human-readable, for the review screen — "Move 'ship the board' to Doing". */
  description: string;
};

export type ProposalStatus = 'pending' | 'consumed' | 'expired';

export interface Proposal {
  id: string;
  actions: ProposedAction[];
  status: ProposalStatus;
  createdAt: number;
  expiresAt: number;
}

const TTL_MS = 60_000;

type Row = Record<string, unknown>;

function hydrate(row: Row): Proposal {
  return {
    id: String(row.id),
    actions: JSON.parse(String(row.actions)),
    status: String(row.status) as ProposalStatus,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

export async function createProposal(actions: ProposedAction[]): Promise<Proposal> {
  const c = await db();
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + TTL_MS;
  await c.execute({
    sql: `INSERT INTO agent_proposals (id, actions, status, created_at, expires_at)
          VALUES (?, ?, 'pending', ?, ?)`,
    args: [id, JSON.stringify(actions), createdAt, expiresAt],
  });
  return { id, actions, status: 'pending', createdAt, expiresAt };
}

export async function getProposal(id: string): Promise<Proposal | null> {
  const c = await db();
  const res = await c.execute({ sql: `SELECT * FROM agent_proposals WHERE id = ?`, args: [id] });
  const row = res.rows[0] as unknown as Row | undefined;
  return row ? hydrate(row) : null;
}

export type ConsumeResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: 'not_found' | 'already_applied' | 'expired' };

/**
 * Atomically claims a proposal for confirmation. The status check and the
 * flip to `consumed` happen in one transaction, so two near-simultaneous
 * confirm calls (a double-tap, a retried request) can't both apply it —
 * exactly one wins the flip, the other sees `already_applied`.
 */
export async function consumeProposal(id: string): Promise<ConsumeResult> {
  const c = await db();
  const tx = await c.transaction('write');
  try {
    const res = await tx.execute({ sql: `SELECT * FROM agent_proposals WHERE id = ?`, args: [id] });
    const row = res.rows[0] as unknown as Row | undefined;
    if (!row) {
      await tx.rollback();
      return { ok: false, reason: 'not_found' };
    }
    const proposal = hydrate(row);
    if (proposal.status === 'consumed') {
      await tx.rollback();
      return { ok: false, reason: 'already_applied' };
    }
    if (proposal.status === 'expired' || Date.now() >= proposal.expiresAt) {
      await tx.execute({ sql: `UPDATE agent_proposals SET status = 'expired' WHERE id = ?`, args: [id] });
      await tx.commit();
      return { ok: false, reason: 'expired' };
    }

    await tx.execute({ sql: `UPDATE agent_proposals SET status = 'consumed' WHERE id = ?`, args: [id] });
    await tx.commit();
    return { ok: true, proposal: { ...proposal, status: 'consumed' } };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}
