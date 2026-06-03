/**
 * Pool de conexão Postgres do mandato.
 *
 * Como roda dentro do compose Supabase no Easypanel, conecta direto via
 * loopback do container db-1 — sem TLS, sem latência de rede pública.
 *
 * As envs vêm do compose Supabase (POSTGRES_HOST, POSTGRES_PASSWORD etc.)
 * — herdadas via env_file no docker-compose.
 */

import pg from 'pg';

const { Pool } = pg;

const POSTGRES_HOST = process.env.POSTGRES_HOST ?? 'db';
const POSTGRES_PORT = Number(process.env.POSTGRES_PORT ?? 5432);
const POSTGRES_USER = process.env.POSTGRES_MCP_USER ?? 'supabase_admin';
const POSTGRES_PASSWORD =
  process.env.POSTGRES_MCP_PASSWORD ?? process.env.POSTGRES_PASSWORD;
const POSTGRES_DB = process.env.POSTGRES_DB ?? 'postgres';

if (!POSTGRES_PASSWORD) {
  throw new Error(
    '[mcp/db] POSTGRES_PASSWORD ausente. Configure POSTGRES_MCP_PASSWORD ou ' +
      'herde POSTGRES_PASSWORD do compose Supabase via env_file.',
  );
}

export const pool = new Pool({
  host: POSTGRES_HOST,
  port: POSTGRES_PORT,
  user: POSTGRES_USER,
  password: POSTGRES_PASSWORD,
  database: POSTGRES_DB,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'joaocury-mcp',
});

pool.on('error', (err: Error) => {
  console.error('[mcp/db] erro inesperado no pool:', err);
});

/**
 * Wrapper de query que retorna rows + metadata estruturada.
 */
export async function executeQuery(sql: string, params: unknown[] = []) {
  const start = Date.now();
  const res = await pool.query(sql, params as any[]);
  const elapsedMs = Date.now() - start;

  return {
    rows: res.rows,
    rowCount: res.rowCount ?? 0,
    command: res.command,
    fields:
      res.fields?.map((f: { name: string; dataTypeID: number }) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
      })) ?? [],
    elapsedMs,
  };
}

/**
 * Executa SQL dentro de transação e faz ROLLBACK no fim — útil pra dry-run de
 * mutações destrutivas (vê quantas linhas seriam afetadas sem persistir).
 */
export async function executeDryRun(sql: string, params: unknown[] = []) {
  const client = await pool.connect();
  const start = Date.now();
  try {
    await client.query('BEGIN');
    const res = await client.query(sql, params as any[]);
    await client.query('ROLLBACK');
    return {
      dryRun: true,
      rows: res.rows,
      rowCount: res.rowCount ?? 0,
      command: res.command,
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
