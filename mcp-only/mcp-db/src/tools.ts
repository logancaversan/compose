/**
 * Definição das tools expostas pelo MCP joaocury-db.
 *
 * Convenções:
 *  - Toda tool retorna JSON serializável (não Buffer, não Date — sempre ISO string).
 *  - Toda mutação destrutiva exige `confirm_destructive: true`.
 *  - Toda escrita é loggada em stdout (Easypanel captura via container logs).
 */

import { z } from 'zod';
import { executeDryRun, executeQuery } from './db.js';
import { isDestructive, isReadOnly } from './guardrails.js';

const MAX_ROWS = 1000;

/**
 * Whitelist de identificadores SQL — só letras, dígitos e underscore,
 * começando por letra ou underscore. Bloqueia injection em interpolação de
 * nome de tabela/schema/function que o pg client não consegue parameterizar.
 *
 * Postgres permite identificadores quoted com mais chars, mas como contrato
 * do MCP só aceitamos os "limpos" — força quem chama a usar nomes
 * convencionais. Caso edge (tabela com hífen, espaço, acento) → usar `query`
 * raw que aceita SQL completo.
 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(name: string, kind: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(
      `${kind} inválido: "${name}". Aceitamos apenas [A-Za-z_][A-Za-z0-9_]* — ` +
        'pra nomes especiais, use `query` ou `mutate` com SQL completo.',
    );
  }
}

// ─── Schemas ────────────────────────────────────────────────────────────────

export const QueryInput = z.object({
  sql: z.string().describe('SQL SELECT/SHOW/EXPLAIN/WITH read-only. Outros tipos rejeitados.'),
  params: z.array(z.unknown()).optional().describe('Parâmetros posicionais ($1, $2…) — sempre preferir sobre interpolação manual.'),
  limit: z.number().int().positive().max(MAX_ROWS).optional().describe(`Trunca o resultado a N linhas (default 200, max ${MAX_ROWS}). Evita estouro de contexto.`),
});

export const MutateInput = z.object({
  sql: z.string().describe('SQL INSERT/UPDATE/DELETE. Operações destrutivas em massa exigem confirm_destructive=true.'),
  params: z.array(z.unknown()).optional(),
  dry_run: z.boolean().optional().describe('Default true. Se true, executa em transação e faz ROLLBACK no fim — retorna rowCount estimado sem persistir. Se false, persiste.'),
  confirm_destructive: z.boolean().optional().describe('Default false. Necessário true pra rodar DROP/TRUNCATE/DELETE sem WHERE/UPDATE sem WHERE/etc.'),
});

export const SchemaInput = z.object({
  table: z.string().describe('Nome da tabela (sem schema). Schema default = public.'),
  schema: z.string().optional().describe('Schema. Default public.'),
});

export const ListTablesInput = z.object({
  schema: z.string().optional().describe('Schema. Default public.'),
  pattern: z.string().optional().describe('LIKE pattern, ex: emenda% — opcional.'),
});

export const ListFunctionsInput = z.object({
  schema: z.string().optional().describe('Schema. Default public.'),
  pattern: z.string().optional(),
});

export const ListBucketsInput = z.object({});

export const StorageListInput = z.object({
  bucket: z.string().describe('Nome do bucket Storage.'),
  prefix: z.string().optional().describe('Path prefix opcional, ex: "botucatu-pinacoteca/".'),
  limit: z.number().int().positive().max(500).optional().describe('Default 100, máx 500.'),
});

export const StorageGetUrlInput = z.object({
  bucket: z.string(),
  path: z.string().describe('Path completo do objeto dentro do bucket.'),
  expires_seconds: z
    .number()
    .int()
    .positive()
    .max(86400)
    .optional()
    .describe('TTL da URL assinada. Default 300s (5min), máx 86400 (24h).'),
});

export const InvokeFunctionInput = z.object({
  name: z.string().describe('Nome da edge function (sem prefixo /functions/v1/).'),
  payload: z.record(z.unknown()).optional().describe('Body JSON enviado pra função.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(280_000)
    .optional()
    .describe('Timeout em ms. Default 30s, máx 280s (perto do edge-runtime workerTimeout de 300s).'),
});

export const SearchContentInput = z.object({
  q: z.string().min(2).describe('Texto pra buscar (case-insensitive, com unaccent).'),
  tables: z
    .array(z.enum(['publicacoes', 'news_articles', 'site_pages', 'proposals', 'emendas']))
    .optional()
    .describe('Restringir a quais tabelas. Default: todas.'),
  status_publicada_apenas: z.boolean().optional().describe('Se true, filtra só publicado/ativo.'),
  limit: z.number().int().positive().max(50).optional().describe('Default 10 por tabela, máx 50.'),
});

export const RecentChangesInput = z.object({
  table: z.string().optional().describe('Restringir a uma tabela específica. Default: agrega todas com updated_at.'),
  since_minutes: z.number().int().positive().max(10080).optional().describe('Janela. Default 60min, máx 7 dias.'),
  limit: z.number().int().positive().max(200).optional().describe('Default 50, máx 200.'),
});

export const StatsDashboardInput = z.object({
  domain: z.enum([
    'emendas',
    'conquistas',
    'apoiadores',
    'diabetes',
    'portal',
    'comunicacao',
    'terceiro_setor',
    'storage',
  ]).describe('Qual painel agregado retornar.'),
});

export const CallRpcInput = z.object({
  function_name: z.string().describe('Nome da função (público.<nome>).'),
  args: z.record(z.unknown()).optional().describe('Mapa nome→valor dos parâmetros nomeados.'),
});

export const CountInput = z.object({
  table: z.string(),
  schema: z.string().optional(),
  where: z.string().optional().describe('Cláusula WHERE sem o "WHERE" — ex.: "status=\'publicada\' AND publicada_em > now() - interval \'30 days\'"'),
});

// ─── Implementações ────────────────────────────────────────────────────────

export async function query(input: z.infer<typeof QueryInput>) {
  if (!isReadOnly(input.sql)) {
    throw new Error('query() só aceita SELECT/SHOW/EXPLAIN/WITH. Use mutate() pra escrita.');
  }
  const limit = input.limit ?? 200;
  const hadOwnLimit = /\bLIMIT\s+\d+/i.test(input.sql);
  const limited = hadOwnLimit
    ? input.sql
    : `${input.sql.replace(/;\s*$/, '')} LIMIT ${limit}`;
  const result = await executeQuery(limited, input.params ?? []);
  // `at_max_limit` é honesto: bateu o teto que NÓS impusemos (não conta o
  // LIMIT explícito do usuário). Quem chama decide se quer paginação extra.
  return {
    rowCount: result.rowCount,
    rows: result.rows,
    at_max_limit: !hadOwnLimit && result.rows.length === limit,
    fields: result.fields.map((f: { name: string }) => f.name),
    elapsedMs: result.elapsedMs,
  };
}

export async function mutate(input: z.infer<typeof MutateInput>) {
  const dryRun = input.dry_run ?? true;
  const check = isDestructive(input.sql);

  if (check.destructive && !input.confirm_destructive) {
    return {
      blocked: true,
      reason: check.reason,
      severidade: check.severidade,
      hint: 'Operação destrutiva. Rode com `confirm_destructive: true` se for intencional. Recomenda-se rodar com `dry_run: true` antes pra ver o impacto.',
    };
  }

  if (dryRun) {
    const result = await executeDryRun(input.sql, input.params ?? []);
    return {
      dryRun: true,
      destructive: check.destructive,
      severidade: check.severidade,
      rowCount: result.rowCount,
      command: result.command,
      elapsedMs: result.elapsedMs,
      hint: 'ROLLBACK aplicado. Rode novamente com `dry_run: false` pra persistir.',
    };
  }

  const result = await executeQuery(input.sql, input.params ?? []);
  console.log(`[mcp/mutate] command=${result.command} rowCount=${result.rowCount} destructive=${check.destructive}`);
  return {
    dryRun: false,
    destructive: check.destructive,
    severidade: check.severidade,
    rowCount: result.rowCount,
    command: result.command,
    elapsedMs: result.elapsedMs,
  };
}

export async function schema(input: z.infer<typeof SchemaInput>) {
  const schemaName = input.schema ?? 'public';
  const cols = await executeQuery(
    `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length, udt_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schemaName, input.table],
  );
  const idx = await executeQuery(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
    [schemaName, input.table],
  );
  const fks = await executeQuery(
    `SELECT
       tc.constraint_name, kcu.column_name,
       ccu.table_schema AS referenced_schema, ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'`,
    [schemaName, input.table],
  );
  const policies = await executeQuery(
    `SELECT policyname, permissive, roles, cmd, qual::text, with_check::text
     FROM pg_policies WHERE schemaname = $1 AND tablename = $2`,
    [schemaName, input.table],
  );

  return {
    schema: schemaName,
    table: input.table,
    columns: cols.rows,
    indexes: idx.rows,
    foreignKeys: fks.rows,
    policies: policies.rows,
  };
}

export async function listTables(input: z.infer<typeof ListTablesInput>) {
  const schemaName = input.schema ?? 'public';
  const pattern = input.pattern ?? '%';
  const result = await executeQuery(
    `SELECT
       t.table_name,
       pg_size_pretty(pg_total_relation_size(format('%I.%I', t.table_schema, t.table_name)::regclass)) AS size,
       (SELECT reltuples::bigint FROM pg_class WHERE oid = format('%I.%I', t.table_schema, t.table_name)::regclass) AS rows_estimated
     FROM information_schema.tables t
     WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE' AND t.table_name LIKE $2
     ORDER BY t.table_name`,
    [schemaName, pattern],
  );
  return { schema: schemaName, tables: result.rows };
}

export async function listFunctions(input: z.infer<typeof ListFunctionsInput>) {
  const schemaName = input.schema ?? 'public';
  const pattern = input.pattern ?? '%';
  const result = await executeQuery(
    `SELECT
       p.proname AS function_name,
       pg_get_function_arguments(p.oid) AS arguments,
       pg_get_function_result(p.oid) AS returns,
       l.lanname AS language,
       p.prosrc IS NOT NULL AS has_source
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_language l ON l.oid = p.prolang
     WHERE n.nspname = $1 AND p.proname LIKE $2
     ORDER BY p.proname`,
    [schemaName, pattern],
  );
  return { schema: schemaName, functions: result.rows };
}

export async function listBuckets(_input: z.infer<typeof ListBucketsInput>) {
  const result = await executeQuery(
    `SELECT id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at
     FROM storage.buckets
     ORDER BY name`,
  );
  return { buckets: result.rows };
}

export async function callRpc(input: z.infer<typeof CallRpcInput>) {
  assertIdent(input.function_name, 'function_name');
  const args = input.args ?? {};
  const argNames = Object.keys(args);
  for (const n of argNames) assertIdent(n, 'argumento nomeado');
  const argList = argNames.map((name, i) => `${name} := $${i + 1}`).join(', ');
  const values = argNames.map((name) => args[name]);
  const sql = `SELECT * FROM public.${input.function_name}(${argList})`;
  const result = await executeQuery(sql, values);
  return {
    function: input.function_name,
    rowCount: result.rowCount,
    rows: result.rows,
    elapsedMs: result.elapsedMs,
  };
}

export async function count(input: z.infer<typeof CountInput>) {
  const schemaName = input.schema ?? 'public';
  assertIdent(schemaName, 'schema');
  assertIdent(input.table, 'table');
  // input.where é SQL livre por design (cláusula WHERE precisa de operadores).
  // Quem chama o MCP é Claude — assumimos boa fé. Pra hardening futuro,
  // poderíamos parsear via libpg_query, mas é overkill agora.
  const sql = `SELECT count(*)::int AS count FROM ${schemaName}.${input.table}${input.where ? ` WHERE ${input.where}` : ''}`;
  const result = await executeQuery(sql);
  return { schema: schemaName, table: input.table, count: result.rows[0]?.count ?? 0 };
}

// ─── v0.2 — Storage / Functions / Search / Audit / Dashboards ─────────────

export async function storageList(input: z.infer<typeof StorageListInput>) {
  const limit = input.limit ?? 100;
  const prefix = input.prefix ?? '';
  const result = await executeQuery(
    `SELECT
       o.name,
       o.bucket_id,
       (o.metadata->>'size')::bigint AS size_bytes,
       o.metadata->>'mimetype' AS mime_type,
       o.updated_at,
       o.created_at,
       o.last_accessed_at
     FROM storage.objects o
     WHERE o.bucket_id = $1 AND o.name LIKE $2
     ORDER BY o.updated_at DESC
     LIMIT $3`,
    [input.bucket, `${prefix}%`, limit],
  );
  const total = await executeQuery(
    `SELECT count(*)::int AS total, sum((metadata->>'size')::bigint)::bigint AS total_bytes
     FROM storage.objects WHERE bucket_id = $1 AND name LIKE $2`,
    [input.bucket, `${prefix}%`],
  );
  return {
    bucket: input.bucket,
    prefix,
    total: total.rows[0]?.total ?? 0,
    total_bytes: total.rows[0]?.total_bytes ?? 0,
    truncated: result.rows.length === limit,
    objects: result.rows,
  };
}

export async function storageGetUrl(input: z.infer<typeof StorageGetUrlInput>) {
  const ttl = input.expires_seconds ?? 300;

  // Verificar se o bucket é público — se for, retorna URL direta.
  const bucketInfo = await executeQuery(
    `SELECT public FROM storage.buckets WHERE id = $1`,
    [input.bucket],
  );
  if (bucketInfo.rows.length === 0) {
    return { error: `bucket "${input.bucket}" não existe`, url: null };
  }
  const isPublic = bucketInfo.rows[0]?.public === true;
  const SUPABASE_URL = process.env.SUPABASE_INTERNAL_URL ?? 'http://kong:8000';
  const PUBLIC_URL = process.env.SUPABASE_PUBLIC_URL ?? 'https://api.joaocury.com.br';

  if (isPublic) {
    return {
      bucket: input.bucket,
      path: input.path,
      public: true,
      url: `${PUBLIC_URL}/storage/v1/object/public/${input.bucket}/${input.path}`,
      expires_in: null,
      hint: 'Bucket é público — URL direta sem expiração.',
    };
  }

  // Bucket privado — chamar o storage API pra gerar signed URL.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return {
      error: 'SUPABASE_SERVICE_ROLE_KEY ausente — não consigo gerar signed URL pra bucket privado',
      url: null,
    };
  }
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${input.bucket}/${input.path}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ expiresIn: ttl }),
    },
  );
  if (!res.ok) {
    return { error: `storage api retornou ${res.status}`, url: null };
  }
  const data = (await res.json()) as { signedURL?: string };
  return {
    bucket: input.bucket,
    path: input.path,
    public: false,
    url: data.signedURL ? `${PUBLIC_URL}${data.signedURL}` : null,
    expires_in: ttl,
  };
}

export async function invokeFunction(input: z.infer<typeof InvokeFunctionInput>) {
  const timeout = input.timeout_ms ?? 30_000;
  const FUNCTIONS_URL = process.env.SUPABASE_FUNCTIONS_URL ?? 'http://kong:8000/functions/v1';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!serviceKey && !anonKey) {
    return { error: 'nenhuma key configurada (SUPABASE_SERVICE_ROLE_KEY ou SUPABASE_ANON_KEY)' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const start = Date.now();
  try {
    const res = await fetch(`${FUNCTIONS_URL}/${input.name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceKey ?? anonKey}`,
        apikey: serviceKey ?? anonKey ?? '',
      },
      body: JSON.stringify(input.payload ?? {}),
      signal: ctrl.signal,
    });
    const elapsedMs = Date.now() - start;
    const contentType = res.headers.get('content-type') ?? '';
    let body: unknown;
    if (contentType.includes('application/json')) {
      body = await res.json();
    } else {
      body = (await res.text()).slice(0, 5000);
    }
    return {
      function: input.name,
      status: res.status,
      ok: res.ok,
      elapsedMs,
      response: body,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      function: input.name,
      error: msg,
      elapsedMs: Date.now() - start,
      aborted: ctrl.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface SearchMatch {
  table: string;
  id: string;
  slug?: string;
  title: string;
  snippet: string;
  status?: string;
  updated_at?: string;
}

export async function searchContent(input: z.infer<typeof SearchContentInput>) {
  const limit = input.limit ?? 10;
  const tables = input.tables ?? ['publicacoes', 'news_articles', 'site_pages', 'proposals', 'emendas'];
  const matches: SearchMatch[] = [];
  const skipped: Array<{ table: string; reason: string }> = [];
  const q = `%${input.q}%`;

  for (const t of tables) {
    let sql = '';
    if (t === 'publicacoes') {
      sql = `SELECT id::text, slug, titulo AS title,
               left(coalesce(resumo, corpo_md, ''), 200) AS snippet,
               status::text, updated_at
             FROM public.publicacoes
             WHERE (titulo ILIKE $1 OR subtitulo ILIKE $1 OR resumo ILIKE $1 OR corpo_md ILIKE $1)
               ${input.status_publicada_apenas ? "AND status='publicada'" : ''}
             ORDER BY updated_at DESC LIMIT $2`;
    } else if (t === 'news_articles') {
      sql = `SELECT id::text, slug, title,
               left(coalesce(subtitle, content, ''), 200) AS snippet,
               status, updated_at
             FROM public.news_articles
             WHERE (title ILIKE $1 OR subtitle ILIKE $1 OR content ILIKE $1)
               ${input.status_publicada_apenas ? "AND status IN ('published','publicada')" : ''}
             ORDER BY updated_at DESC LIMIT $2`;
    } else if (t === 'site_pages') {
      sql = `SELECT id::text, slug, title,
               left(coalesce(content_html, content_md, ''), 200) AS snippet,
               status::text, updated_at
             FROM public.site_pages
             WHERE (title ILIKE $1 OR content_html ILIKE $1 OR content_md ILIKE $1)
             ORDER BY updated_at DESC LIMIT $2`;
    } else if (t === 'proposals') {
      sql = `SELECT id::text, slug, titulo AS title,
               left(coalesce(descricao,''), 200) AS snippet,
               status::text, updated_at
             FROM public.proposals
             WHERE (titulo ILIKE $1 OR descricao ILIKE $1)
             ORDER BY updated_at DESC LIMIT $2`;
    } else if (t === 'emendas') {
      sql = `SELECT id::text, null::text AS slug, titulo AS title,
               left(coalesce(descricao,''), 200) AS snippet,
               status::text, updated_at
             FROM public.emendas
             WHERE (titulo ILIKE $1 OR descricao ILIKE $1 OR municipio_nome ILIKE $1)
             ORDER BY updated_at DESC LIMIT $2`;
    }
    if (!sql) continue;
    try {
      const r = await executeQuery(sql, [q, limit]);
      for (const row of r.rows as any[]) {
        matches.push({
          table: t,
          id: row.id,
          slug: row.slug ?? undefined,
          title: row.title,
          snippet: row.snippet,
          status: row.status ?? undefined,
          updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
        });
      }
    } catch (err) {
      // Tabela pode não existir nesse mandato (fork sem o módulo).
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[mcp/search] tabela ${t} pulada: ${reason}`);
      skipped.push({ table: t, reason });
    }
  }
  return { q: input.q, tables, skipped, total: matches.length, matches };
}

export async function recentChanges(input: z.infer<typeof RecentChangesInput>) {
  const minutes = input.since_minutes ?? 60;
  const limit = input.limit ?? 50;

  if (input.table) {
    assertIdent(input.table, 'table');
    const r = await executeQuery(
      `SELECT * FROM public.${input.table}
       WHERE updated_at >= now() - make_interval(mins => $1)
       ORDER BY updated_at DESC LIMIT $2`,
      [minutes, limit],
    );
    return { table: input.table, since_minutes: minutes, total: r.rowCount, rows: r.rows };
  }

  // Agregar por tabela — só tabelas que têm updated_at
  const tables = await executeQuery(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema='public' AND column_name='updated_at'
     ORDER BY table_name`,
  );
  const summary: Array<{ table: string; changed: number }> = [];
  for (const row of tables.rows as Array<{ table_name: string }>) {
    // Defense-in-depth: nomes vêm do schema, mas validamos antes de interpolar.
    if (!IDENT_RE.test(row.table_name)) continue;
    try {
      const r = await executeQuery(
        `SELECT count(*)::int AS n FROM public.${row.table_name}
         WHERE updated_at >= now() - make_interval(mins => $1)`,
        [minutes],
      );
      const n = r.rows[0]?.n ?? 0;
      if (n > 0) summary.push({ table: row.table_name, changed: n });
    } catch {
      /* tabela inacessível, pula */
    }
  }
  summary.sort((a, b) => b.changed - a.changed);
  return {
    since_minutes: minutes,
    total_tables_touched: summary.length,
    summary: summary.slice(0, limit),
  };
}

export async function statsDashboard(input: z.infer<typeof StatsDashboardInput>) {
  switch (input.domain) {
    case 'emendas': {
      const total = await executeQuery(
        `SELECT count(*)::int AS total,
           round(sum(valor_solicitado)/1000000,1) AS solicitado_mi,
           round(sum(valor_empenhado)/1000000,1) AS empenhado_mi,
           round(sum(valor_pago)/1000000,1) AS pago_mi
         FROM public.emendas`,
      );
      const porStatus = await executeQuery(
        `SELECT status::text AS status, count(*)::int AS n
         FROM public.emendas GROUP BY status ORDER BY n DESC`,
      );
      const topMunicipios = await executeQuery(
        `SELECT municipio_nome, count(*)::int AS n,
                round(sum(valor_solicitado)/1000000,1) AS solicitado_mi
         FROM public.emendas WHERE municipio_nome IS NOT NULL
         GROUP BY municipio_nome ORDER BY n DESC LIMIT 10`,
      );
      return {
        domain: 'emendas',
        totais: total.rows[0],
        por_status: porStatus.rows,
        top_municipios: topMunicipios.rows,
      };
    }

    case 'conquistas': {
      const total = await executeQuery(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE status='publicada')::int AS publicadas,
           count(*) FILTER (WHERE status='rascunho')::int AS rascunhos,
           count(*) FILTER (WHERE capa_url IS NULL OR capa_url='')::int AS sem_capa,
           count(*) FILTER (WHERE capa_url ILIKE '%camara.leg.br%')::int AS capa_placeholder_camara,
           count(*) FILTER (WHERE corpo_md IS NULL OR length(trim(corpo_md)) < 100)::int AS sem_corpo
         FROM public.publicacoes`,
      );
      const porCategoria = await executeQuery(
        `SELECT coalesce(c.nome,'(sem categoria)') AS categoria, count(*)::int AS n
         FROM public.publicacoes p
         LEFT JOIN public.categorias c ON c.id = p.categoria_principal_id
         WHERE p.status='publicada'
         GROUP BY c.nome ORDER BY n DESC LIMIT 15`,
      );
      return { domain: 'conquistas', totais: total.rows[0], por_categoria: porCategoria.rows };
    }

    case 'apoiadores': {
      const total = await executeQuery(
        `SELECT count(*)::int AS total FROM public.supporters`,
      );
      return { domain: 'apoiadores', totais: total.rows[0] };
    }

    case 'diabetes': {
      // Trilhas / inscrições — depende do schema do módulo trilhas.
      const inscritos = await executeQuery(
        `SELECT count(*)::int AS total FROM public.contact_messages WHERE assunto ILIKE '%diabetes%' OR mensagem ILIKE '%diabetes%'`,
      ).catch(() => ({ rows: [{ total: null }] }) as any);
      return {
        domain: 'diabetes',
        leads_via_contato: inscritos.rows[0]?.total ?? null,
        nota: 'Métricas detalhadas do funnel Diabetes dependem das tabelas de trilhas — adicionar quando schema estabilizar.',
      };
    }

    case 'portal': {
      const recent = await executeQuery(
        `SELECT count(*)::int AS n
         FROM public.publicacoes
         WHERE status='publicada' AND publicada_em >= now() - interval '30 days'`,
      );
      const totalPub = await executeQuery(
        `SELECT count(*)::int AS n FROM public.publicacoes WHERE status='publicada'`,
      );
      return {
        domain: 'portal',
        publicacoes_publicadas: totalPub.rows[0]?.n,
        publicadas_ultimos_30d: recent.rows[0]?.n,
      };
    }

    case 'comunicacao': {
      const inboxes = await executeQuery(
        `SELECT 'contact_messages' AS fila, count(*)::int AS n
         FROM public.contact_messages
         WHERE created_at >= now() - interval '30 days'`,
      );
      return { domain: 'comunicacao', filas: inboxes.rows };
    }

    case 'terceiro_setor': {
      // Tabelas do módulo podem não estar criadas em todos os forks.
      // Parênteses obrigatórios — AND binda mais que OR.
      const exists = await executeQuery(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='public'
           AND (table_name LIKE 'terceiro_setor_%' OR table_name = 'entidades')`,
      );
      return {
        domain: 'terceiro_setor',
        tabelas_encontradas: exists.rows.map((r: any) => r.table_name),
        nota: exists.rowCount === 0 ? 'Módulo 3º Setor não está provisionado neste mandato.' : undefined,
      };
    }

    case 'storage': {
      const buckets = await executeQuery(
        `SELECT b.id AS bucket, b.public,
                count(o.*)::int AS objects,
                coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint AS total_bytes
         FROM storage.buckets b
         LEFT JOIN storage.objects o ON o.bucket_id = b.id
         GROUP BY b.id, b.public ORDER BY total_bytes DESC`,
      );
      return { domain: 'storage', buckets: buckets.rows };
    }

    default: {
      // Exhaustiveness check — se um novo domain for adicionado no Zod, TS
      // pega aqui no compile-time.
      const _exhaustive: never = input.domain;
      throw new Error(`domain não suportado: ${String(_exhaustive)}`);
    }
  }
}
