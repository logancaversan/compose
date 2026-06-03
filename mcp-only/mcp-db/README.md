# MCP joaocury-db

Servidor **Model Context Protocol** que expõe o Postgres do mandato pro Claude conversar direto, sem precisar passar pelo Console do Easypanel toda hora.

Roda **dentro do servidor** (container Easypanel), conecta no Postgres via loopback, expõe HTTP `/mcp` via Kong em `https://api.joaocury.com.br/mcp`. Autenticação via Bearer token.

---

## Por que isso existe

Antes: cada query DB exigia (1) abrir Easypanel → (2) Console → (3) selecionar container → (4) clicar Bash → (5) colar comando → (6) ler saída paginada por screenshot. Demorado, frágil, sem clipboard, com risco de digitar mal e dropar tabela.

Depois: Claude chama `query`, `mutate`, `schema`, `list_tables`, `call_rpc` direto. Resultado JSON estruturado, sub-segundo, com guardrails contra operação destrutiva.

---

## Tools expostas

**Núcleo (v0.1):**

| Tool | O que faz |
|---|---|
| `query` | `SELECT`/`SHOW`/`EXPLAIN`/`WITH` read-only. Default 200 linhas, máx 1000. |
| `mutate` | `INSERT`/`UPDATE`/`DELETE`. Default `dry_run=true` (faz `ROLLBACK`). Operação destrutiva (`DROP`/`TRUNCATE`/`DELETE` sem `WHERE`) exige `confirm_destructive=true`. |
| `schema` | `\d` equivalente: colunas, indexes, FKs, RLS policies de uma tabela. |
| `list_tables` | Lista tabelas com tamanho e estimativa de linhas. |
| `list_functions` | Lista funções/RPCs do schema. |
| `list_buckets` | Lista buckets do Supabase Storage. |
| `call_rpc` | Chama função Postgres com args nomeados (equivalente `supabase.rpc()`). |
| `count` | `SELECT count(*) FROM x WHERE …` direto. |

**Domínios além-DB (v0.2):**

| Tool | O que faz |
|---|---|
| `storage_list` | Lista arquivos de um bucket com path/size/mime/datas. Suporta prefix LIKE. |
| `storage_get_url` | Gera URL (pública direta ou assinada com TTL) pra inspecionar arquivo. |
| `invoke_function` | Chama edge function por nome — `gerar-narrativa`, `transcribe-audio`, `run-seo-audit`, `generate-release`, `gerar-imagem-publicacao`, etc. |
| `search_content` | Busca textual cross-table (publicacoes, news_articles, site_pages, proposals, emendas). |
| `recent_changes` | Auditoria: o que mudou nas últimas N horas. Agregado ou por tabela. |
| `stats_dashboard` | Painéis prontos por domínio: emendas, conquistas, apoiadores, diabetes, portal, comunicacao, terceiro_setor, storage. |

Ver `ROADMAP.md` pra v0.3+ (audit_inbox, migrations_status, disk_usage, etc — implementar quando virar dor real).

---

## Setup — uma vez por servidor

### 1. Gerar o bearer token

No seu Mac, gere um token aleatório:

```bash
openssl rand -hex 32
```

Guarde o valor (vai usar em 2 lugares: env do MCP no servidor + config do Claude Desktop).

### 2. Adicionar serviço no Easypanel

No Easypanel → projeto `joaocury` → **+ Serviço** → tipo **App**:

- **Nome:** `mcp-db`
- **Source:** Git (mesmo repo do joaocury)
- **Build:** Dockerfile
- **Dockerfile path:** `tools/mcp-joaocury-db/Dockerfile`
- **Build context:** `tools/mcp-joaocury-db`

### 3. Environment do serviço

Em **Ambiente** do serviço `mcp-db`:

```env
# Bearer token gerado no passo 1 (suporta múltiplos separados por vírgula pra rotação)
MCP_AUTH_TOKEN=cole_aqui_o_hex_de_64_chars

# Conexão Postgres — herda do compose Supabase via internal docker network
POSTGRES_HOST=joaocury_supabase-db-1
POSTGRES_PORT=5432
POSTGRES_DB=postgres
POSTGRES_PASSWORD=valor_que_já_está_no_compose_supabase

# Porta interna (Kong faz proxy)
MCP_PORT=8080

# ─── Pra tools v0.2 (storage_get_url + invoke_function) ─
SUPABASE_INTERNAL_URL=http://kong:8000
SUPABASE_PUBLIC_URL=https://api.joaocury.com.br
SUPABASE_FUNCTIONS_URL=http://kong:8000/functions/v1
SUPABASE_SERVICE_ROLE_KEY=<copiar do compose>
```

> ⚠️ **Não exponha porta publicamente direto.** O Kong (já existente no compose Supabase) é quem expõe `/mcp` no domínio `api.joaocury.com.br`.

### 4. Conectar o serviço à network do Supabase

Pra MCP enxergar o container `db-1`, precisa estar na mesma docker network. No Easypanel → `mcp-db` → **Avançado** → **Networks** → adicionar a network do compose `joaocury_supabase_default` (ou similar).

### 5. Adicionar route no Kong

Edite `supabase/kong.yml` (no compose Supabase) e adicione a rota `/mcp/*`:

```yaml
services:
  # ... outros services existentes
  - name: mcp-db
    url: http://mcp-db:8080
    routes:
      - name: mcp-db-all
        strip_path: true
        paths:
          - /mcp
```

Depois **Restart** (botão de seta circular) do container `kong` no Easypanel para recarregar a config. ⚠️ **NUNCA use Stop+Implantar no compose Supabase** — destrói volumes não-nomeados e apaga o schema `public` inteiro (ver CLAUDE.md §B anti-padrões). Se Restart do kong não bastar, restart de toda a stack via botão Restart (não Stop) também é seguro.

### 6. Testar healthcheck

```bash
curl https://api.joaocury.com.br/mcp/healthz \
  -H "Authorization: Bearer SEU_TOKEN"
# Esperado: {"ok":true,"name":"joaocury-db","version":"0.1.0"}
```

### 7. Configurar Claude Desktop

No Mac, edite `~/Library/Application Support/Claude/claude_desktop_config.json` e adicione:

```json
{
  "mcpServers": {
    "joaocury-db": {
      "url": "https://api.joaocury.com.br/mcp",
      "headers": {
        "Authorization": "Bearer SEU_TOKEN_DO_PASSO_1"
      }
    }
  }
}
```

Reinicie o Claude Desktop. Em qualquer conversa, as tools do MCP ficam disponíveis.

---

## Como rodar localmente pra debug

```bash
cd tools/mcp-joaocury-db
npm install
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
export POSTGRES_HOST=localhost  # se tunnel local pra db-1
export POSTGRES_PASSWORD=...
npm run dev
```

Testar:

```bash
curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## Segurança

- **Service role nunca sai do servidor.** O MCP conecta no Postgres como `supabase_admin` via loopback docker. Quem está fora só vê o endpoint `/mcp` autenticado.
- **Bearer token rotacionável.** Pra rotacionar sem downtime: configure `MCP_AUTH_TOKEN=novo,antigo` (ambos aceitos), atualize o Claude Desktop pro novo, depois remova o antigo.
- **Guardrails contra destrutivo.** `DROP`/`TRUNCATE`/`DELETE` sem `WHERE` exigem `confirm_destructive=true` na chamada — Claude precisa pedir intencionalmente.
- **Dry-run por default.** `mutate` faz `BEGIN; …; ROLLBACK;` por default — só persiste com `dry_run=false`.
- **Sem RLS bypass acidental.** Se quiser uma conta com menos poder, crie um role separado em Postgres e use `POSTGRES_MCP_USER`/`POSTGRES_MCP_PASSWORD`.
- **Logs estruturados.** Toda mutação loga em stdout (Easypanel captura). Toda tentativa de auth falha também.

---

## Alternativa: subdomínio próprio em vez de path no Kong

Se mexer no Kong te parecer arriscado (precisa de Restart do Supabase compose), uma alternativa **mais simples e isolada** é dar um domínio próprio pro MCP:

1. No DNS, criar CNAME `mcp.joaocury.com.br → 128.201.73.97` (ou o IP do servidor Easypanel).
2. No Easypanel → serviço `mcp-db` → **Domínios** → adicionar `mcp.joaocury.com.br`. Easypanel gera certificado Let's Encrypt automático.
3. Pular passo 5 (Kong). Endpoint vira `https://mcp.joaocury.com.br/mcp`.
4. Atualizar `claude_desktop_config.json` com a URL nova.

Vantagem: zero risco no compose Supabase. Trade-off: novo domínio (mas DNS é trivial).

---

## Para forks (outros mandatos)

1. Clone o repo do mandato cliente.
2. Build o container `mcp-db` no Easypanel **do cliente** com o `Dockerfile` deste diretório.
3. Gere um `MCP_AUTH_TOKEN` próprio (nunca compartilhe entre clientes).
4. Atualize `kong.yml` daquele compose.
5. Cada dev/operador adiciona o endpoint+token no Claude Desktop dele.

Isolamento total: o MCP de cada mandato fala só com o Postgres daquele Supabase. Service role nunca cruza fronteiras.
