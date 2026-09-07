# Programa executivo frontend AAA³

## CVG Diagnostic Hub — Instrumento clínico vivo

**Versão:** Frontend AAA³ v1.0  
**Data:** 07/09/2026  
**Estado:** PROPOSTA EXECUTIVA / implementação atual REJECT para AAA  
**Fonte primária:** [Relatório de direção e auditoria frontend](../RELATORIO_FRONTEND_STATE_OF_ART_2026-09-07.md)  
**Documentos irmãos:** [Roadmap frontend](FRONTEND_ROADMAP.md) · [Backlog frontend](FRONTEND_BACKLOG.md)

> Este programa define um padrão interno de execução. “Triplo AAA” não é certificação externa, não é promessa clínica e não significa perfeição absoluta. Um resultado AAA³ só pode ser declarado quando houver evidência atual, crítica independente e autoridade humana para os gates que não pertencem ao código.

Este programa é subordinado à barra sistêmica existente em [AAA_2_QUALITY_BAR.md](AAA_2_QUALITY_BAR.md). Um candidato AAA³ frontend pode estar tecnicamente verificado e ainda não ser AAA-READY do produto: governança, políticas clínicas, operação, piloto e release continuam pertencendo ao programa AAA-2.

## 1. Decisão executiva

Investir em um programa frontend dedicado para transformar a base atual em uma central diagnóstica com:

- atenção operacional antes de decoração;
- contexto de paciente e atendimento sempre inequívoco;
- estados clínicos e de interface sem ambiguidade;
- visual próprio, premium e reconhecível;
- mobile composto de verdade, não desktop comprimido;
- componentes acessíveis e server-confirmed;
- motion que explica mudança, frescor e foco;
- evidência versionada por rota, viewport, estado e fonte.

O diagnóstico atual é:

| Dimensão | Situação observada | Decisão executiva |
|---|---|---|
| Produto e hierarquia | contratos fortes de atenção, paciente, request, item, resultado e timeline | preservar e tornar mais visíveis |
| Visual | base coerente, porém card-heavy, pill-heavy e pouco proprietária | reconstruir sistema visual incrementalmente |
| Mobile | rail fixo comprime a área principal; críticos independentes rejeitaram 375px | tratar mobile como composição própria antes do polish |
| Estados | Patient Workspace é mais desenvolvido que as demais rotas | criar uma autoridade comum de stale, erro, parcial e unknown |
| Acessibilidade | automação parcial e bons focos em alguns dialogs; gaps em tabs, toggle, popover e targets | tornar acessibilidade gate de comportamento |
| Motion | transições, shimmer e spin dispersos | criar gramática com tokens e teste de reduced motion |
| Evidência | packet visual v9 stale para o source atual | recapturar baseline antes de aprovação |

**Veredito:** a direção deste programa é **CONDITIONAL PASS / REVIEW REQUIRED**. A implementação frontend atual continua **REJECT para AAA / State of Art**, conforme os dois críticos independentes registrados no relatório-base.

## 2. O que significa AAA³

AAA³ é a forma executiva de lembrar que uma interface clínica precisa passar por três provas diferentes. Os eixos são independentes: um pode estar verde e outro bloqueado.

### A1 — Assurance: verdade e segurança de interação

O frontend deve mostrar o que o sistema sabe, não o que seria conveniente supor.

Inclui:

- identidade paciente + encounter/admission;
- status real do item, sem colapsar tudo em “pendente”;
- view, review, acknowledgement e completed distintos;
- stale, partial, degraded, offline, denied, conflict e unknown;
- permissões tratadas como affordance, nunca como autorização;
- ações sensíveis pending → confirmed/failed/unknown;
- foco, teclado, leitor de tela, zoom, touch, contraste e reduced motion;
- textos operacionais em português claro, sem códigos crus.

**Gate A1:** nenhum achado crítico/alto aberto em verdade de estado, contexto, autorização visual, acessibilidade das ações ou recuperação.

### A2 — Aesthetics: excelência visual e ergonômica

O frontend deve parecer um instrumento digital diagnóstico, não um template genérico.

Inclui:

- direção Instrumento clínico vivo;
- tokens semânticos de cor, spacing, radius, layering e motion;
- tipografia local com diacríticos e numerais tabulares;
- icon system consistente;
- surfaces com profundidade controlada;
- textura code-native, discreta e semântica;
- botões customizados com estados completos;
- hierarquia attention-first;
- layouts dedicados para 375–390, 768–834 e 1280–1440;
- motion curto, compositado e interrompível.

**Gate A2:** dois críticos independentes não encontram gap material de hierarquia, visual language, responsividade ou polish no packet atual.

### A3 — Accountability: evidência e evolução

O programa deve provar a qualidade do artefato exato que será integrado.

Inclui:

- source fingerprint ligado ao packet;
- screenshots por rota, role, viewport e estado;
- keyboard/focus/reader/touch/zoom/reduced-motion;
- console, network, LCP e CLS;
- stress de copy, números, timelines e localidade;
- token/asset/font audit;
- crítica independente sem contexto herdado;
- ledger de gaps e re-auditoria;
- nenhum PASS derivado de código, packet stale ou resumo do builder.

**Gate A3:** todas as exigências obrigatórias possuem evidência CURRENT e nenhum crítico independente retorna REJECT.

## 3. Resultado contratado

### Resultado de negócio e operação

Ao final do programa, um usuário autorizado deve conseguir abrir a central, reconhecer a atenção mais importante, confirmar o paciente/contexto, executar a próxima ação e recuperar-se de erro ou desatualização sem adivinhar o que aconteceu.

### Resultado técnico/frontend

- uma fundação de UI compartilhada em packages/ui;
- AppShell responsivo com modelo mobile definido;
- design tokens semânticos e tipografia controlada;
- primitives de ação, estado, overlay, tab, tabela e feedback;
- superfícies públicas migradas por slices verticais;
- route/state/viewport matrix atual;
- pacote de evidência reproduzível;
- checklist AAA³ com status por critério;
- backlog e roadmap vivos, sem estado DONE sem evidência.

### Resultado visual

O usuário percebe:

1. **Agora:** o que exige atenção;
2. **Contexto:** em qual paciente, item e versão está;
3. **Instrumentação:** quão atual, permitido e recuperável é o dado.

O produto não deve ser validado por “parece bonito” isoladamente. A estética é considerada bem-sucedida quando melhora scan, decisão, confiança, recuperação e reconhecimento de estado.

## 4. Objetivos e resultados-chave

As metas abaixo são PROPOSED até serem congeladas no primeiro gate. A linha “baseline” representa o relatório de 07/09/2026, não uma medição de runtime atual.

| Objetivo | Resultado-chave | Baseline | Meta executiva | Evidência |
|---|---|---|---|---|
| O1. Restaurar leitura mobile | todas as rotas críticas têm composição 375–390px com ação e contexto preservados | rail fixo e renders stale | 100% da matriz crítica sem squeeze ou overflow de ação | EV-03, EV-05 |
| O2. Criar uma linguagem visual própria | tokens, type, icons, surfaces, buttons e states convergem | 29 custom properties; Surface é o principal primitive | 0 raw color crítico fora de tokens; 100% primitives críticas usando contratos semânticos | EV-04 |
| O3. Tornar estados confiáveis | todas as rotas públicas preservam snapshot, stale, erro, parcial e unknown conforme aplicável | cobertura desigual entre Patient Workspace e demais rotas | 100% das rotas críticas com estados definidos e testados | EV-08, EV-09 |
| O4. Atingir acessibilidade operacional | interações essenciais funcionam por teclado, touch e leitor | Axe parcial; manual NOT RUN; gaps em tabs/toggle/popover | 0 critical/serious; 100% jornadas críticas com keyboard/focus manual; targets críticos ≥44px | EV-05 |
| O5. Dar função ao motion | cada movimento possui intenção, duração, reduced-motion e fallback | tempos dispersos, shimmer e spin | 100% motion tokens; 0 feedback essencial dependente apenas de animação | EV-06 |
| O6. Provar o artifact real | packet fica ligado ao source atual e recebe crítica independente | v9 stale para hashes atuais | 100% gates com fingerprint, evidência e critic fresco | EV-01, EV-03, EV-07 |
| O7. Preservar performance percebida | visual não cria layout shift ou custo desnecessário | Web Vitals atuais NOT RUN neste ciclo | LCP ≤2,5s e CLS ≤0,10 no orçamento inicial PROPOSED; baseline e ambiente documentados | EV-06 |
| O8. Entregar por slices | cada marco é demonstrável sem big-bang rewrite | globals.css monolítico e UI thin | cada wave fecha uma superfície e uma evidência integrada | EV-03, EV-08 |
| O9. Usar mídia com intenção | imagens/vídeo só entram quando aumentam compreensão ou identidade | nenhum asset gerado como parte do baseline atual | 100% dos assets integrados têm role, proveniência, budget, fallback e a11y | EV-04, EV-05, EV-06 |

Valores de LCP/CLS são orçamento inicial de programa, não medição realizada nem promessa de produção. Se o ambiente hospitalar exigir metas mais fortes, congelar a revisão antes do próximo gate.

## 5. Escopo

### Dentro

- src/app, src/components, src/features e packages/ui;
- rotas públicas documentadas;
- design tokens, typography, iconography, CSS architecture;
- state components, responsive layout, motion, interaction and accessibility;
- synthetic fixtures and visual evidence;
- E2E/component checks that exercise frontend boundaries;
- copy mapping needed to remove raw operational codes;
- performance perceived by font/media/motion/layout.

### Fora

- banco, API, worker, outbox, SSE protocol ou storage como implementação;
- definição de política clínica, critical threshold, ownership, SLA, retention ou break-glass;
- identidade institucional real ou decisão de roles;
- deploy, produção, contratação de fornecedor e piloto clínico;
- geração de conteúdo clínico real;
- raster art ou dependência visual externa sem asset role, licença e proveniência.

Contratos de backend que a interface precisa respeitar aparecem como entradas, estados e evidência; eles não são backlog de implementação frontend deste programa.

## 5.1 Trilha de mídia e geração visual

O usuário autorizou o uso de OpenDesign, ComfyUI e Blender para imagens e vídeo. Essa autorização entra no programa como capacidade opcional, não como obrigação de adicionar mídia.

| Capacidade | Uso recomendado | Limite |
|---|---|---|
| OpenDesign | estudos editáveis de composição, moodboards, art direction, exploração de shell e superfícies | não substitui o source React/CSS nem vira a fonte de texto clínico |
| ComfyUI | textura raster, ambient loop, material de fundo, variações de textura e vídeo curto | somente assets com papel/proveniência/budget; sem dados clínicos, texto essencial ou claims gerados |
| Blender | materialidade 3D, objeto técnico abstrato, cena/loop quando profundidade acrescentar compreensão | não adicionar 3D por ornamentação; render precisa de câmera, escala, material, poster e fallback |

### Regras de uso

- CSS/SVG permanece o primeiro meio para grid, trace, rail texture, ícones, dividers e geometria de UI;
- qualquer raster ou vídeo recebe asset role, prompt/brief, seed ou versão quando disponível, tool, timestamp, hash, licença/proveniência e uso pretendido;
- imagens não carregam nomes de pacientes, resultados, status, copy de erro, CTA ou qualquer conteúdo clínico obrigatório;
- vídeo precisa de poster, captions/transcript quando informativo, controle de pausa, fallback estático e caminho de reduced motion;
- textura e loops ficam fora do caminho crítico de leitura e nunca podem reduzir contraste;
- assets devem ter budget de bytes, dimensões, formato, lazy loading e comportamento em conexão lenta;
- OpenDesign/ComfyUI/Blender podem produzir exploração, mas a aprovação continua sendo do packet visual e da crítica independente;
- geração de mídia não autoriza publicação externa, gasto em serviço pago, uso de dados reais ou alteração irreversível;
- o primeiro candidato AAA³ deve funcionar com mídia desligada; se o asset não carregar, a hierarquia e a ação permanecem intactas.

### Gate de mídia

Mídia só entra em uma rota quando:

1. o surface owner declara o papel da mídia;
2. o Design Director registra por que CSS/SVG não basta;
3. QA inspeciona bytes, proporção, contraste, poster/fallback e console/network;
4. A11y valida reduced motion, alt/semântica, captions e pausa;
5. a crítica independente verifica se a mídia melhorou hierarquia em vez de competir com ela.

## 6. Princípios de execução

1. **Ação antes de atmosfera.** A textura só entra depois que a hierarquia está clara.
2. **Context lock antes de CTA.** Paciente, encounter e item precisam estar confirmados visualmente.
3. **Estado visível.** Loading, stale, denied, unknown e partial são produto.
4. **Progressive disclosure sem esconder segurança.** Detalhe pode colapsar; identidade e status não.
5. **Mobile próprio.** Não reduzir desktop até caber.
6. **Motion com job.** Toda animação explica continuidade, foco, causa/efeito ou progresso.
7. **One source of truth.** Lista, drawer, dashboard e workspace não inventam status independentes.
8. **Evidência antes de adjetivo.** “Premium”, “AAA” e “State of Art” nunca substituem packet atual.
9. **Migração reversível.** Aliases e slices antes de apagar classes do globals.css.
10. **Nenhum PASS por média.** Critical/high e gates obrigatórios bloqueiam independentemente de score visual.

## 7. Modelo operacional e papéis

Os nomes abaixo são papéis propostos. O patrocinador deve nomear pessoas reais antes do primeiro gate.

| Papel | Responsabilidade | Pode bloquear avanço? |
|---|---|---|
| Sponsor/Product Owner | escopo, capacidade, prioridade e liberação do programa | sim, no escopo e release |
| Frontend Lead | arquitetura de UI, integração, sequência e regressão | sim, no contrato técnico |
| Design Director | thesis, visual system, responsive hierarchy e review visual | sim, no A2 |
| UX/A11y Lead | jornadas, semântica, keyboard, reader, touch e reflow | sim, no A1 |
| QA/Evidence Lead | packet, ledger, fixtures, stale/freshness e reexecução | sim, no A3 |
| Frontend Engineers | implementação por slice e evidência local | não autoaprova |
| Clinical/Product Authority | copy, ownership, critical/review/completed e contexto | sim, em decisões de domínio |
| Platform/Security consultado | contratos de sessão, realtime, attachments e recovery | veto no limite de segurança |

### RACI resumido

| Entrega | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| tokens/type/icons | Frontend + Design | Frontend Lead | A11y, Product | toda equipe |
| mobile navigation | Frontend + Design | Product Owner | A11y, usuários | toda equipe |
| state authority | Frontend | Product/Clinical Authority | Platform, QA | Design |
| visual packet | QA/Evidence | Frontend Lead | Design, A11y | Sponsor |
| critic independente | Critic externo ao builder | QA/Evidence | Design, Product | Sponsor |
| release AAA³ | Sponsor + Product | autoridade de release | todos os gates | organização |

## 8. Governança e cadência

- **Daily 15 min:** bloqueios e risco P0/P1; não é status theater.
- **Design review duas vezes por semana:** tokens, flows, state matrix e renders.
- **Demo semanal:** rota real, fixture sintético, estado de erro e packet parcial.
- **Quality review no fim de cada wave:** critérios binary/anchored, não opinião vaga.
- **Decision council semanal:** resolve OPEN QUESTION de navegação, ownership, critical, SLA e copy.
- **Independent review por marco:** o builder não aprova seu próprio trabalho.
- **Rebaseline somente com motivo:** mutation, mudança de contrato ou evidência inválida geram novo fingerprint e marcam evidência anterior STALE.

## 9. Gates executivos

| Gate | Pergunta | Saída obrigatória | Estado de entrada |
|---|---|---|---|
| G0 — Truth & Baseline | sabemos o que está sendo redesenhado e contra qual artifact? | decisões mínimas, fingerprint, route/state/viewport matrix e baseline fresco | atual REJECT / STALE |
| G1 — Foundation | os primitives têm contratos de visual, estado e acessibilidade? | tokens, type, icons, ActionButton, feedback, overlay, tabs e table foundations | G0 |
| G2 — Shell & Mobile | a aplicação é navegável e legível em 375/834/1440? | shell, nav mobile, context lock, boundaries, focus e no overflow | G1 |
| G3 — Operational Core | atenção e filas levam a próxima ação segura? | overview, command center, queue, filter, drawer, stale/realtime cue | G2 |
| G4 — Clinical Workspace | paciente, request, result e notification mantêm lineage e estado? | workspace, versions, review, attachments, critical inbox | G3 + decisões clínicas |
| G5 — Admin & Completeness | superfícies secundárias têm a mesma linguagem e verdade? | indicators, management, admin, account, login e copy localization | G4 |
| G6 — AAA³ Release Candidate | o artifact exato passa a barra e a crítica? | fresh packet, manual checks, performance, two critics and traceability | G5 |

Nenhum gate avança por data. Um gate pode ter preparação paralela, mas sua saída é condicional à evidência listada.

## 10. Riscos executivos e respostas

| Risco | Sinal | Resposta | Stop condition |
|---|---|---|---|
| redesign vira decoração | hero/KPI antes da atenção; motion sem job | voltar ao hierarchy audit e congelar A2 | atenção ainda não é a primeira leitura |
| política aberta vira CTA definitivo | permissões/critical/SLA sem owner | marcar BLOCKED_HUMAN; prototipar com estado neutro | decisão de domínio é necessária para ação |
| packet stale é reutilizado | hash de source não coincide | invalidar e recapturar | nenhuma aprovação com evidência stale |
| global rewrite aumenta regressão | muitas classes/rotas mudam juntas | migration slices + aliases | diff cruza mais de uma boundary sem prova |
| mobile fica desktop comprimido | rail permanece, labels caem, overflow | bottom nav/menu sheet e teste intermediário | 375/834 falham leitura ou ação |
| A11y fica para o final | tabs/toggle/popover sem semântica | primitives primeiro e manual por wave | qualquer jornada crítica keyboard-inoperable |
| motion piora performance | layout shift, shimmer pesado, refresh storm | budget, composited props, perf evidence | LCP/CLS ou refresh churn acima do orçamento |
| backlog perde o foco | P2 cosmetic antes de P0/P1 | WIP limit e reorder por gap | item P0/P1 fica sem owner/next action |

## 11. Capacidade e investimento

### Modelo recomendado

- 1 Frontend Lead;
- 2 Frontend Engineers;
- 1 Design Director/Designer de produto parcial;
- 1 QA/Evidence;
- 1 UX/A11y parcial;
- Product/Clinical Authority com janela semanal;
- Platform/Security consultado nos contratos.

Esse é um modelo de capacidade, não atribuição real. Caso a equipe seja menor, reduzir WIP e alongar o calendário; não remover gates críticos.

### Faixa de execução

O roadmap usa waves e gates porque capacidade e decisões humanas ainda são UNKNOWN. Uma referência de 16–20 semanas pressupõe o modelo acima, decisões disponíveis e nenhum bloqueio externo prolongado. A faixa não é compromisso de release.

## 12. Primeiros 10 dias úteis

1. Confirmar sponsor, Frontend Lead, Design Director, QA/Evidence e authority clínica.
2. Fixar a definição AAA³ e os oito FB criteria do relatório.
3. Registrar decisão da navegação mobile: bottom nav, menu sheet ou alternativa aprovada.
4. Resolver owner/role/context lock mínimo para protótipo e copy.
5. Capturar source fingerprint e produzir packet fresco das rotas críticas.
6. Criar fixtures de long content, partial, stale, denied, unknown e request multi-item.
7. Medir baseline de 375, 834, 1440, focus, targets, LCP/CLS e console/network.
8. Criar visual contract de tokens, type, icon, surface, button e motion.
9. Criar o primeiro slice vertical: shell + ActionButton + FeedbackBanner + um route.
10. Realizar review independente de G0 e reordenar o backlog por evidência.

## 13. Definition of Ready

Um item está READY quando:

- objetivo e boundary estão claros;
- fonte/contrato está linkado;
- dependency está provada;
- owner está nomeado;
- acceptance é observável;
- evidence method está definido;
- não depende de decisão humana ainda aberta, ou a dependência está explicitamente mockada como fixture;
- escopo de arquivos/rotas é conhecido;
- regression surface está identificada.

## 14. Definition of Done

Um item não é DONE apenas porque o código foi escrito. Exige:

- implementação integrada no boundary correto;
- testes focados quando aplicável;
- render/interação real quando visual;
- estado normal e falha exercitados;
- keyboard/focus/reduced motion proporcional ao risco;
- evidence digest com artifact e fingerprint;
- revisão de outra pessoa para material work;
- docs/backlog/traceability atualizados;
- nenhum gap crítico/alto criado;
- status VERIFIED ou DONE somente após o gate que o possui.

## 15. Painel executivo de acompanhamento

Atualizar semanalmente:

| Indicador | Alvo |
|---|---:|
| P0/P1 sem owner | 0 |
| Critérios FB obrigatórios com evidência CURRENT | 100% no G6 |
| Rotas críticas × viewports × estados cobertos | 100% no G6 |
| Controls críticos abaixo de 44px | 0 |
| Raw colors críticos fora de tokens | 0 |
| Critical/serious accessibility findings | 0 |
| Source packet stale | 0 no candidato |
| Independent critics REJECT no candidato | 0 |
| Regressões funcionais abertas | 0 antes de G6 |
| Decisões humanas vencidas sem resposta | 0 no caminho crítico |

Não usar quantidade de cards, número de commits, linhas de CSS ou contagem de testes como substitutos desses indicadores.

## 16. Decisões que ainda exigem autoridade

- navegação final por role e departamento;
- identidade e prevenção de homônimos;
- owner, transferência, alta e break-glass;
- semântica definitiva de reviewed, acknowledged e completed;
- thresholds, destinatários e fallback de critical;
- calendário e regras de SLA;
- fonte e licença aprovadas;
- browsers, devices e tecnologias assistivas do aceite;
- política de release e piloto.

O programa pode preparar mecanismos e fixtures; não pode inventar essas decisões.

## 17. Veredito do plano

O programa executivo está **PRONTO PARA MOBILIZAÇÃO DOCUMENTAL**, não para declarar release. O próximo passo obrigatório é G0: decisão de contexto + baseline visual fresco + contrato de evidência. Sem G0, qualquer polish será risco de retrabalho; com G0, o trabalho pode seguir em slices pequenos, demonstráveis e reversíveis.
