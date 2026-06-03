/**
 * Detecção de SQL destrutivo.
 *
 * Filosofia: bloquear destrutivo PRA VALER por default. Pra rodar, exige
 * `confirm_destructive: true` explícito no input da tool.
 *
 * Anti-padrões detectados:
 *  1. DROP TABLE / SCHEMA / DATABASE
 *  2. TRUNCATE
 *  3. DELETE sem WHERE (apaga tabela inteira)
 *  4. UPDATE sem WHERE (atualiza tabela inteira)
 *  5. ALTER TABLE ... DROP COLUMN
 *  6. ALTER TABLE ... DROP CONSTRAINT
 *  7. GRANT/REVOKE em massa
 *
 * Por que apenas regex e não AST? Porque pg-query-parser tem dependências
 * nativas pesadas. Pra ambiente single-tenant com 1 usuário (Logan), regex
 * é suficiente. Se virar multi-tenant, evoluir.
 */

const NORMALIZE = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, ' ') // remove comentários linha
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // remove comentários bloco
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

interface DestructiveCheck {
  destructive: boolean;
  reason?: string;
  /** Estimativa rude do impacto: 'baixo' | 'medio' | 'alto' | 'catastrofico' */
  severidade?: 'baixo' | 'medio' | 'alto' | 'catastrofico';
}

export function isDestructive(rawSql: string): DestructiveCheck {
  const sql = NORMALIZE(rawSql);

  // Catastrófico
  if (/\bDROP\s+(TABLE|SCHEMA|DATABASE|VIEW|FUNCTION|TYPE|EXTENSION|TRIGGER|MATERIALIZED\s+VIEW)\b/.test(sql)) {
    return {
      destructive: true,
      reason: 'DROP detectado (apaga estrutura)',
      severidade: 'catastrofico',
    };
  }
  if (/\bTRUNCATE\b/.test(sql)) {
    return {
      destructive: true,
      reason: 'TRUNCATE detectado (apaga todos os dados da tabela)',
      severidade: 'catastrofico',
    };
  }

  // Alto
  if (/\bDELETE\s+FROM\s+\S+/.test(sql) && !/\bWHERE\b/.test(sql)) {
    return {
      destructive: true,
      reason: 'DELETE sem WHERE (apaga TODAS as linhas)',
      severidade: 'catastrofico',
    };
  }
  if (/\bUPDATE\s+\S+\s+SET\b/.test(sql) && !/\bWHERE\b/.test(sql)) {
    return {
      destructive: true,
      reason: 'UPDATE sem WHERE (atualiza TODAS as linhas)',
      severidade: 'alto',
    };
  }
  if (/\bALTER\s+TABLE\s+\S+\s+DROP\s+(COLUMN|CONSTRAINT)\b/.test(sql)) {
    return {
      destructive: true,
      reason: 'ALTER TABLE DROP COLUMN/CONSTRAINT',
      severidade: 'alto',
    };
  }

  // Médio
  if (/\b(GRANT|REVOKE)\b/.test(sql)) {
    return {
      destructive: true,
      reason: 'GRANT/REVOKE de permissões',
      severidade: 'medio',
    };
  }

  return { destructive: false };
}

/**
 * Detecta se a SQL é puramente SELECT (read-only) — tools `query` só aceitam isso.
 */
export function isReadOnly(rawSql: string): boolean {
  const sql = NORMALIZE(rawSql);
  // Permite: SELECT, WITH ... SELECT, SHOW, EXPLAIN.
  // Bloqueia: INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, GRANT, REVOKE,
  //           TRUNCATE, CALL (procedure), DO ($$).
  if (/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|GRANT|REVOKE|TRUNCATE|CALL|DO|COPY|VACUUM|REINDEX|CLUSTER)\b/.test(sql)) {
    return false;
  }
  // Aceita SELECT, WITH, SHOW, EXPLAIN
  return /^(SELECT|WITH|SHOW|EXPLAIN|TABLE|VALUES)\b/.test(sql);
}
