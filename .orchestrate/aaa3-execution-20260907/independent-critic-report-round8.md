# Parecer de qualidade — rodada 8, revalidação fresca pós-hardening assíncrono

**Status:** `BLOCKED` para `AAA-READY` e release.

**Critic ID:** `FC-I1-CVG-20260907-01`  
**Independência:** `I1` no sentido de contexto fresco e somente leitura; o
parecer é `PEER`, não aprovação independente formal.  
**Sealed packet:** `true`  
**Context fork:** `none`  
**Escopo:** inspeção read-only do artefato atual, quality bar, manifesto,
diffs, mtimes, PNGs e verificador AAA-3; sem edição, descendentes, rerun de
suíte/build e sem acesso à PostgreSQL persistente `127.0.0.1:5432`.

## Sentinel de mutação

- Antes da inspeção: `5e46d39e1b9519a8b917502ca41500191bed18b83129bd8bcc1265a32fb06b8e`.
- Depois da inspeção: `cf25a12ca298553bc0e004cc0592c0bf83ad6e25de20257a3398a2574acd93a3`.
- A árvore permaneceu suja por desenho; o crítico não editou arquivos.

## Maior lacuna

`AAA3-C01 / AAA3-E08 / AAA3-O07 / AAA3-E10`: o packet de evidência estava
desatualizado em relação à árvore atual. O manifesto ainda apontava para o
fingerprint e os captures anteriores à última sequência de alterações de UI e
testes. O verificador reproduziu a falha de fingerprint. A correção segura é
congelar a árvore, executar novamente Node 22, build, browser/visual e
regenerar o manifesto; este pacote não transforma automaticamente o candidato
em `AAA-READY`.

## Resultado por critério

| Critério | Resultado | Evidência observada |
| --- | --- | --- |
| AAA3-C01 — escopo e verdade | **FAIL** | Fingerprint do candidato divergia do manifesto. |
| AAA3-C02 — autorização e confidencialidade | **BLOCKED** | Há negativos locais, mas IdP institucional e autoridade final permanecem abertos. |
| AAA3-C03 — contratos e runtime | **STALE** | Contratos/build anteriores às últimas superfícies de UI e filas. |
| AAA3-C04 — integridade e migração | **BLOCKED** | PostgreSQL source-current, cutover e autoridade relacional não provados; JSONB continua autoridade. |
| AAA3-C05 — workflow clínico | **BLOCKED** | D-01–D-04 e autoridade clínica humana não fechados. |
| AAA3-O06 — operações distribuídas | **BLOCKED** | Carga, failover, storage/AV, alertas e recovery-alvo não executados. |
| AAA3-O07 — visual/acessibilidade | **STALE** | Renders coerentes, porém sem packet atual e sem revisão manual de leitor de tela/touch/zoom. |
| AAA3-E08 — regressão | **STALE** | Claims 723/57 anteriores às últimas mudanças e sem fingerprint reconciliado. |
| AAA3-E09 — reprodutibilidade/supply chain | **STALE** | Evidência local anterior; CI remoto limpo não executado. |
| AAA3-E10 — traceability | **FAIL** | Alterações materiais sem testes/renders/records correntes vinculados no packet. |
| AAA3-G11 — governança/release | **BLOCKED** | Sem piloto autorizado, treinamento, aceite hospitalar e decisão formal. |

## Evidências ausentes no momento da inspeção

- Fingerprint congelado e manifesto regenerado.
- Validação Node 22, build, cobertura, componentes, browser e visual após as
  últimas edições.
- Captures atuais das superfícies de fila, gestão, indicadores, pacientes,
  RequestDetail, resultados e administração.
- Rerun PostgreSQL descartável source-current, sem tocar 5432.
- Carga/failover/recovery/storage/AV/observabilidade do ambiente-alvo.
- Acessibilidade manual, validação clínica/hospitalar, piloto e release formal.

## Revalidação local posterior — host principal — 07/09/2026

Após o parecer, o host principal executou a suíte corrente sob Node 22.23.2:

- `725/725 testes` em `86` arquivos;
- 92,72% linhas, 85,82% branches e 94,31% funções;
- build Next.js 16.3.0/Turbopack passou com 15 rotas;
- browser E2E passou `57/57` em Chromium/tablet/mobile, sem retry;
- 20 PNGs visuais foram recapturados e tiveram os hashes verificados.

Essa revalidação fecha a obsolescência local apontada para a evidência
automatizada, mas não altera o julgamento do crítico sobre os gates externos,
manuais, clínicos, relacionais e de release. O candidato deve permanecer
`BLOCKED_REVIEW_REQUIRED` com `release_claim: false`.
