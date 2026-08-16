import * as tools from './agentTools';
import { createProposal, consumeProposal, type ProposedAction } from './agentProposals';

/**
 * The board agent — natural language over card content and board
 * presentation, through the exact tool surface documented in PLAN.md §4.1.
 *
 * Blocked on a real `OPENROUTER_API_KEY`: the previous one was pasted into
 * a chat transcript by accident and was revoked. `agentConfigured()` below
 * is the same "not wired up yet" pattern `oauthConfigured()` already uses
 * in src/lib/auth.ts — the endpoint reports it cleanly instead of the
 * request just failing opaquely once a key is added.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4.5';
const MAX_TOOL_ROUNDS = 6;
/** A turn proposing more than this many bulk_retime changes needs
 *  confirmation rather than applying immediately — PLAN.md §4.2. */
const BULK_THRESHOLD = 5;

export const agentConfigured = (): boolean => Boolean(process.env.OPENROUTER_API_KEY);

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  tool_calls?: OpenRouterToolCall[];
  name?: string;
}

interface OpenRouterToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

const SYSTEM_PROMPT = `You are the board agent for Kanban Time, a personal kanban/timetable app. You have tools to read and change the board's cards and its column configuration — nothing else. You cannot run arbitrary code or SQL.

Guidelines:
- Call list_columns or list_cards first if you need current state; don't assume.
- For scheduling to a specific time, use a "today"-kind (timetable) column and pass \`start\` as minutes since midnight (9:00am = 540).
- For moving one card, use move_card. For retiming/moving several cards at once, use bulk_retime in a single call rather than calling move_card repeatedly — it lands as one transaction and can be reviewed as one action.
- Deleting is a tombstone, not permanent — but still confirm with the user in your reply what you deleted.
- Keep replies short and concrete: what you did (or propose to do), not a narration of your reasoning.`;

const TOOL_SCHEMAS = [
  tool('list_cards', 'List cards, optionally scoped to one column.', {
    type: 'object',
    properties: { column: { type: 'string' } },
  }),
  tool('add_card', 'Create a card.', {
    type: 'object',
    properties: {
      title: { type: 'string' },
      column: { type: 'string' },
      minutes: { type: 'number', description: 'Duration in minutes, default 30' },
      start: { type: 'number', description: 'Minutes since midnight, for a timetable column' },
    },
    required: ['title', 'column'],
  }),
  tool('move_card', 'Move/reorder/retime one card. The only tool that changes placement.', {
    type: 'object',
    properties: {
      id: { type: 'string' },
      column: { type: 'string' },
      before: { type: 'string', description: 'Rank of the card it should land after' },
      after: { type: 'string', description: 'Rank of the card it should land before' },
      start: { type: 'number', description: 'Minutes since midnight, for a timetable column' },
    },
    required: ['id'],
  }),
  tool('update_card', "Edit a card's title, notes, done state, or duration — never its placement.", {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      notes: { type: 'string' },
      done: { type: 'boolean' },
      minutes: { type: 'number' },
    },
    required: ['id'],
  }),
  tool('delete_card', 'Tombstone a card.', {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  }),
  tool('list_columns', 'List the board columns.', { type: 'object', properties: {} }),
  tool('set_columns', 'Replace the board column list. Rejected if it would orphan cards.', {
    type: 'object',
    properties: {
      columns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            kind: { type: 'string', enum: ['kanban', 'timetable'] },
          },
          required: ['id', 'label', 'kind'],
        },
      },
    },
    required: ['columns'],
  }),
  tool('set_ui_pref', 'Set one board display preference.', {
    type: 'object',
    properties: { key: { type: 'string' }, value: {} },
    required: ['key', 'value'],
  }),
  tool('bulk_retime', 'Retime/move several cards in one transaction. Prefer this over repeated move_card calls.', {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            start: { type: 'number' },
            minutes: { type: 'number' },
            column: { type: 'string' },
          },
          required: ['id'],
        },
      },
    },
    required: ['changes'],
  }),
];

function tool(name: string, description: string, parameters: unknown) {
  return { type: 'function' as const, function: { name, description, parameters } };
}

export interface PendingProposal {
  id: string;
  actions: { description: string }[];
  expiresInSeconds: number;
}

export interface AgentTurnResult {
  reply: string;
  proposal?: PendingProposal;
}

async function callOpenRouter(messages: ChatMessage[]): Promise<{
  content: string | null;
  tool_calls?: OpenRouterToolCall[];
}> {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOL_SCHEMAS }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    choices: { message: { content: string | null; tool_calls?: OpenRouterToolCall[] } }[];
  };
  const msg = body.choices[0]?.message;
  if (!msg) throw new Error('OpenRouter returned no message');
  return msg;
}

/** Executes one tool call. Returns either a plain result (already applied)
 *  or a `needsConfirmation` marker when the call was bulky enough to
 *  require a proposal instead — see PLAN.md §4.2. */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown } | { needsConfirmation: ProposedAction[] }> {
  switch (name) {
    case 'list_cards':
      return { result: await tools.listCards(args.column as string | undefined) };

    case 'add_card':
      return {
        result: await tools.addCard(String(args.title), String(args.column), {
          ...(typeof args.minutes === 'number' ? { minutes: args.minutes } : {}),
          ...(typeof args.start === 'number' ? { start: args.start } : {}),
        }),
      };

    case 'move_card':
      return {
        result: await tools.moveCard({
          id: String(args.id),
          ...(typeof args.column === 'string' ? { column: args.column } : {}),
          ...(typeof args.before === 'string' ? { before: args.before } : {}),
          ...(typeof args.after === 'string' ? { after: args.after } : {}),
          ...(typeof args.start === 'number' ? { start: args.start } : {}),
        }),
      };

    case 'update_card':
      return {
        result: await tools.updateCard(String(args.id), {
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
          ...(typeof args.notes === 'string' ? { notes: args.notes } : {}),
          ...(typeof args.done === 'boolean' ? { done: args.done } : {}),
          ...(typeof args.minutes === 'number' ? { minutes: args.minutes } : {}),
        }),
      };

    case 'delete_card':
      return { result: await tools.deleteCard(String(args.id)) };

    case 'list_columns':
      return { result: await tools.listColumns() };

    case 'set_columns':
      return { result: await tools.setColumns(args.columns as never) };

    case 'set_ui_pref':
      return { result: await tools.setUiPref(String(args.key), args.value) };

    case 'bulk_retime': {
      const changes = (args.changes as { id: string; start?: number; minutes?: number; column?: string }[]) ?? [];
      if (changes.length > BULK_THRESHOLD) {
        const cards = await tools.listCards();
        const byId = new Map(cards.map((c) => [c.id, c]));
        return {
          needsConfirmation: [
            {
              tool: 'bulk_retime',
              args: { changes },
              description: `Retime ${changes.length} cards: ${changes
                .map((c) => byId.get(c.id)?.title ?? c.id)
                .join(', ')}`,
            },
          ],
        };
      }
      return { result: await tools.bulkRetime(changes) };
    }

    default:
      return { result: { error: `unknown tool ${name}` } };
  }
}

async function applyProposedAction(action: ProposedAction): Promise<unknown> {
  switch (action.tool) {
    case 'move_card':
      return tools.moveCard(action.args);
    case 'delete_card':
      return tools.deleteCard(action.args.id);
    case 'bulk_retime':
      return tools.bulkRetime(action.args.changes);
    case 'set_columns':
      return tools.setColumns(action.args.columns as never);
  }
}

export async function runAgentTurn(message: string, history: ChatMessage[]): Promise<AgentTurnResult> {
  if (!agentConfigured()) {
    throw new Error('OPENROUTER_API_KEY is not set — the agent is not configured yet.');
  }

  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: message }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { content, tool_calls } = await callOpenRouter(messages);

    if (!tool_calls || tool_calls.length === 0) {
      return { reply: content ?? '' };
    }

    messages.push({ role: 'assistant', content: content ?? '', tool_calls });

    for (const call of tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* leave args empty — the tool call will just no-op / report unknown fields */
      }

      const outcome = await executeTool(call.function.name, args);

      if ('needsConfirmation' in outcome) {
        const proposal = await createProposal(outcome.needsConfirmation);
        return {
          reply: outcome.needsConfirmation.map((a) => a.description).join('\n'),
          proposal: {
            id: proposal.id,
            actions: outcome.needsConfirmation.map((a) => ({ description: a.description })),
            expiresInSeconds: Math.round((proposal.expiresAt - proposal.createdAt) / 1000),
          },
        };
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(outcome.result),
      });
    }
  }

  return { reply: "That took more steps than I'm allowed in one turn — try breaking it into smaller requests." };
}

export interface ConfirmResult {
  applied: { description: string }[];
  skipped: { description: string; reason: string }[];
}

export type ConfirmOutcome = { ok: true; result: ConfirmResult } | { ok: false; reason: 'not_found' | 'already_applied' | 'expired' };

/**
 * Applies a previously-proposed batch. Re-validated per action, not
 * all-or-nothing — an action whose target changed since the proposal was
 * made is skipped and reported, not silently applied against stale intent
 * or treated as a fatal error for the rest of the batch (PLAN.md §4.2).
 */
export async function confirmProposal(id: string): Promise<ConfirmOutcome> {
  const claimed = await consumeProposal(id);
  if (!claimed.ok) return { ok: false, reason: claimed.reason };

  const applied: { description: string }[] = [];
  const skipped: { description: string; reason: string }[] = [];

  for (const action of claimed.proposal.actions) {
    try {
      const result = await applyProposedAction(action);
      if (result === null || result === false) {
        skipped.push({ description: action.description, reason: 'target no longer exists' });
      } else {
        applied.push({ description: action.description });
      }
    } catch (err) {
      skipped.push({ description: action.description, reason: err instanceof Error ? err.message : 'failed' });
    }
  }

  return { ok: true, result: { applied, skipped } };
}
