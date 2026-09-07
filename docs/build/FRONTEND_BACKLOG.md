# Backlog frontend AAA³

## CVG Diagnostic Hub — trabalho priorizado, evidência e aceite

**Versão:** Frontend AAA³ v1.0  
**Data:** 07/09/2026  
**Plano executivo:** [FRONTEND_EXECUTIVE_PLAN.md](FRONTEND_EXECUTIVE_PLAN.md)  
**Roadmap:** [FRONTEND_ROADMAP.md](FRONTEND_ROADMAP.md)  
**Base:** [Relatório frontend](../RELATORIO_FRONTEND_STATE_OF_ART_2026-09-07.md)

> Este backlog não representa trabalho concluído. Todo item começa como PENDING, READY ou BLOCKED_HUMAN. IMPLEMENTED significa alteração entregue pelo builder; VERIFIED exige evidência atual; DONE exige integração, regressão e gate. Nenhum item pode ser fechado por aparência, quantidade de código ou resumo do executor.

O backlog frontend é subordinado ao [quality bar AAA-2](AAA_2_QUALITY_BAR.md). Os itens fecham apenas a parte frontend e não substituem políticas, homologação, operação, piloto ou release do programa sistêmico.

## 1. Modelo de priorização

### Prioridade

- **P0:** bloqueia segurança de contexto, verdade de estado, acessibilidade crítica, caminho crítico ou avanço de gate.
- **P1:** bloqueia completude State of Art, consistência entre rotas, performance ou aceite AAA³.
- **P2:** refinamento ou melhoria valiosa que não deve preceder P0/P1.

### Tamanho

- **S:** até 1 dia-pessoa, boundary isolada.
- **M:** 2–4 dias-pessoa, uma superfície ou primitive.
- **L:** 5–10 dias-pessoa, vários arquivos ou uma rota completa.
- **XL:** mais de 10 dias-pessoa, decisões, integração ou evidência ampla; fatiar antes de executar.

Tamanho é estimativa de esforço técnico, não duração de calendário.

### Status

| Status | Significado |
|---|---|
| READY | dependências e contrato disponíveis para iniciar |
| PENDING | planejado, mas ainda não liberado pela dependência |
| BLOCKED_HUMAN | depende de decisão de produto, clínica, segurança ou ambiente |
| IN_PROGRESS | executor ativo |
| IMPLEMENTED | artifact alterado e evidência devolvida; sem aprovação |
| REVIEW | aguardando inspeção independente |
| VERIFIED | critérios do item verificados com evidência current |
| DONE | integrado e aceito no gate correspondente |
| REWORK | evidência falhou ou contrato mudou |

## 2. Evidência padronizada

| Código | Evidência esperada |
|---|---|
| EV-01 | source fingerprint, manifest e integridade do candidate |
| EV-02 | decision register com autoridade, data, versão e impacto |
| EV-03 | screenshots/recordings atuais por rota, role, viewport e estado |
| EV-04 | token, typography, icon, asset, contrast e copy audit |
| EV-05 | keyboard, focus, semantics, names, touch, zoom/reflow, reader e reduced motion |
| EV-06 | motion matrix, LCP, CLS, font loading, network, layout stability e refresh churn |
| EV-07 | critic independente fresco, com maior gap, decisão e limitações |
| EV-08 | teste de componente/E2E/public boundary e erro/recuperação |
| EV-09 | traceability, quality gate, residual risk e release packet |
| EV-10 | long copy, large number, empty, localized, dense timeline e data extremo |

## 3. Definition of Ready

Um item só pode ir para READY quando possui:

- objetivo e boundary claros;
- owner nomeado;
- dependências provadas ou fixture explicitamente definida;
- critério de aceite binário ou ancorado;
- método de evidência;
- arquivos/rotas prováveis;
- risco e regression surface;
- decisão humana registrada quando necessária.

## 4. Definition of Done

Além do aceite específico da tabela, todo item exige:

- implementação integrada no lugar correto;
- estado normal e falha relevante testados;
- evidência ligada ao source fingerprint atual;
- nenhuma alteração fora do escopo;
- revisão de outra pessoa em trabalho material;
- backlog, traceability e packet atualizados;
- nenhum P0/P1 novo sem owner;
- status VERIFIED ou DONE somente no gate que possui o item.

## 5. Critical path — primeiros dez itens

1. FE-0001 — congelar fingerprint e baseline.
2. FE-0002 — resolver decisões humanas mínimas.
3. FE-0003 — criar route/state/viewport ledger.
4. FE-0004 — recapturar baseline visual fresh.
5. FE-1001 — criar tokens semânticos.
6. FE-1005 — fechar contrato de primitives.
7. FE-2001 — fechar máquina de estados do ActionButton.
8. FE-2002 — fechar autoridade de feedback/stale/unknown.
9. FE-3002 — decidir e implementar navegação mobile.
10. FE-3003 — entregar shell/context lock responsivo.

## 6. Epic E0 — governança, decisões e evidência

| ID | Tipo | Pri | Item | Owner | Dep | Tam | Aceite | Evidência | Status |
|---|---|---:|---|---|---|---:|---|---|---|
| FE-0001 | SPIKE | P0 | Congelar source fingerprint e baseline de integridade | QA/Evidence | nenhuma | M | manifest fora do source registra hash, branch, dirty state e escopo observado | EV-01 | READY |
| FE-0002 | DECISION | P0 | Fechar HD-01…HD-07: nav mobile, identidade, ownership, review, critical, SLA, attachments | Product/Clinical Authority | nenhuma | XL | cada decisão tem owner, versão, vigência, impacto e estado; ausência vira BLOCKED explícito | EV-02 | BLOCKED_HUMAN |
| FE-0003 | TASK | P0 | Criar ledger rota × role × viewport × estado | QA/Evidence | FE-0001 | M | todas as rotas públicas e estados aplicáveis têm linha, owner e evidência esperada | EV-01, EV-03 | PENDING |
| FE-0004 | TASK | P0 | Recapturar packet visual atual sem hash drift | Browser/QA | FE-0001, FE-0003 | L | renders 375/390, 768/834 e 1440 ficam ligados ao source atual; console/network e limitações registrados | EV-01, EV-03 | PENDING |
| FE-0005 | TASK | P0 | Medir baseline manual de a11y, interação e performance | QA/A11y | FE-0004 | L | keyboard, focus, targets, zoom, reduced motion, LCP, CLS e network aparecem como PASS/FAIL/NOT RUN, sem inferência | EV-05, EV-06 | PENDING |
| FE-0006 | TASK | P0 | Congelar barra AAA³ e protocolo de evidência | Frontend Lead/QA | FE-0001, FE-0002 | M | FB-01…FB-08 têm target, required, prioridade, método, baseline e validade; mudança gera versão nova | EV-01, EV-02, EV-09 | PENDING |

## 7. Epic E1 — fundação visual e design system

| ID | Tipo | Pri | Item | Owner | Dep | Tam | Aceite | Evidência | Status |
|---|---|---:|---|---|---|---:|---|---|---|
| FE-1001 | FEATURE | P0 | Criar tokens semânticos de canvas, surface, ink, rail, action, critical, watch, info, success e border | Design/Frontend Platform | FE-0002, FE-0006 | L | novos componentes não usam raw color para estado; contraste das combinações finais é documentado | EV-04 | PENDING |
| FE-1002 | FEATURE | P1 | Criar escala de spacing, radius, shadow, layer, control size e motion | Frontend Platform | FE-1001 | M | componentes críticos usam tokens de escala; duplicatas e exceções são justificadas | EV-04 | PENDING |
| FE-1003 | TASK | P1 | Aprovar e carregar fonte local UI + mono de instrumentação | Design/Product | FE-0002 | M | licença, latin/diacríticos, fallback, numerais tabulares e font loading estão documentados e medidos | EV-04, EV-06 | BLOCKED_HUMAN |
| FE-1004 | FEATURE | P1 | Substituir glyphs Unicode por icon system acessível | Frontend Platform/Design | FE-1001 | M | ícones possuem significado, viewBox consistente, accessible name e equivalentes textuais | EV-04, EV-05 | PENDING |
| FE-1005 | FEATURE | P0 | Expandir packages/ui com primitives e contratos de estado | Frontend Lead/A11y | FE-1001, FE-1002, FE-1003, FE-1004 | XL | Button, Status, Feedback, Dialog, Drawer, Tabs, Search, Table e Timeline possuem API de estados e fixtures | EV-04, EV-05, EV-08 | PENDING |
| FE-1006 | TASK | P1 | Rodar auditoria de tokens, contraste, assets e typography | QA/Design | FE-1005 | M | findings raw/contrast/font/asset têm owner; nenhum critical fica sem resposta | EV-04 | PENDING |
| FE-1007 | ASSET | P2 | Criar asset bible com papéis, identidade, proveniência, budget e fallback | Design Director/QA | FE-0006 | M | cada mídia candidata tem papel, motivo, ferramenta, versão/hash, licença/proveniência, dimensões, bytes e fallback | EV-04, EV-09 | READY |

## 8. Epic E2 — primitives de interação e autoridade de estado

| ID | Tipo | Pri | Item | Owner | Dep | Tam | Aceite | Evidência | Status |
|---|---|---:|---|---|---|---:|---|---|---|
| FE-2001 | FEATURE | P0 | Implementar ActionButton com idle, hover, focus, pressed, pending, confirmed, failed, unknown, disabled e denied | Frontend Platform | FE-1005 | L | targets críticos ≥44px; sucesso só após confirmação; unknown não vira success | EV-05, EV-08 | PENDING |
| FE-2002 | FEATURE | P0 | Implementar FeedbackBanner, Empty, Error, Partial, Stale, Denied e UnknownOutcome | Frontend Platform | FE-1005 | L | cada estado preserva contexto, explica limitação e oferece recuperação segura | EV-05, EV-08 | PENDING |
| FE-2003 | FEATURE | P0 | Corrigir Dialog, Drawer e Popover com semântica, Escape, trap e focus restoration | Frontend Platform/A11y | FE-1005 | M | foco entra e retorna; sem popover órfão; keyboard e touch são equivalentes | EV-05, EV-08 | PENDING |
| FE-2004 | FEATURE | P0 | Corrigir Tabs, Toggle, Combobox e Search command semantics | Frontend Platform/A11y | FE-1005 | L | aria relationship, selected state, keyboard arrows, labels e anúncio de resultados funcionam | EV-05, EV-08 | PENDING |
| FE-2005 | FEATURE | P1 | Definir Table/Card responsive contract | Frontend Platform/Design | FE-1005 | M | desktop mantém comparação semântica; mobile não perde identidade/status/action nem cria overflow obrigatório | EV-03, EV-05 | PENDING |
| FE-2006 | FEATURE | P0 | Centralizar DataFreshness, snapshot preservation e state authority | Frontend Lead/QA | FE-2002 | L | dashboard, queue, drawer, workspace, result e notifications usam o mesmo vocabulário e não inventam zeros | EV-08, EV-09 | PENDING |

## 9. Epic E3 — shell, navegação e mobile

| ID | Tipo | Pri | Item | Owner | Dep | Tam | Aceite | Evidência | Status |
|---|---|---:|---|---|---|---:|---|---|---|
| FE-3001 | FEATURE | P0 | Reconciliar nav canônica por role e seção | Frontend Lead/Product | FE-0002, FE-1005 | L | rotas e labels vêm do mapa aprovado; administração técnica não se mistura com comando clínico | EV-02, EV-03 | BLOCKED_HUMAN |
| FE-3002 | FEATURE | P0 | Trocar rail mobile por bottom nav/menu sheet aprovado | Frontend Shell Owner/Design | FE-0002, FE-3001 | L | em 375/390 o rail não domina; back, safe area, focus e reachable action funcionam | EV-03, EV-05 | BLOCKED_HUMAN |
| FE-3003 | FEATURE | P0 | Refatorar AppShell e Patient Context Lock | Frontend Shell Owner | FE-2003, FE-2006, FE-3001 | XL | shell preserva patient, encounter, status, freshness e próximo contexto; troca de role comunica invalidação | EV-03, EV-08 | PENDING |
| FE-3004 | FEATURE | P1 | Adicionar loading, error, not-found e metadata por rota | App Router Owner | FE-2002, FE-3003 | M | cada rota tem heading, loading geometry, erro recuperável e mensagem de contexto | EV-03, EV-05, EV-08 | PENDING |
| FE-3005 | TASK | P0 | Validar shell em 375, 390, 768, 834, 1024, 1280, 1440 e 200% zoom | QA/A11y | FE-3002, FE-3003, FE-3004 | L | no overflow, CTA invisível, focus cut, nav trap ou context loss | EV-03, EV-05 | PENDING |
| FE-3006 | FEATURE | P1 | Integrar realtime/degraded banner ao shell sem refresh storm | Frontend Lead/Platform | FE-2006, FE-3003 | M | conexão, último refresh, reconnect e degraded são legíveis; updates não geram churn observável | EV-03, EV-06, EV-08 | PENDING |

## 10. Epic E4 — attention cockpit, queues e drawer

| ID | Tipo | Pri | Item | Owner | Dep | Tam | Aceite | Evidência | Status |
|---|---|---:|---|---|---|---:|---|---|---|
| FE-4001 | FEATURE | P0 | Reestruturar Overview para atenção antes de métricas | Dashboard Owner/Design | FE-2005, FE-2006, FE-3003 | L | novos resultados, críticos, recoletas, atrasos e minha fila aparecem antes de KPIs decorativos | EV-03, EV-08 | PENDING |
| FE-4002 | FEATURE | P0 | Alinhar Command Center, dashboard e queue na mesma verdade | Command Center Owner | FE-2006, FE-4001 | M | status, owner, freshness e next action não divergem entre superfícies | EV-03, EV-08 | PENDING |
| FE-4003 | FEATURE | P0 | Migrar ExamQueue para table semantics, filters e priority/status copy | Queue Owner/A11y | FE-2004, FE-2005, FE-2006 | L | row expõe identity, service, status, priority, age/SLA permitido, owner e next action | EV-03, EV-05, EV-08 | PENDING |
| FE-4004 | FEATURE | P1 | Criar QueueCard mobile equivalente à tabela | Queue Owner/Design | FE-2005, FE-3002, FE-4003 | M | mobile preserva ordem e conteúdo decisório sem scroll horizontal | EV-03, EV-05, EV-10 | PENDING |
| FE-4005 | FEATURE | P0 | Redesenhar ContextDrawer como folha de decisão | Queue Owner/Design | FE-2003, FE-4003 | M | abre com foco, fecha com Escape, preserva posição e mostra próximo passo contextual | EV-03, EV-05, EV-08 | PENDING |
| FE-4006 | FEATURE | P1 | Validar atualização da fila, stale, retry e reorder | Queue Owner/QA | FE-3006, FE-4003, FE-4005 | M | update confirmado destaca uma vez; stale mostra idade; reorder não é silencioso | EV-03, EV-06, EV-08 | PENDING |

## 11. Epic E5 — pacientes, workspace, requests, results e comunicação

| ID | Tipo | Pri | Item | Owner | Dep | Tam | Aceite | Evidência | Status |
|---|---|---:|---|---|---|---:|---|---|---|
| FE-5001 | FEATURE | P0 | Consolidar PatientIdentity e proteção contra homônimos | Patient Workspace Owner/Clinical | FE-0002, FE-3003 | L | nome, espécie, identificadores permitidos e encounter formam context lock inequívoco | EV-02, EV-03, EV-08 | BLOCKED_HUMAN |
| FE-5002 | FEATURE | P0 | Completar Patient Workspace state matrix | Patient Workspace Owner | FE-2002, FE-2006, FE-5001 | L | loading, empty, error, denied, partial, stale, ready e pagination preservam snapshot/frescor | EV-03, EV-05, EV-08 | PENDING |
| FE-5003 | FEATURE | P0 | Redesenhar RequestDetail e criação de request multi-item/lineage | Request Owner | FE-4005, FE-5001, FE-5002 | XL | itens independentes, duplicate, priority, sample/procedure e próxima ação são explícitos | EV-03, EV-08, EV-10 | PENDING |
| FE-5004 | FEATURE | P0 | Implementar ResultVersionBanner e separação view/review/amend/void | Result Owner/Clinical | FE-0002, FE-2001, FE-2006, FE-5001 | XL | nova versão não sobrescreve; abertura não vira review; review/ack são por versão | EV-02, EV-03, EV-08 | BLOCKED_HUMAN |
| FE-5005 | FEATURE | P0 | Estados de attachments: upload, quarantine, clean, denied e expired | Result Owner/Platform | FE-2002, FE-5004 | L | anexo não parece disponível antes de autorização/scan; erro preserva estado seguro | EV-03, EV-05, EV-08 | PENDING |
| FE-5006 | FEATURE | P0 | Refazer Notifications e critical acknowledgement | Notifications Owner/Clinical | FE-2004, FE-2006, FE-5004 | XL | tabs semânticas; PENDING/DELIVERED/SEEN/ACK/FAILED/ESCALATED distinguíveis; ack por versão | EV-02, EV-03, EV-05, EV-08 | BLOCKED_HUMAN |

## 12. Epic E6 — indicators, management, admin, account e copy

| ID | Tipo | Pri | Item | Owner | Dep | Tam | Aceite | Evidência | Status |
|---|---|---:|---|---|---|---:|---|---|---|
| FE-6001 | FEATURE | P1 | Reestruturar Indicators com definição, denominador, timezone e freshness | Indicators Owner/Product | FE-0002, FE-2006 | L | dados insuficientes são explícitos; nenhuma métrica vira zero fabricado | EV-02, EV-03, EV-10 | BLOCKED_HUMAN |
| FE-6002 | FEATURE | P1 | Alinhar Management metrics/table/stale/partial/error | Management Owner | FE-2005, FE-2006, FE-6001 | L | grid/table responde em 834px; falha de refresh não deixa número sem freshness | EV-03, EV-05, EV-08 | PENDING |
| FE-6003 | FEATURE | P0 | Corrigir Admin, Account e permission/denied states | Admin Owner/Security | FE-0002, FE-2002, FE-3001 | L | role não é inferida de departamento; denied não vaza recurso; session scope é explícito | EV-02, EV-03, EV-05, EV-08 | BLOCKED_HUMAN |
| FE-6004 | FEATURE | P1 | Criar mapa único de copy para status, priority, departments e event types | Content/Design | FE-0002, FE-2006 | M | zero enum cru nas jornadas críticas; textos em português e estados não dependem apenas de cor | EV-02, EV-04, EV-10 | PENDING |

## 13. Epic E7 — hardening, AAA³ evidence e release

| ID | Tipo | Pri | Item | Owner | Dep | Tam | Aceite | Evidência | Status |
|---|---|---:|---|---|---|---:|---|---|---|
| FE-7001 | TASK | P0 | Executar responsive/content stress matrix | QA/Design | FE-3005, FE-4004, FE-5002, FE-6002 | L | long names, homonyms, dense timeline, big numbers, empty, localized, stale e error passam 375/834/1440 | EV-03, EV-10 | PENDING |
| FE-7002 | TASK | P0 | Executar accessibility manual nas jornadas críticas | A11y/QA | FE-2003, FE-2004, FE-3005, FE-5006 | XL | keyboard, focus restoration, names, semantics, contrast, touch, reader, zoom e reduced motion sem critical/serious | EV-05 | PENDING |
| FE-7003 | TASK | P1 | Consolidar motion choreography e reduced-motion | Design/Frontend | FE-1002, FE-2001, FE-3006, FE-7002 | L | todo motion tem job/duration/easing/fallback; nenhum feedback essencial depende da animação | EV-04, EV-05, EV-06 | PENDING |
| FE-7004 | TASK | P1 | Medir performance visual e estabilidade | Performance/QA | FE-1003, FE-3003, FE-7003 | L | LCP/CLS, font loading, asset size, console/network e refresh churn dentro do budget aprovado | EV-06 | PENDING |
| FE-7005 | REVIEW | P0 | Rodar dois critics independentes contra candidate congelado | QA/Evidence | FE-7001, FE-7002, FE-7003, FE-7004 | M | critics têm packet selado, fingerprint comum, decisão, maior gap e limitações; nenhum REJECT material | EV-01, EV-03, EV-07 | PENDING |
| FE-7006 | RELEASE | P0 | Montar release packet e re-auditar frontend | Frontend Lead/QA/Sponsor | FE-7005, FE-0006 | L | FB-01…FB-08 current; traceability, residual risk, decision e próxima ação estão ligados ao candidate | EV-01, EV-07, EV-09 | PENDING |
| FE-7007 | ASSET | P1 | Gerar e comparar variantes de textura/ambient motion com OpenDesign, ComfyUI ou Blender | Design Director/Asset Owner | FE-1007, FE-1006, FE-7003 | L | variantes sintéticas são comparadas em A/B cego; nenhum asset contém copy clínica; manifest e hashes existem antes da integração | EV-03, EV-04, EV-07 | PENDING |
| FE-7008 | TASK | P1 | Integrar mídia aprovada com poster, captions/transcript, pausa, fallback e reduced motion | Frontend/A11y | FE-7007, FE-7004 | M | mídia não bloqueia conteúdo; falha de load mantém hierarquia; prefers-reduced-motion remove loops e conserva significado | EV-05, EV-06 | PENDING |
| FE-7009 | SPIKE | P2 | Avaliar cena 3D/loop Blender como enhancement opcional de materialidade | Design Director/Blender Owner | FE-1007, FE-7007 | L | só avança se o critic demonstrar ganho de hierarquia/identidade; caso contrário é descartado sem dívida | EV-03, EV-07 | PENDING |

## 14. Matriz de dependências resumida

| Epic | Depende de | Libera |
|---|---|---|
| E0 | decisões e source atual | toda evidência current |
| E1 | E0 | primitives e migration |
| E2 | E1 | estados e interações seguras |
| E3 | E0, E1, E2 | todas as rotas responsivas |
| E4 | E2, E3 | valor operacional |
| E5 | E2, E3, E4 e decisões clínicas | workspace e lifecycle |
| E6 | E2, E3, E5 e definições de métrica/role | completude |
| E7 | E3–E6 | candidate e decisão AAA³ |

## 15. Regras de execução

- máximo de 2 itens P0 em IN_PROGRESS por vez;
- nenhum item P1 começa se um P0 de sua dependência estiver sem owner;
- tasks que alteram packages/ui, globals.css ou AppShell são sequenciadas por Frontend Lead;
- builders não fazem o critic do próprio item;
- cada material fix invalida o packet afetado e exige recaptura;
- status BLOCKED_HUMAN não vira PENDING sem decisão registrada;
- status VERIFIED não vira DONE sem integração e regressão;
- falha repetida com a mesma hipótese gera REWORK e revisão do método, não retry infinito;
- nenhuma rota recebe textura/motion de polish enquanto seu estado/keyboard gate estiver falho;
- P2 só entra depois de P0/P1 do mesmo surface terem owner e evidência.
- assets gerados não entram no caminho crítico sem asset role e fallback;
- OpenDesign, ComfyUI e Blender são meios de exploração/produção de mídia, não fonte de verdade clínica;
- qualquer uso de serviço pago, publicação externa ou dado real exige autorização separada;
- texto, status, CTA e dados clínicos permanecem HTML/React acessível, nunca rasterizados.

## 16. Traceability mínima

Cada item deve apontar para:

**Problema → critério FB → wave → item → arquivo/rota → teste/procedimento → evidência → gap/residual risk.**

Vínculo nominal sem procedimento não fecha aceite. Evidência anterior à última mutação é STALE. Um item sem fonte de requisito deve ser marcado maintenance/observed gap, não inventar origem.

## 17. Relatório semanal do backlog

Atualizar:

- itens por P0/P1/P2 e status;
- bloqueios humanos por idade;
- source fingerprint do candidate;
- critérios FB com evidência current;
- rotas/viewports/estados cobertos;
- critic findings por severidade;
- regressões abertas;
- LCP/CLS e a11y status;
- maior gap atual e próxima ação única.

## 18. Fechamento

O backlog está pronto para ser refinado no G0. Não é autorização para começar todos os itens: FE-0002, FE-1003, FE-3001, FE-3002, FE-5001, FE-5004, FE-5006, FE-6001 e FE-6003 precisam de decisões humanas ou contratos aprovados. O primeiro movimento seguro é executar FE-0001, FE-0003 e abrir FE-0002 em paralelo, preservando o repositório e tratando o frontend atual como REJECT até nova evidência.
