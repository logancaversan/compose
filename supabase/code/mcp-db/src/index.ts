/**
 * MCP joaocury-db — entry point.
 *
 * Roda como container Easypanel, expõe HTTP via Kong (api.joaocury.com.br/mcp).
 * Transporte: Streamable HTTP (POST + SSE) do SDK MCP — moderno, ideal pra
 * MCP remoto autenticado.
 *
 * Autenticação: Bearer token via header Authorization.
 *
 * Logs: stdout (Easypanel captura). Sem PII, sem service_role exposto.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  CallRpcInput,
  CountInput,
  InvokeFunctionInput,
  ListBucketsInput,
  ListFunctionsInput,
  ListTablesInput,
  MutateInput,
  QueryInput,
  RecentChangesInput,
  SchemaInput,
  SearchContentInput,
  StatsDashboardInput,
  StorageGetUrlInput,
  StorageListInput,
  callRpc,
  count,
  invokeFunction,
  listBuckets,
  listFunctions,
  listTables,
  mutate,
  query,
  recentChanges,
  schema,
  searchContent,
  statsDashboard,
  storageGetUrl,
  storageList,
} from './tools.js';
import { validateAuth } from './auth.js';
import { executeQuery } from './db.js';

const PORT = Number(process.env.MCP_PORT ?? 8080);
const SERVER_VERSION = '0.2.0';

// ─── MCP Server ────────────────────────────────────────────────────────────

function createMcpServer() {
  const server = new Server(
    { name: 'joaocury-db', version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'query',
        description:
          'SELECT read-only no Postgres do mandato. Retorna até 200 linhas por default (configurável até 1000). Use `params` posicionais ($1, $2) sempre que possível.',
        inputSchema: zodToJson(QueryInput),
      },
      {
        name: 'mutate',
        description:
          'INSERT/UPDATE/DELETE. Default é dry_run=true (executa em transação e faz ROLLBACK — retorna rowCount sem persistir). Pra persistir: dry_run=false. Operações destrutivas (DROP, TRUNCATE, DELETE/UPDATE sem WHERE) exigem confirm_destructive=true.',
        inputSchema: zodToJson(MutateInput),
      },
      {
        name: 'schema',
        description:
          'Retorna estrutura completa de uma tabela: colunas (tipo, nullable, default), índices, foreign keys, RLS policies. Equivalente ao \\d do psql.',
        inputSchema: zodToJson(SchemaInput),
      },
      {
        name: 'list_tables',
        description:
          'Lista tabelas de um schema com tamanho e estimativa de linhas. Suporta pattern LIKE.',
        inputSchema: zodToJson(ListTablesInput),
      },
      {
        name: 'list_functions',
        description:
          'Lista funções/procedures de um schema (útil pra encontrar RPCs do PostgREST). Suporta pattern LIKE.',
        inputSchema: zodToJson(ListFunctionsInput),
      },
      {
        name: 'list_buckets',
        description: 'Lista buckets do Supabase Storage com config (público?, limite, mime types).',
        inputSchema: zodToJson(ListBucketsInput),
      },
      {
        name: 'call_rpc',
        description:
          'Chama uma função Postgres com argumentos nomeados. Equivalente ao supabase.rpc().',
        inputSchema: zodToJson(CallRpcInput),
      },
      {
        name: 'count',
        description: 'Conta linhas de uma tabela com WHERE opcional. Atalho pra `SELECT count(*) FROM x WHERE …`.',
        inputSchema: zodToJson(CountInput),
      },
      {
        name: 'storage_list',
        description:
          'Lista arquivos de um bucket Supabase Storage com path/size/mime/datas. Suporta prefix LIKE. Default 100, max 500.',
        inputSchema: zodToJson(StorageListInput),
      },
      {
        name: 'storage_get_url',
        description:
          'Gera URL pra inspecionar arquivo do Storage. Bucket público retorna URL direta; privado retorna URL assinada (default TTL 5min, max 24h).',
        inputSchema: zodToJson(StorageGetUrlInput),
      },
      {
        name: 'invoke_function',
        description:
          'Chama edge function do Supabase por nome (sem prefixo /functions/v1/). Use pra disparar gerar-narrativa, transcribe-audio, run-seo-audit, generate-release, gerar-imagem-publicacao, etc. Lista de functions disponíveis em supabase/functions/.',
        inputSchema: zodToJson(InvokeFunctionInput),
      },
      {
        name: 'search_content',
        description:
          'Busca textual cross-table (publicacoes, news_articles, site_pages, proposals, emendas) com ILIKE em campos de título/subtítulo/resumo/corpo. Retorna até N matches por tabela.',
        inputSchema: zodToJson(SearchContentInput),
      },
      {
        name: 'recent_changes',
        description:
          'Auditoria simples: o que mudou nas últimas N horas/minutos. Sem `table`: agregado por tabela (resumo). Com `table`: lista as linhas mudadas.',
        inputSchema: zodToJson(RecentChangesInput),
      },
      {
        name: 'stats_dashboard',
        description:
          'Painel agregado pronto por domínio: emendas, conquistas, apoiadores, diabetes, portal, comunicacao, terceiro_setor, storage.',
        inputSchema: zodToJson(StatsDashboardInput),
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const { name, arguments: args } = req.params;
    try {
      let result: unknown;
      switch (name) {
        case 'query':
          result = await query(QueryInput.parse(args));
          break;
        case 'mutate':
          result = await mutate(MutateInput.parse(args));
          break;
        case 'schema':
          result = await schema(SchemaInput.parse(args));
          break;
        case 'list_tables':
          result = await listTables(ListTablesInput.parse(args));
          break;
        case 'list_functions':
          result = await listFunctions(ListFunctionsInput.parse(args));
          break;
        case 'list_buckets':
          result = await listBuckets(ListBucketsInput.parse(args));
          break;
        case 'call_rpc':
          result = await callRpc(CallRpcInput.parse(args));
          break;
        case 'count':
          result = await count(CountInput.parse(args));
          break;
        case 'storage_list':
          result = await storageList(StorageListInput.parse(args));
          break;
        case 'storage_get_url':
          result = await storageGetUrl(StorageGetUrlInput.parse(args));
          break;
        case 'invoke_function':
          result = await invokeFunction(InvokeFunctionInput.parse(args));
          break;
        case 'search_content':
          result = await searchContent(SearchContentInput.parse(args));
          break;
        case 'recent_changes':
          result = await recentChanges(RecentChangesInput.parse(args));
          break;
        case 'stats_dashboard':
          result = await statsDashboard(StatsDashboardInput.parse(args));
          break;
        default:
          throw new Error(`tool desconhecida: ${name}`);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, jsonReplacer, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mcp/tool ${name}] erro:`, msg);
      return {
        isError: true,
        content: [{ type: 'text', text: `Erro em ${name}: ${msg}` }],
      };
    }
  });

  return server;
}

// Converte ISO strings de Date, BigInt em string
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<buffer ${value.length} bytes>`;
  return value;
}

// Converte Zod schemas para JSON Schema simples (suficiente pro MCP)
function zodToJson(schema: any): Record<string, unknown> {
  // Implementação minimalista: o SDK valida o input contra Zod separadamente.
  // O inputSchema declarado aqui é só pra metadata do client.
  const shape = schema._def?.shape?.() ?? {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape) as Array<[string, any]>) {
    const isOptional = value._def?.typeName === 'ZodOptional';
    const inner = isOptional ? value._def.innerType : value;
    properties[key] = zodFieldToJson(inner);
    if (!isOptional) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function zodFieldToJson(zod: any): Record<string, unknown> {
  const typeName = zod._def?.typeName;
  const description = zod._def?.description;
  const base: Record<string, unknown> = description ? { description } : {};
  switch (typeName) {
    case 'ZodString':
      return { ...base, type: 'string' };
    case 'ZodNumber':
      return { ...base, type: 'number' };
    case 'ZodBoolean':
      return { ...base, type: 'boolean' };
    case 'ZodArray':
      return { ...base, type: 'array', items: zodFieldToJson(zod._def.type) };
    case 'ZodRecord':
      return { ...base, type: 'object', additionalProperties: true };
    case 'ZodUnknown':
      return base;
    default:
      return base;
  }
}

// ─── HTTP server ───────────────────────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Healthcheck — sem auth. `?deep=1` testa conexão Postgres (mais caro mas detecta DB caído).
  if (req.url?.startsWith('/healthz') && req.method === 'GET') {
    const deep = req.url.includes('deep=1');
    if (deep) {
      try {
        const r = await executeQuery('SELECT 1::int AS up');
        res.writeHead(r.rows[0]?.up === 1 ? 200 : 503, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ ok: r.rows[0]?.up === 1, db: true, name: 'joaocury-db', version: SERVER_VERSION }));
      } catch (err) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          db: false,
          error: err instanceof Error ? err.message : String(err),
          name: 'joaocury-db',
          version: SERVER_VERSION,
        }));
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'joaocury-db', version: SERVER_VERSION }));
    return;
  }

  // MCP endpoint — aceita /mcp, /mcp/, /mcp?…
  if (req.url === '/mcp' || req.url === '/mcp/' || req.url?.startsWith('/mcp?') || req.url?.startsWith('/mcp/?')) {
    const auth = validateAuth(req);
    if (!auth.ok) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized', reason: auth.reason }));
      return;
    }

    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? null;

    if (req.method === 'POST') {
      let transport: StreamableHTTPServerTransport;
      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else {
        // Nova sessão
        const newId = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newId,
          onsessioninitialized: (id: string) => {
            transports.set(id, transport);
            console.log(`[mcp] sessão iniciada: ${id}`);
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) {
            transports.delete(id);
            console.log(`[mcp] sessão fechada: ${id}`);
          }
        };
        const server = createMcpServer();
        await server.connect(transport);
      }
      await transport.handleRequest(req, res);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      // SSE stream / session close
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res);
      } else {
        res.writeHead(400);
        res.end('sessão inválida');
      }
      return;
    }

    res.writeHead(405);
    res.end('method not allowed');
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

httpServer.listen(PORT, () => {
  console.log(`[mcp] joaocury-db v${SERVER_VERSION} ouvindo em :${PORT}/mcp`);
});

// Graceful shutdown
const shutdown = (signal: string) => {
  console.log(`[mcp] ${signal} recebido, encerrando…`);
  httpServer.close(() => process.exit(0));
  // Forçar saída se não fechar em 5s
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
