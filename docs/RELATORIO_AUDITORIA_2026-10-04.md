# Auditoria de 04/10/2026 — CVG Diagnostics Hub

**Escopo:** branch `release/production-readiness` (2 commits locais à frente de `origin`, mais 101 arquivos sem commit).
**Método:** gates reexecutados do zero, PostgreSQL 16 descartável em Docker, leitura do código novo e do processo de deploy. A auditoria de 04/10 não alterou código; as correções dos achados vieram em 05/10 e estão no §4.
**Veredito:** o código está em boa forma e os gates passam. Os riscos que restam estão no **processo de deploy**, no **CI** e na **carga**, não nas funcionalidades. Não havia bloqueio de commit; havia dois pontos a resolver **antes do deploy** (N-01 e N-02), ambos resolvidos em 05/10 (§4).

Documentos relacionados: [roadmap de melhorias](build/IMPROVEMENT_ROADMAP_2026-10.md) · [backlog de melhorias](build/IMPROVEMENT_BACKLOG_2026-10.md) · [backlog até produção](build/PRODUCTION_BACKLOG.md).

## 1. Evidência reproduzida

| Gate | Resultado |
| --- | --- |
| `typecheck`, `lint`, `test:config`, `test:perf` | PASS |
| Testes unitários | **1.438/1.438** em 126 arquivos |
| Testes PostgreSQL reais (PG 16) | **95/95** em 16 arquivos |
| Cobertura agregada (`test:coverage`) | 96,82% lines · 95,46% functions · 89,48% branches · `coverage:gate` PASS, **22 exceções**, 0 novas, 0 stale (fechada com testes, sem exceção nova, depois que `confirm-dialog.tsx` e `system-console.tsx` ficaram abaixo do piso) |
| `validate:docs` / `openapi` / `traceability` / `migrations` | PASS · 73 operações em 68 paths · 43/43 · 001–014 |
| `perf:snapshot:gate`, `perf:realtime-budget` | PASS (3 execuções seguidas) |
| `npm audit` (completo e `--omit=dev`) | 0 vulnerabilidades (ver N-03) |
| `build` | PASS |
| E2E (Playwright, sem retries) | **81/81** |
| Mutação · varredura de segredos | 7/7 · sem achados |

A bateria final foi executada no **Node 22.23.2** (o `engines` fixa `>=22 <23`). `test:config` exige Node 22 por desenho (`scripts/eslint-glob.test.mjs:688`) e falha no Node 24, onde a versão padrão desta máquina rodou o resto. Os testes unitários isolados dependem de não haver `POSTGRES_TEST_ADMIN_URL` exportada (um teste mockado de `postgres-store` conflita); o `test:coverage` já remove essas variáveis para a fase unitária.

## 2. Achados

| ID | Sev. | Achado | Evidência |
| --- | --- | --- | --- |
| N-01 | **Alto** (processo) | **O procedimento de atualização contradiz as migrations 013 e 014.** Os dois arquivos dizem "pare o app e o worker antes de aplicar". O [DEPLOYMENT §4](operations/DEPLOYMENT.md) manda `up -d`, e o Compose roda `migrate` com o `app` e o `worker` da versão antiga ainda no ar. A 013 cria a constraint `runtime_audit_is_transient`; a versão antiga continua gravando auditoria no snapshot, e cada comando clínico falha até o `app` ser recriado. Não corrompe dados (a transação reverte), mas derruba escritas na janela. Nada no `migrate` impede isso. O rollback também é só de dados (restore), porque o código antigo não roda no schema novo. | `db/migrations/013_*.sql:1`, `014_*.sql:1`, `docker-compose.prod.yml:58-105`, DEPLOYMENT §4 e §8 |
| N-02 | **Médio** | **O CI não executa o E2E principal da UX.** `tests/e2e/ux-simplification.spec.ts` (9 testes, as metas "criar usuário em 4 interações", "liberar em 1") não está na lista do job de E2E, nem em outro job. Uma regressão de UX passaria no CI verde. | `.github/workflows/ci.yml:210` |
| N-03 | **Médio** | **`fast-glob` vendorizado e remendado para zerar o `npm audit`.** O repositório carrega `vendor/fast-glob-3.3.1-cvg.1.tgz` (com um fork do `braces`), um `override` global e 3 scripts de geração/limites. Está bem documentado e o oráculo de 160 testes é sério, mas é dependência própria a manter, só de desenvolvimento. O doc registra que não há correção upstream do `braces`. *(Correção de 05/10: a primeira versão deste achado dizia que o CI não confere a proveniência; confere sim, via `test:config` → `scripts/eslint-glob.test.mjs:687`. Falta só dono e data de revisão.)* | `package.json:84,90`, `vendor/fast-glob.provenance.json` |
| N-04 | Baixo | **O PROD-110 continua aberto e o gate não tinha teto de latência.** A latência era só informativa. *(Correção de 05/10: a primeira versão falava de "piora a cada etapa" (GET 191 → 305 ms, POST 191 → 463 ms) com números de execuções diferentes copiados do backlog. Reexecutada aqui, a mesma carga deu p95 máximo de 126 ms nas leituras e 146 ms na escrita, então a tendência não se confirma; a variação entre execuções e máquinas é grande.)* Continua valendo: sem teto, uma regressão grosseira passaria, e o aceite real depende de staging com o volume de D2. | `scripts/perf-postgres.ts`, `docs/build/PRODUCTION_BACKLOG.md` §9 |
| N-05 | **Médio** | **13 mil linhas sem commit e sem push.** 44 arquivos em stage, 57 modificados, 7 novos, e a branch está 2 commits à frente do remoto. O CI remoto nunca rodou nesse conteúdo (PROD-002 segue aberto), e o diff é grande demais para revisar de uma vez. | `git status`, `git branch -vv` |
| N-06 | Baixo | Duas telas usam `window.confirm` nativo (`admin-users.tsx:157`, `system-console.tsx:82`): fora do design system, ruim no celular e em leitor de tela. | arquivos citados |
| N-07 | Baixo | **Documentação defasada e excessiva.** Havia números antigos (768, 809, 912 testes; OpenAPI 70/65; migrations até 011) em 7 documentos, e o DEPLOYMENT §9 ainda dizia que não existe redefinição de senha (existe: "Gerar nova senha"). Há 30 arquivos em `docs/build/` de vários programas sobrepostos (AAA, state-of-art, frontend, 95, AUDIT, PRODUCTION). **Corrigido nesta rodada** (§3); a consolidação vira o DOC-01. | §3 |

### Verificado e sem achado
- **Segurança por baixo da UX:** reautenticação para ADMIN, último ADMIN protegido, `mustChangePassword` aplicado no servidor, motivos clínicos validados no servidor, CSRF e auditoria presentes.
- **Contador de login:** por par e-mail/cliente, leitura sem escrita, 4 testes PostgreSQL.
- **Migrations 013/014:** bloqueiam a linha de estado, recusam IDs duplicados e divergência de projeção, e revertem tudo se algo não bater. Falta só o procedimento de execução (N-01).
- **Papéis de banco:** o runtime não executa DDL nem altera `audit_events` (teste negativo com `42501`).
- **Segredos:** nenhum arquivo `.env` ou chave versionado; `.data/` ignorado.
- **Superfície:** 73 operações, todas com handler registrado e validadas contra o manifesto.

## 3. Documentação atualizada nesta rodada

- `docs/README.md`: snapshot corrente reescrito com as medições deste relatório.
- `docs/operations/DEPLOYMENT.md`: novo §4.1 (atualização com cutover 013/014), §6.2 e §9 corrigidos.
- `docs/DECISION_LOG.md`: D-024 a D-026.
- Números defasados trocados nos 7 documentos de evidência (status, plano de testes, observabilidade, checklist de release, readiness, rastreabilidade).
- Novos: este relatório, o [roadmap](build/IMPROVEMENT_ROADMAP_2026-10.md) e o [backlog](build/IMPROVEMENT_BACKLOG_2026-10.md) de melhorias.

## 4. Tratamento em 05/10/2026

| ID | Situação | O que foi feito |
| --- | --- | --- |
| N-01 | **Resolvido** | O `migrate` recusa 013/014 enquanto houver outra sessão conectada (`MIGRATION_CUTOVER_REQUIRES_STOPPED_RUNTIME`), antes de qualquer SQL; `MIGRATION_CUTOVER_ACKNOWLEDGED=true` é a exceção explícita. 4 testes unitários e 1 teste PostgreSQL real (recusa com o runtime antigo conectado, aplica depois que ele sai). Procedimento no [DEPLOYMENT §4.1](operations/DEPLOYMENT.md). |
| N-02 | **Resolvido** | `ux-simplification.spec.ts` entrou no job de E2E do CI (`.github/workflows/ci.yml`). |
| N-03 | **Resolvido** | D-026 registra continuidade técnica do vendor sob a instrução de resolver as pendências, responsável `ricardoakinaga-dev` e revisão a cada upgrade de Next/ESLint e até 04/01/2027. Hash/proveniência seguem conferidos no CI. |
| N-04 | **Resolvido** | O `perf:postgres` agora reprova acima de tetos absolutos de p95 (2× as metas do PRD: 1.000 ms leitura, 1.600 ms busca e escrita; `PERF_POSTGRES_P95_CEILING_FACTOR`). Passou: leitura 126 ms, escrita 146 ms. Aceite com volume real continua no PROD-110. |
| N-05 | **Parcial** | Trabalho publicado em 05/10; `main` protegida com PR e 7 checks obrigatórios, inclusive para administradores. Verify, benchmark e CodeQL passaram no [CI remoto](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/37268485070). Corrigidos os erros encontrados em checkout limpo, referência do Trivy, interpolação do psql e distribuição do MinIO. Falta CI completo verde no candidato corrigido (PROD-002). |
| N-06 | **Resolvido** | Nenhum `window.confirm` restante: `useConfirm`/`ConfirmDialog` (foco preso, Escape cancela, foco volta ao botão) em revogar sessão, reprocessar/descartar e gerar nova senha. |
| N-07 | **Resolvido** | Números e afirmações defasadas corrigidos; consolidação de `docs/build/` segue como DOC-01. |

Na conferência pré-push, `test:config` revelou uma comparação instável no teste de symlink circular (159/160). `ELOOP` foi reproduzido também no pacote original; o teste agora mantém a comparação exata de todos os caminhos no sucesso e aceita somente esse erro no ciclo sem limite. O caso com profundidade limitada exige sucesso nas três APIs. Após o ajuste, três execuções passaram 160/160, sem skips; lint sem warnings, OpenAPI, docs, varredura de segredos e audit completo passaram. Revisão independente sem achados nesse escopo. Pacote vendorizado e oráculo histórico preservados; detalhes no COR-02 do backlog de melhorias. CI remoto permanece pendente.

Em 05/10 o isolamento dos opt-ins PostgreSQL foi movido para `src/test/setup.ts`: os testes unitários passaram **1.438/1.438** mesmo com as duas variáveis exportadas. A suíte de integração mantém configuração própria. O verify remoto confirmou **1.533/1.533** agregados e cobertura com as mesmas **22 exceções**.

O CodeQL sinalizou cinco usos de SHA-256 como se fossem hashes de senha. A triagem independente examinou o SARIF e seus 14 fluxos: são comparação em memória de chave do scanner, tokens aleatórios de sessão, fingerprint de teste e hashes de integridade de backfill/cutover. As senhas humanas usam `scrypt`. Os cinco alertas foram encerrados individualmente como **falsos positivos**, com justificativa na API do GitHub; nenhuma consulta, regra ou código de autenticação foi desativado. A entropia da chave real do scanner continua dependente da configuração de produção.

A imagem pública fixada do MinIO deixou de estar disponível (`unauthorized`/manifest ausente). Os Composes agora compilam o código oficial na revisão `7aac2a2c5b7c882e68c1ce017d8256be2feea27f`, com checksum do arquivo-fonte conferido no Dockerfile e fonte/licença incluídas na imagem. O scan inicial do upstream revelou 39 achados HIGH/CRITICAL; sete dependências diretas foram atualizadas para versões corrigidas, incluindo suas transitivas, sem patch de lógica do servidor MinIO. A imagem atualizada passou no scan de vulnerabilidades e segredos sem achados HIGH/CRITICAL corrigíveis, conforme o gate existente (`ignore-unfixed=true`), em **104 testes upstream** de autenticação/hash/cripto/OpenID (zero skips) e no round-trip S3 assinado em porta automática. Assinatura incorreta e leitura anônima foram recusadas com 403. O upstream está arquivado: esta correção da distribuição local/CI não escolhe nem aprova o storage de produção (D11). Nenhum serviço instalado foi reiniciado.

O E2E remoto funcional passou **66/66**, mas os três screenshots do dashboard reprovaram: baseline anterior ao atalho global, data corrente variável e fontes do host divergentes. O teste visual agora fixa a data e o job usa a imagem oficial Playwright 1.55.1 por digest (mesma versão do pacote), com browser/fontes constantes. Baselines revisados visualmente; repetição local passou **3/3** com o mesmo limite de 1%, sem retries. Apenas a instalação redundante do browser foi substituída pelo browser já incluído no container; os testes funcionais/visuais e de acessibilidade continuam obrigatórios.

O scan de imagem foi ampliado para Ops e MinIO. Os achados do PCRE2 e do npm embarcado na imagem operacional foram tratados na construção da imagem: update de segurança do Debian, npm 11.21.0 e duas dependências embarcadas corrigidas (D-027). A fonte/lockfile do aplicativo e o npm do host permanecem iguais; o comando `npm run validate:migrations` foi comprovado dentro da imagem Ops como usuário `node`. Os scans locais de aplicação, Ops e MinIO passaram na mesma política HIGH/CRITICAL corrigíveis, sem novos ignores.

A execução remota `37272431800` confirmou **1.533/1.533**, as **22 exceções** de cobertura, build/audit/perf e o job de imagem completo (três scans, livez/readyz e CSP). O navegador PostgreSQL revelou uma corrida na inicialização: a primeira checagem de `setsid` consultava o grupo antes de ele existir. Reprodução local: **30/30** falhas no grupo, **30/30** sucessos verificando o PID vivo; o passo corrigido publicou as portas dinâmicas dos serviços e respondeu ao HEAD S3. A prontidão e o prazo permanecem obrigatórios, e a limpeza continua por grupo próprio. O candidato seguinte precisa terminar todos os jobs.

A execução `37274203997` passou os **48/48 E2E PostgreSQL** e o job completo de imagens. Restou o arraste Chromium: a suíte local reproduziu **22/23**, apesar de o caso isolado passar três vezes. O trace mostrou scroll horizontal de 4 para 616 entre mouse down/up, sem POST de início de processamento. O gesto agora parte do padding do card e termina no título da coluna; mantém arraste nativo, resposta 200 e asserções de motivo/recoleta, sem retries ou aumento de timeout. A mesma suíte passou **23/23** após a correção; revisão independente favorável. O novo candidato ainda precisa completar o CI remoto.

## 5. Pendente e fora do alcance local

E2E completo e aceite de carga em staging dependem de D2 (volume) e D11 (infraestrutura); CI remoto, pentest, UAT e piloto seguem como no [backlog até produção](build/PRODUCTION_BACKLOG.md).

Resultado do E2E desta rodada: **81/81** em Chromium, tablet e mobile (`playwright test --retries=0`, 9,5 min), mutação 7/7 e varredura de segredos sem achados.
