# MCP joaocury-db — Roadmap de tools

Análise feita em 2026-06-02 após mapear todas as áreas do sistema (40+ services + 60+ edge functions).

## v0.1 — Núcleo (já entregue)

8 tools genéricas de DB:

- `query` — SELECT read-only
- `mutate` — INSERT/UPDATE/DELETE com dry-run + guardrails destrutivos
- `schema` — estrutura de tabela (colunas, índices, FKs, policies)
- `list_tables` — listar tabelas com tamanho
- `list_functions` — listar funções Postgres
- `list_buckets` — listar buckets Storage
- `call_rpc` — chamar função Postgres por nome
- `count` — atalho pra SELECT count(*) WHERE

Resolve **80% dos casos** mas é cego pra Storage real, edge functions e inboxes.

## v0.2 — Domínios não-DB (propondo adicionar agora)

6 tools que cobrem áreas que SQL puro não resolve bem ou exige montar query toda vez:

### `storage_list(bucket, prefix?, limit?)`
Lista arquivos em bucket Supabase Storage com path/size/mime/last_modified. Hoje pra ver o que tem no `publicacoes-imagens` ou `realizacoes-imagens` precisa montar query em `storage.objects`. Tool dedicada acelera muito.

### `storage_get_url(bucket, path, expires_seconds?)`
Gera signed URL temporária pra inspecionar arquivo (debug "essa imagem é a certa?", "essa foto bate com o título?"). Sem isso, Claude não consegue verificar conteúdo de arquivos privados.

### `invoke_function(name, payload, sync?)`
Chama edge function por nome via HTTP interno. Sistema tem ~60 functions úteis:
- `gerar-narrativa` (escrever texto com Claude/Haiku)
- `transcribe-audio` (transcrever áudio)
- `generate-release` (release pra imprensa)
- `run-seo-audit` (auditoria SEO de uma página)
- `aprimorar-texto`, `revisar-ortografia`
- `gerar-imagem-publicacao` (gpt-image-1)

Sem essa tool, eu só sugiro "rode tal função" — você que vai ao Easypanel pingar. Com ela, eu peço o output direto.

### `search_content(query, tables?, limit?)`
Busca textual cross-table (ILIKE com unaccent) em conteúdo editorial:
- `publicacoes.titulo/subtitulo/resumo/corpo_md`
- `news_articles.title/subtitle/content`
- `site_pages.title/content_html`
- `proposals.titulo/descricao`

Hoje cada busca dessas exige montar query custom. Tool dedicada deduplicação inclusa.

### `recent_changes(table?, since_minutes?, limit?)`
Quem mudou o quê nas últimas N horas/minutos. `updated_at` filter + (se existir) `updated_by`. Hoje cada auditoria é manual. Inclui agregação por tabela: "X linhas em emendas, Y em publicacoes".

### `stats_dashboard(domain)`
Dashboards prontos por área:
- `emendas` → total, por status, por município, soma valor_solicitado/empenhado/pago
- `conquistas` → publicadas, sem capa, sem corpo, top categorias
- `apoiadores` → total supporters, por região, por intensidade de engajamento
- `diabetes` → inscritos no funil, opt-ins confirmados, trilhas ativas
- `portal` → publicações últimos 30 dias, total page views (se rastreado)
- `comunicacao` → mensagens contato pendentes, releases agendados, fila email/sms/whatsapp
- `terceiro_setor` → entidades, alertas pendentes
- `storage` → uso total por bucket

Cada um vira um JSON pronto pra apresentar ou plotar.

## v0.3 — Operação e manutenção (quando virar dor)

Adicionar quando virar fricção real:

### `audit_inbox(type)`
Inboxes/filas que precisam atenção do gabinete:
- `contact_messages` não respondidos
- `lgpd_titular` requests pendentes (Art. 18 LGPD: 15 dias pra responder)
- `imprensa` releases agendados não disparados
- `terceiro_setor` alertas

### `migrations_status()`
Listar migrations aplicadas (consulta `schema_migrations`) vs no repo (`supabase/migrations/`). Útil quando trabalhamos em schema novo.

### `disk_usage()`
- `pg_database_size`
- Top 10 maiores tabelas
- Tamanho por bucket Storage
- Tendência (delta últimos 7d) — pra antecipar upgrade VPS antes de OOM

### `rls_explain(table)`
Tradução humana das policies RLS: "super_admin pode tudo; editor pode INSERT/UPDATE; visualizador só SELECT do que for status='publicada'". Hoje `schema()` retorna SQL bruto das policies.

### `storage_orphans(bucket)`
Arquivos em Storage não referenciados em nenhuma coluna do schema (uploads abandonados, capas trocadas). Útil pra limpeza periódica antes de virar custo.

### `compose_post_preview(content, channels[])`
Preview do que um post viraria em cada canal (IG/FB/X/WhatsApp/Threads) antes de publicar. Reaproveita `generate-social-post`.

## v0.4 — Performance e segurança

Implementar quando o portal escalar:

### `slow_queries(top_n)`
`pg_stat_statements` top N (se extensão habilitada). Performance investigation.

### `vacuum_status()`
`pg_stat_user_tables`: last_vacuum, last_autovacuum, n_dead_tup. Manutenção operacional pré-campanha.

### `failed_auth_logins(since_hours)`
`auth.audit_log_entries` filtrado. Detectar brute force, monitoramento de segurança.

### `function_logs(name, since_minutes?)`
Logs recentes de edge function via Vector/Loki ou Postgres. Debug operacional.

### `secrets_inventory()`
Listar **nomes** dos secrets em `ai_secrets` SEM valor. Saber se `ANTHROPIC_API_KEY` está configurada, sem ler o conteúdo.

## NÃO incluir (decisão consciente)

- Ler `auth.users` direto → PII desnecessária, RLS já filtra
- Modificar `ai_secrets` → fora do escopo de Claude operacional
- Apagar arquivos do Storage sem confirmação extra → arriscado demais
- Modificar policies RLS direto → toda mudança de política deve ir via migration versionada
- Modificar `team_members.role` direto → operação sensível, faz por UI admin

---

## Decisão proposta

**Pra v0.2 (agora):** implementar as 6 tools da seção v0.2. Total: **14 tools**. Acrescenta ~250 linhas de código + 1h de trabalho.

**Pra v0.3+:** implementar conforme uso real revelar fricção.

A separação por versão te dá controle: você decide quando upgradar.
