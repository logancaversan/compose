# MCP joaocury-db — container que roda no Easypanel, junto do compose Supabase.
# Conecta no Postgres via loopback do compose (mesma network docker).
#
# tsx interpreta TS direto sem build step. tsx está em `dependencies` (não dev)
# pra sobreviver a `npm ci --omit=dev`.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
# --omit=dev exclui @types/* e typescript (não usados em runtime).
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

EXPOSE 8080

# Healthcheck simples — confirma que o HTTP server tá respondendo.
# Usa `node fetch` (built-in no Node 20+) em vez de wget pra ser independente
# de pacotes do sistema. NÃO testa Postgres aqui — se o DB cair, o container
# ainda fica vivo (você consulta /healthz?deep=1 manual pra ver). Isso evita
# restart loop quando o supabase compose demora pra subir.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
