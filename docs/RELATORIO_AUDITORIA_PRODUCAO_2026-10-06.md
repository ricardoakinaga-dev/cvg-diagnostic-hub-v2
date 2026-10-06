# Auditoria de prontidão para produção — 06/10/2026

Auditoria da branch `feat/plane-experience` a partir de `b3ed19e`, com foco em
CI, imagens, deploy em Compose, migrations, persistência, backup/restore,
integrações (S3, antivírus, outbox, SSE), rotas e telas responsivas. Complementa
o [relatório de interface de 06/10/2026](RELATORIO_AUDITORIA_2026-10-06.md).
Nenhum merge, push ou deploy faz parte desta entrega, e ela não altera os gates
humanos de [PRODUCTION_READINESS.md](operations/PRODUCTION_READINESS.md).

## Método

- Gates locais com Node 22.23.2 e PostgreSQL 16.15 descartável.
- Logs e artefatos da execução remota [37460630677](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/37460630677).
- `docker-compose.prod.yml` executado de ponta a ponta em projeto isolado
  (`-p cvg-claude-smoke`), com segredos descartáveis, MinIO e um scanner HTTPS
  sintético no lugar dos serviços externos, e borda Caddy com TLS local.
  Nenhuma instalação persistente desta máquina foi tocada.
- Varredura de telas com Playwright: 4 papéis, 3 viewports e os 4 layouts de
  exames, sobre servidor descartável em memória com a carga sintética do
  `db:demo`.

## Achados e correções

| ID | Prioridade | Achado | Tratamento e evidência |
| --- | --- | --- | --- |
| PR-01 | Alta | CI vermelho: a imagem `runner` tinha 3 CVEs CRITICAL e 4 HIGH em `perl-base` (Debian 12), todas com correção publicada. O Dockerfile atualizava só `libpcre2`. | `apt-get upgrade` completo no estágio base; Trivy local com 0 HIGH/CRITICAL nas imagens `runner` e `ops` (`perl-base` 5.36.0-7+deb12u4). O Playwright, mantido por ser peer opcional do Next, saiu da imagem de runtime. |
| PR-02 | Alta | CI vermelho: os baselines visuais do commit `b3ed19e` foram capturados com o Chrome do host, não com a imagem fixada do CI (diferença só de fonte, 2% dos pixels). | Baselines regenerados na imagem `mcr.microsoft.com/playwright:v1.55.1-noble` fixada: 0 pixel de diferença para o render do CI (14 px de antialiasing no celular). Novo `npm run test:visual:update` faz isso sempre no container. |
| PR-03 | Alta | Cada página monta o próprio `AppShell`, então cada navegação abre um SSE novo e recebe a janela de replay (20 eventos) de uma vez; cada evento refazia todas as leituras da tela. Medido: 21 a 71 chamadas de API por navegação (`/notifications` ×17 em toda página). | Rajadas coalescidas em uma atualização (150 ms). Medido depois: `/results` 71→11, `/queues` 37→8, `/notifications` 36→6, `/` 24→12, `/requests` 21→6. Teste de regressão falha no código anterior (20 disparos) e passa no novo. |
| PR-04 | Alta (operação) | O backup sob demanda documentado (`run --rm backup --once`) inicia antes o `migrate`, dependência do serviço: no fluxo de atualização ele aplicaria as migrations novas antes da cópia de segurança. O `npm run db:backup` indicado no §4/§4.1 não alcança o PostgreSQL do Compose, que não publica porta. | Runbooks usam `run --rm --no-deps backup --once`, antes do `pull/build`. Comportamento reproduzido com e sem `--no-deps`. |
| PR-05 | Média | Os dumps do serviço `backup` não têm manifesto, e `npm run db:restore` exige manifesto; o runbook de restore não tinha comandos. | Procedimento concreto em [BACKUP_RESTORE §4.1](operations/BACKUP_RESTORE.md), executado literalmente: drop do banco, restore do dump, `migrate` (14 migrations “já aplicada”, 41 tabelas devolvidas ao `cvg_migrator`, grants do runtime), `readyz` 200, login e contagens iguais. |
| PR-06 | Média | Dumps criados com permissão 0644, com dados clínicos e hashes de credenciais. | `umask 077` no `backup-loop.sh`; novos dumps 0600. |
| PR-07 | Média | `docker-compose.prod.yml` não repassava 15 variáveis documentadas como ajustáveis (timeout de inatividade, retenções, orçamento realtime, limites de taxa e de corpo JSON, fuso, retenção de buckets): `--env-file` só alimenta interpolação, e os valores eram ignorados em silêncio. | Repassadas com os mesmos padrões do código. |
| PR-08 | Média | Cliente S3 sem timeout: um endpoint que aceita a conexão e não responde prendia upload, download e `readyz`. Nesta versão do SDK, `requestTimeout` sozinho apenas registra aviso. | 5 s de conexão, 30 s de inatividade e `throwOnRequestTimeout`. Teste com socket real que nunca responde: falha em menos de 1 s (antes, preso além de 15 s). |
| PR-09 | Média | Com ponteiro coarse, alvos abaixo de 24 px (WCAG 2.2 SC 2.5.8) e da regra de 44 px do design system: links das seções do Início (18 px), rótulo de opção da Administração (19 px) e campo de busca (21 px, sem área de toque no contorno). | Área de toque ampliada sem deslocar o layout; a varredura não encontra mais alvos ativos abaixo de 24 px. Os estados exibidos sem permissão de mudança são botões desabilitados. |
| PR-10 | Baixa | Segredo da borda comparado com `!==`. | Comparação em tempo constante sobre digests SHA-256. |
| PR-11 | Baixa | `DB_POOL_MAX` malformado virava `NaN`, que o `pg-pool` trata como pool sem limite. | Valor inválido volta ao padrão 10; teste. |
| PR-12 | Baixa | `MIGRATION_DATABASE_URL=""` impedia o fallback para `DATABASE_URL`. | `||` no lugar de `??`. |
| PR-13 | Baixa (CI) | Actions em Node 20 descontinuadas, CodeQL v3 descontinuado em dez/2026 e `ubuntu-latest` migrando para Ubuntu 26 em 19/10, antes do suporte do Playwright 1.55. | `checkout@v5`, `setup-node@v5`, `upload-artifact@v6`, `cache@v5`, `dependency-review-action@v5`, `codeql-action@v4` e `ubuntu-24.04` fixado; `actionlint` sem erros. |
| PR-14 | Baixa (teste) | Com PR-03, o teste de navegador “failed exam loading…” falhou 1 vez em 90 (tablet): depois de remover a falha simulada, uma atualização em tempo real recarregava a lista sozinha e o botão “Tentar novamente” sumia antes do clique. A recuperação automática é o comportamento correto; o teste dependia da corrida. | O teste mantém a falha até o clique explícito; 105/105 em 5 repetições nos três viewports, sem instabilidade. |

## Verificado sem defeito

- Produção em Compose, pela borda TLS: 27/27 verificações de API cobrindo
  bootstrap, troca obrigatória de senha, catálogo, usuários, paciente,
  solicitação, fila, amostra, resultado, anexo em S3 com antivírus,
  liberação, notificação entregue pelo worker durável, download, SSE,
  autorização e logout. O segundo `bootstrap` recusa banco inicializado.
- Papel de runtime: `UPDATE`, `DELETE` e `TRUNCATE` em `audit_events`,
  `DROP` e `CREATE` negados. Dados preservados após `down`/`up` completo.
- `X-Forwarded-For`, `X-Real-IP` e segredo forjados pelo cliente são
  descartados pela borda; o bucket de login usa o endereço real (§5.1 do
  [deploy](operations/DEPLOYMENT.md)).
- Cabeçalhos: CSP com nonce, HSTS, `frame-ancestors 'none'`, COOP/CORP,
  `nosniff`, `Referrer-Policy` e `Permissions-Policy`.
- Telas: nenhuma rolagem horizontal, erro de console ou falha de API em
  todas as combinações da varredura.
- `npm audit`: 0 vulnerabilidades. Migrations 001–014 com checksums válidos.

## Validação final

| Verificação | Resultado |
| --- | --- |
| Typecheck, lint e `test:config` | PASS; 160/160 e 4/4 |
| Unitários | 1.587/1.587 em 134 arquivos |
| PostgreSQL 16 descartável | 96/96 em 17 arquivos |
| Cobertura agregada e gate | 1.683 testes em 151 arquivos; 97,05% lines, 95,76% functions, 90,04% branches; gate PASS com as mesmas 22 exceções, `uncovered` e `stale` vazios |
| Navegador na imagem do CI (`--retries=0`) | 90/90 na matriz e 12/12 de acessibilidade, no código final |
| Mutação, performance, recuperação | 7/7 mutantes detectados; 52/52; 5/5; `perf:synthetic`, `perf:snapshot:gate` e `perf:realtime-budget` PASS |
| Imagens finais (Trivy HIGH/CRITICAL) | 0 em `runner` e `ops` |
| Compose de produção com imagens finais | 27/27; restore ensaiado; variáveis repassadas confirmadas nos containers |
| Docs, OpenAPI, rastreabilidade, migrations, segredos, `npm audit` | PASS; 73 operações/68 paths; 43/43; 001–014; 0 vulnerabilidades |

Uma execução intermediária da cobertura falhou 1 de 1.587 testes: o teste de
atalho ⌘K do `AppShell` apertava a tecla antes do efeito que registra o
atalho, só sob carga de CPU (0 falhas em 20 execuções isoladas do arquivo).
O teste agora espera o efeito do mesmo commit, como o teste
vizinho já fazia. Nenhum limite, retry ou exceção de cobertura foi relaxado.
O CI remoto não foi executado: nada foi enviado.

## Recomendações não aplicadas

- `POST /users` aceita `password` e o ignora (a senha inicial é sempre gerada
  pelo servidor). Rejeitar o campo ou marcá-lo como obsoleto no OpenAPI.
- Até 10 componentes buscam `/session/me` separadamente; compartilhar uma
  única leitura por página.
- As telas de exames recarregam todas as páginas da lista a cada atualização;
  sob eventos contínuos, limitar a uma recarga por segundo.
- `/metrics` exige sessão: o Prometheus precisa de credencial de serviço.
- O worker roda na imagem `ops`, com dependências de desenvolvimento;
  compilar os scripts e usar só dependências de produção.
- Fixar digests de `caddy:2-alpine` e `postgres:16-alpine`.
- `APP_ORIGIN` é obrigatório no Compose, mas o servidor não o usa.
- Planejar Next 16.4, React 19.3, zod 4 e patches do AWS SDK/pg.

Continuam abertos os itens institucionais do
[backlog de produção](build/PRODUCTION_BACKLOG.md): carga com p95 em staging
(PROD-110), RPO/RTO e restore de object storage, pentest, UAT, políticas
clínicas e aceite do piloto.
