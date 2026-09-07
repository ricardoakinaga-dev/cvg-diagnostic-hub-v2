# System Specification

**Status (19/08/2026):** `NORMATIVE SPEC — LOCAL MVP PARTIALLY IMPLEMENTED; NOT PRODUCTION READY`  
**Versão:** 0.1  
**Fonte:** PRD v0.1; decisões ainda condicionadas às `OPEN QUESTIONS` clínicas/operacionais.

## 1. Purpose and boundaries

O sistema é um modular monolith de operação diagnóstica. A unidade de entrada é o `DiagnosticRequest`; a unidade que executa e muda de estado é o `DiagnosticRequestItem`; `DiagnosticService` determina o workflow. Patient/Encounter são referências de contexto, não um prontuário completo.

O sistema deve:

- receber uma solicitação multi-item;
- conduzir o item por um workflow apropriado;
- manter sample/procedure quando necessários;
- produzir e liberar resultado versionado;
- notificar e registrar view/review/acknowledgement;
- apresentar fila, SLA, atraso, timeline e auditoria.

O sistema não deve:

- fazer faturamento, prescrição, agenda clínica geral ou PACS completo;
- usar frontend como autoridade de autorização/estado;
- apagar silenciosamente resultado, amostra ou evento;
- adicionar broker/microservice/Redis sem problema medido.

## 2. Runtime contract

Runtime implementado para o MVP local:

- web/API: Next.js + React + TypeScript em processo modular do mesmo repositório;
- banco: PostgreSQL;
- object storage: file store local no MVP; S3-compatible/MinIO é a evolução de produção;
- realtime: SSE autenticado com snapshot, replay `Last-Event-ID`, reconexão limitada e fallback por reconciliação durável; o adaptador PostgreSQL `LISTEN/NOTIFY` e o fallback process-local estão implementados localmente, enquanto carga multi-instância, operação alvo e aceite clínico permanecem gates abertos;
- fila: outbox/intents persistidos no snapshot PostgreSQL; worker durável ainda é gate de produção.

`DECISION`: a escolha favorece uma equipe pequena, debugging simples e boundaries claros. O snapshot JSONB atual é uma base transacional de MVP, não substitui as tabelas/projeções de produção previstas na migração evolutiva. O ADR de arquitetura deve ser atualizado se benchmark ou equipe mostrarem que outra alternativa é superior.

## 3. Canonical vocabulary

O vocabulário é normativo em [`../GLOSSARY.md`](../GLOSSARY.md). Enums persistidos são estáveis em inglês; a UI traduz para português. O status agregado de request é derivado de item states e não pode contradizer o estado de seus itens.

## 4. Command handling pipeline

Toda command clínica segue a ordem:

1. autenticar sessão;
2. validar schema e enum;
3. carregar recurso pelo ID interno/protocolo com escopo;
4. checar actor + action + resource + current state;
5. validar invariantes e optimistic version;
6. executar mudança em transação;
7. persistir audit/domain event e outbox intent quando necessário;
8. retornar representação atual com `correlationId` e `version`;
9. somente depois atualizar UI/realtime.

## 5. Transaction boundaries

### Release

`release result` precisa, na mesma transação lógica:

- validar draft e versão concorrente;
- criar `result_version` imutável;
- apontar `result.current_version_id`;
- atualizar item para `RESULT_AVAILABLE`;
- invalidar revisão anterior quando emenda;
- criar audit/domain events;
- criar notification/outbox intents.

Se o commit falhar, nenhuma parte deve aparecer como concluída. O worker da outbox pode entregar notificação depois; não deve criar uma segunda liberação.

### Recollection

Rejeição da amostra, motivo, criação/encadeamento de nova amostra, estado dos itens afetados, auditoria e notification intent formam uma unidade transacional. A nova coleta física pode acontecer depois, mas a solicitação de recoleta não fica sem histórico.

### Review

Review verifica que a versão atual continua sendo a versão liberada que o actor viu. Se o resultado foi emendado entre view e review, retorna `409 CONFLICT`/`REVIEW_STALE` e exige nova abertura/revisão.

## 6. Concurrency and idempotency

- Entidades mutáveis possuem `version` inteiro ou equivalente; update inclui `expectedVersion`.
- Conflito retorna `409 CONFLICT` com estado atual mínimo e orientação para recarregar.
- Commands mutativas usam `Idempotency-Key` obrigatório para release, amend, void, recollection, cancel, review, complete e upload finalization; draft/schedule podem usá-lo como proteção adicional conforme endpoint.
- A chave é vinculada a actor + endpoint + payload hash e expira conforme política; payload diferente para a mesma chave é erro.
- Unique constraints protegem protocol, current result version, accession e links.
- Duplo clique não deve gerar dois eventos clínicos ou duas versões.

## 7. Time, locale and ordering

- Persistir `timestamptz` em UTC e obter horário do servidor.
- Exibir no timezone configurado do hospital/usuário com indicação quando relevante.
- Protocolo usa data local operacional, mas sua unicidade é garantida por sequência transacional.
- Filas ordenam por: criticidade, overdue, prioridade, due_at, tempo de espera e desempate estável por `created_at/id`.
- Ordenação deve ser explicável na UI; não esconder a regra em score opaco.

## 8. Request/item relationship

Uma request pode ter vários itens. Item status e result lifecycle são independentes. O request expõe contagens e `aggregate_status`:

| Regra | Aggregate status |
| --- | --- |
| todos os itens ativos estão em `REQUESTED` e não há item em outro estado operacional | `REQUESTED` |
| há item ativo em `SCHEDULED`, `RECEIVED`, `IN_PROGRESS`, `AWAITING_REPORT`, `FAILED`, `RECOLLECTION_REQUIRED` ou `RESULT_VOIDED`, sem resultado liberado/revisado/completed em outro item | `IN_PROGRESS` |
| há item cancelado/rejeitado e outro item ativo ainda em `REQUESTED` | `IN_PROGRESS` |
| há pelo menos um item com resultado/revisão/completed e outro item ativo | `PARTIALLY_AVAILABLE` |
| todos os itens não cancelados/rejeitados têm resultado `RESULT_AVAILABLE` ou `REVIEWED`, mas a `CompletionPolicy` ainda não fechou a request | `RESULTS_AVAILABLE` |
| todos os itens estão em `COMPLETED`, `CANCELLED` ou `REJECTED`, com ao menos um completed | `COMPLETED` |
| todos os itens estão `CANCELLED`/`REJECTED` | `CANCELLED` |

`aggregate_status` é calculado em query/materialização transacional e nunca libera um item porque outro terminou. `RESULTS_AVAILABLE` representa “todos os resultados esperados foram liberados, mas revisão ou fechamento ainda falta”; não é sinônimo de `COMPLETED`.

## 9. Workflow plug-in boundary

Cada `DiagnosticService` declara `workflow_type` (`LABORATORY`, `RADIOLOGY`, `ULTRASOUND`, futuro) e capacidades (`requires_sample`, `requires_schedule`, `allows_attachment`, `result_schema`). O core chama comandos por capability/port; não faz `if department == LAB` espalhado em UI/API.

## 10. Edge-case policy

- alta/transferência: atualizar admission/context ref; manter request/item e notificar novo owner;
- solicitante indisponível: recipient resolver usa equipe/backup configurado, nunca pessoa adivinhada;
- homônimo: exibir espécie, sexo, tutor abreviado e external ID dentro do escopo mínimo;
- equipamento/setor indisponível: registrar pendência/incident note e manter SLA/pausa explícitos;
- arquivo inválido: quarantine; resultado não fica liberado com attachment inseguro;
- erro de rede: estado da UI `UNKNOWN/RETRYING` até confirmar servidor;
- correction after review: nova versão, `needs_re_review=true`, request pode reabrir agregado sem apagar a revisão antiga.

Cancelamento tem regra por fase: `SCHEDULED`, `RECOLLECTION_REQUIRED` e `FAILED` podem ser cancelados com motivo por actor autorizado; `AWAITING_REPORT` só por policy elevada; item com resultado liberado/revisado/completed não é apagado/cancelado casualmente — usa `void`/emenda e fechamento administrativo auditado conforme policy. `VoidResult` sempre muda o item para `RESULT_VOIDED`, invalida a versão corrente sem apagar seu registro, reabre o aggregate como ativo e exige novo draft liberado/revisado ou cancelamento autorizado; notifica destinatários afetados.

## 11. Observability contract

Toda request interna recebe `correlationId`. O log de acesso HTTP atual emite somente evento, nível, componente, método, rota normalizada, status, duração e correlação server-generated; uma correlação controlada pelo chamador é registrada como `external`, nunca com seu valor bruto. Logs de domínio/integração que adicionarem `requestId`, `actorId` pseudonimizado, módulo, action ou error code devem manter a mesma allowlist e redaction. Audit events são separados, imutáveis e consultáveis por suporte autorizado. `/livez` testa processo; `/readyz` testa dependências necessárias para servir tráfego.

## 12. Definition of technical completeness

Uma vertical slice só pode ser marcada pronta quando atende implementação, schema validation, autorização, transação, auditoria, idempotência/conflito, loading/empty/error/partial UI, acessibilidade, teste e documentação relevantes. Isso é detalhado em [`../build/BUILD_PLAN.md`](../build/BUILD_PLAN.md).
