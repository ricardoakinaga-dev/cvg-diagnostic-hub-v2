# Discovery — CVG Diagnostics Hub

**Status:** `COMPLETE — IMPLEMENTED LOCALLY / EXTERNAL GATES OPEN` com perguntas abertas explicitadas
**Data:** 2026-08-23
**Classificação:** `FACT`, `ASSUMPTION`, `DECISION`, `OPEN QUESTION`

## Executive summary

O CVG Diagnostics Hub é uma central operacional para impedir que uma solicitação diagnóstica se perca entre quem solicita, o setor executor e quem precisa agir sobre o resultado. O recorte inicial cobre Laboratório, Radiologia/RX e Ultrassonografia, sem transformar o produto em prontuário, ERP ou PACS.

O problema não é apenas registrar um exame: é tornar visível, em tempo real e com baixo esforço, o percurso completo `solicitação → execução → resultado → liberação → revisão`, incluindo exceções como recoleta, atraso, cancelamento, resultado crítico e correção após liberação.

## Repository reconnaissance

- `FACT`: o repositório é um monólito Next.js 16/TypeScript com `src/app`, `src/components`, `src/server`, `packages/contracts`, `db/migrations`, scripts operacionais, OpenAPI e suítes Vitest/Playwright.
- `FACT`: o runtime local pode usar `MemoryStore`; o modo PostgreSQL tem migrations/readiness e foi exercitado contra um cluster descartável. O snapshot clínico JSONB é uma fronteira transitória explícita, não o modelo relacional hospitalar final.
- `FACT`: as jornadas de solicitação, Lab, recoleta, RX/US, resultados versionados, anexos, notificações, auditoria e administração estão implementadas em grau local demonstrável; a UI ainda é sintética e o seed não representa dados hospitalares reais.
- `DECISION`: Discovery permanece a fonte de problemas, hipóteses e perguntas abertas; a implementação e os limites atuais são detalhados em `docs/architecture`, `docs/build`, `docs/operations` e `docs/TRACEABILITY_MATRIX.md`.
- `OPEN QUESTION`: identidade/ownership do hospital, transferências/alta, política de críticos, fallback, retenção, residência, RPO/RTO, scanner/storage produtivos e carga representativa continuam gates externos.

## Problem statement

Equipes hospitalares precisam descobrir rapidamente quais exames foram solicitados, para qual paciente, em que etapa estão, se estão atrasados ou exigem intervenção e quem precisa tomar conhecimento do resultado. Hoje o briefing indica dependência de memória individual, perguntas entre setores, mensagens paralelas e pouca rastreabilidade; o fluxo real ainda deve ser observado no hospital.

### North Star

> Nenhuma solicitação diagnóstica importante deve se perder entre quem solicita, quem executa e quem precisa agir sobre o resultado.

### Perguntas que o produto deve responder

1. Quais exames estão pendentes agora?
2. Qual paciente está esperando e há quanto tempo?
3. O que está atrasado e qual setor pode agir?
4. Qual resultado acabou de ser liberado?
5. Qual resultado ainda não foi visualizado/revisado?
6. Existe recoleta, pendência ou resultado crítico sem confirmação?

## Evidence map

| Tipo | Conteúdo usado nesta fase |
| --- | --- |
| `FACT` | Reconnaissance do repositório vazio; escopo, setores, fluxos candidatos e princípios explicitamente fornecidos no briefing. |
| `ASSUMPTION` | Forma provável de trabalho atual, papéis concretos, volumes, turnos, SLAs e integração existentes. |
| `DECISION` | Direção de produto proposta para tornar o briefing construível; ainda sujeita a aprovação. |
| `OPEN QUESTION` | Dado cuja resposta muda regra operacional, segurança clínica ou contrato de integração. |

Não há entrevistas, observação de campo, dados de volume ou contrato de HIS fornecidos. As conclusões abaixo são uma base de descoberta, não uma alegação de como o hospital opera hoje.

## Context and stakeholders

Os setores inicialmente citados são Clínica Médica, Emergência, Internação, UTI, Centro Cirúrgico, Laboratório, Radiologia/RX e Ultrassonografia. Gestão, TI, administração e responsáveis por privacidade também participam das decisões de implantação. O detalhamento de necessidades está em [`STAKEHOLDERS.md`](STAKEHOLDERS.md) e as personas em [`PERSONAS.md`](PERSONAS.md).

## Current-state hypothesis

`ASSUMPTION`: o pedido nasce em um atendimento existente, é comunicado ao setor executor e o solicitante descobre o andamento por consulta manual. Resultados podem aparecer em sistemas ou canais diferentes, e a ausência de uma fila única torna atrasos e recoletas difíceis de enxergar.

O sistema não deve reproduzir canais paralelos como fonte de verdade. O primeiro piloto deve observar um fluxo real de Internação + Laboratório e comparar o processo antes/depois.

## Target service concept

O conceito extensível é `DiagnosticService`, não “laboratório”, “RX” ou “ultrassom” codificados no núcleo. Um serviço do catálogo aponta para um workflow especializado:

- laboratório: amostra, recebimento, processamento, resultado estruturado/narrativo e liberação;
- radiologia: fila/encaminhamento, execução, anexos/imagens quando aplicável, laudo e liberação;
- ultrassonografia: agendamento, execução, laudo, liberação e revisão.

O core rastreia request/item/result/notification/audit; cada workflow adiciona dados apenas quando necessários.

## Users and jobs

Os usuários operacionais são solicitantes clínicos, equipes de internação/emergência, técnicos de laboratório, equipes de imagem, gestores e administração/TI. Os jobs completos estão em [`JOBS_TO_BE_DONE.md`](JOBS_TO_BE_DONE.md).

O job central é: “Quando peço um exame para um paciente em atendimento, quero acompanhar o progresso e ser encontrado quando houver algo que exige ação, para não depender de telefonema, WhatsApp ou memória.”

## End-to-end journey inventory

Os fluxos A–G e os casos limite são descritos em [`USER_JOURNEYS.md`](USER_JOURNEYS.md). A descoberta inicial exige pelo menos:

- Laboratório normal;
- recoleta;
- RX;
- Ultrassom com agenda;
- resultado crítico;
- atraso/SLA;
- cancelamento;
- alta, transferência, duplicidade, indisponibilidade, conflito e correção.

## Event Storming result

O Event Storming simplificado está em [`EVENT_STORMING.md`](EVENT_STORMING.md). A decisão de modelagem provisória é tratar `DiagnosticRequest` como agregado de agrupamento e `DiagnosticRequestItem` como unidade operacional, com `Result`/`ResultVersion` e `Sample` como limites próprios quando a regra exigir. Eventos importantes também sustentam a timeline, evitando duas histórias concorrentes.

## Product principles discovered

1. Fewer clicks.
2. Status must be obvious.
3. Important events find the user.
4. Audit important actions.
5. One source of truth.
6. Simple before clever.
7. Safe by default.
8. Extend without rebuilding.

## Discovery decisions

- `DECISION D-001`: o MVP é uma central diagnóstica, não um ERP veterinário.
- `DECISION D-002`: request agrupa itens; cada item tem status/result lifecycle próprios.
- `DECISION D-003`: workflow é configurável por `DiagnosticService`, com especializações para Lab e Imagem.
- `DECISION D-004`: notificações internas são o canal inicial; integrações externas ficam atrás de boundaries.
- `DECISION D-005`: resultados liberados são versionados; correção gera nova versão e nova necessidade de revisão.
- `DECISION D-006`: timeline deriva de eventos/auditoria relevantes, não de um segundo histórico manual.

## Success and learning plan

As métricas propostas, com baseline a medir no piloto, estão em [`SUCCESS_METRICS.md`](SUCCESS_METRICS.md). O primeiro aprendizado deve verificar se a equipe encontra e age sobre pendências com menos comunicação paralela, sem aumentar erro ou burocracia.

## Discovery gate

`READY FOR PRD` significa que o problema, os atores, as jornadas, riscos e desconhecidos foram explicitados. Não significa que políticas clínicas, retenção, volumes ou integrações já foram aprovados. Os itens bloqueantes para produção estão marcados em [`OPEN_QUESTIONS.md`](OPEN_QUESTIONS.md) e voltam como gates no PRD/SPEC.

## Final discovery review

Esta seção responde explicitamente às perguntas de saída exigidas para Discovery. Onde a resposta ainda depende de validação, a lacuna é nomeada — não preenchida por certeza inventada.

| Pergunta | Resposta de descoberta |
| --- | --- |
| Quem solicita exames? | `DECISION/PROPOSAL`: veterinários e equipe de Internação/Emergência autorizados, a partir de um atendimento; OQ-001 valida escopo/role final. |
| Quem recebe cada solicitação? | Laboratório recebe itens laboratoriais; Radiologia/Ultrassom recebem seus serviços; fila/department do catálogo é a atribuição inicial. |
| Quem pode alterar cada estado? | O executor do serviço altera recebimento/processamento/execução; reviewer altera revisão; manager/admin têm overrides documentados na matriz; OQ-002/OQ-017 validam exceções. |
| Como o laboratório controla amostras? | Proposta: accession/sample com estado, vínculo a um ou mais itens e cadeia de substituição; OQ-008 precisa confirmar tubos, identificação e granularidade. |
| O que caracteriza recoleta? | Amostra rejeitada/insuficiente/inadequada com motivo obrigatório, nova amostra encadeada e notificação; não é edição retroativa. |
| Como RX funciona? | Pedido → fila/encaminhamento → execução → aguardando laudo → laudo liberado → revisão; não exige etapas laboratoriais. |
| Como Ultrassom funciona? | Pedido → agendamento → encaminhamento/execução → aguardando laudo → laudo liberado → revisão; agenda mínima e reagendamento são OQ-009. |
| Existe agendamento? | Necessário para serviços cujo catálogo indique `requires_schedule`; Ultrassom é a hipótese inicial, não uma agenda clínica geral. |
| Quem libera resultados? | Usuário executor autorizado por serviço, com override de manager apenas por policy; a resposta final é OQ-002. |
| Quem precisa visualizá-los? | Solicitante, equipe de cuidado e destinatários autorizados do serviço; o escopo real/backup depende de OQ-004/OQ-018. |
| O que significa revisado? | Usuário de cuidado autorizado confirmou a versão corrente após poder visualizá-la; não é sinônimo de liberado, visto ou acknowledgement. OQ-003 valida obrigação por serviço. |
| O que acontece quando o responsável não está disponível? | Resolver para equipe/backup configurado e manter pendência acionável; nunca atribuir silenciosamente a uma pessoa. OQ-004 decide fallback. |
| Como resultados críticos funcionam? | Política aprovada marca a versão, release cria notificação prioritária, destinatário confirma e escalonamento/auditoria permanecem; thresholds e canal são OQ-005/OQ-018. |
| Como SLA é calculado? | Policy version por serviço/prioridade define evento de início, calendário, duração e `due_at`; timestamps server-side preservam cálculo. OQ-006 define os relógios reais. |
| E alta/transferência? | Request/item permanece histórico e acionável, admission/local é atualizado e owner/fallback é notificado; não cancelar automaticamente. OQ-007 valida pós-alta. |
| Como resultados corrigidos funcionam? | Draft pode editar antes do release; após release, `ResultAmended` cria versão imutável, motivo/autor/data, nova comunicação e re-review quando policy exigir. |
| Quais informações são obrigatórias? | Patient + Encounter válidos, pelo menos um serviço ativo, actor/department derivados, prioridade válida; nota é opcional salvo regra do motivo. |
| Quais ações precisam de auditoria? | Criação, transições, sample/recoleta, release/amend/void, view/review/ack crítico, cancel/reject, overrides, upload/download conforme policy, role/config e acesso negado sensível. |
| Quais integrações futuras? | ERP/HIS, identity, EvolutionAPI/WhatsApp, PACS/DICOM, equipamentos/LIS, laboratórios externos; boundaries estão em Architecture, sem implementação no MVP. |
| Quais questões ainda precisam de validação? | A lista normativa é [`OPEN_QUESTIONS.md`](OPEN_QUESTIONS.md), sobretudo criticidade, SLA, ownership, accession, identidade, retenção e canal de alerta. |

## Next phase

Produzir o PRD com requisitos identificáveis, non-goals, MVP, MoSCoW, histórias e acceptance criteria, mantendo as perguntas abertas como critérios de validação e não como fatos inventados.
