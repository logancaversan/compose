/**
 * Middleware de autenticação Bearer token.
 *
 * Compara header `Authorization: Bearer <token>` contra MCP_AUTH_TOKEN da env
 * usando comparação constant-time pra evitar timing attack.
 *
 * Multi-token: se MCP_AUTH_TOKEN tiver vírgulas, aceita qualquer um (suporta
 * rotação sem downtime — gera novo, adiciona como segundo, depois remove o
 * antigo).
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const RAW = process.env.MCP_AUTH_TOKEN ?? '';
const TOKENS = RAW.split(',').map((t) => t.trim()).filter(Boolean);

if (TOKENS.length === 0) {
  throw new Error(
    '[mcp/auth] MCP_AUTH_TOKEN ausente. Gere com `openssl rand -hex 32` e ' +
      'configure no compose Supabase. Pra rotação sem downtime, configure como ' +
      '"novo_token,antigo_token" (separados por vírgula).',
  );
}

// Pré-computa buffers pra comparação constant-time
const TOKEN_BUFS = TOKENS.map((t) => Buffer.from(t, 'utf8'));

export function validateAuth(req: IncomingMessage): { ok: boolean; reason?: string } {
  const header = req.headers['authorization'];
  if (!header || typeof header !== 'string') {
    return { ok: false, reason: 'header Authorization ausente' };
  }
  const m = header.match(/^Bearer\s+(.+)$/);
  if (!m) {
    return { ok: false, reason: 'header Authorization mal formado (esperado Bearer)' };
  }
  const presented = Buffer.from(m[1], 'utf8');

  for (const expected of TOKEN_BUFS) {
    if (presented.length !== expected.length) continue;
    if (timingSafeEqual(presented, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'token inválido' };
}
