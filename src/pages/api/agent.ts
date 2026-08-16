import type { APIRoute } from 'astro';
import { COOKIE, readSession } from '../../lib/auth';
import { runAgentTurn, confirmProposal, agentConfigured, type ChatMessage } from '../../lib/agent';
import { allow } from '../../lib/rateLimit';

export const prerender = false;

/**
 * Cookie-only, deliberately — this is a chat-style feature, not a Siri one,
 * and the Shortcuts bearer token has no business calling an LLM. Middleware
 * already gates this route generically (either credential passes); this is
 * the extra check that specifically excludes bearer.
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  const email = readSession(cookies.get(COOKIE)?.value);
  if (!email) return json({ error: 'unauthorized' }, 401);

  if (!agentConfigured()) {
    return json({ error: 'not configured', message: 'The agent needs an OPENROUTER_API_KEY — see the README.' }, 503);
  }

  if (!allow('agent', 20, 60_000)) {
    return json({ error: 'rate limited', message: 'Too many requests — try again in a moment.' }, 429);
  }

  let body: { message?: string; history?: ChatMessage[]; confirmProposalId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  try {
    if (typeof body.confirmProposalId === 'string') {
      const outcome = await confirmProposal(body.confirmProposalId);
      if (!outcome.ok) return json({ error: outcome.reason }, outcome.reason === 'not_found' ? 404 : 409);
      return json(outcome.result);
    }

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return json({ error: 'empty message' }, 400);
    const history = Array.isArray(body.history) ? body.history : [];

    const result = await runAgentTurn(message, history);
    return json(result);
  } catch (err) {
    console.error('agent turn failed', err);
    return json({ error: 'agent failed' }, 500);
  }
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
