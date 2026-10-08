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
- fila: intents gravados atomicamente em `outbox_messages`; worker durável e operação alvo ainda dependem dos gates de produção.

`DECISION`: a escolha favorece uma equipe pequena, debugging simples e boundaries claros. O snapshot JSONB atual é uma base transacional de MVP, não substitui as tabelas/projeções de produção previstas na migração evolutiva. O ADR de arquitetura deve ser atualizado se benchmark ou equipe mostrarem que outra alternativa é superior.

### PROD-101 — autoridade de auditoria (04/10/2026)

No PostgreSQL, `audit_events` é a autoridade append-only para auditoria, timeline, histórico do paciente, busca por responsável, métricas de recoleta/latência de abertura e evidência de abertura antes da revisão. As regras de autorização e os contratos públicos de paginação permanecem aplicados pelo servidor. O `StoreState.auditEvents` contém apenas eventos pendentes durante uma transação; o snapshot persistido e o cache guardam `[]`. Eventos novos e alterações clínicas/outbox são gravados na mesma transação. A evidência `ResultViewed` é consultada pelo mesmo cliente PostgreSQL da revisão. Em memória, o histórico permanece no array, com a mesma interface de consulta.

A migration `013_audit_read_authority` bloqueia a linha de estado, compara todos os campos dos eventos já projetados, insere os ausentes e só então remove o histórico do snapshot. IDs duplicados ou divergências abortam a transação inteira, incluindo o registro da migration. A restrição `runtime_audit_is_transient` rejeita escritores antigos que persistam eventos no array. Não há convivência de versões 012/013: parar app e worker antigos, aplicar a migration e iniciar ambos com o código novo. Antes da migration, o último ponto de retorno é o banco 012 preservado; após a troca, corrigir para frente. Voltar ao código antigo exige, com todos os escritores parados e papel de migration, reconstruir o array integral a partir da tabela e restaurar a fronteira/ledger 012 numa operação coordenada, preservando eventos novos. Não aplicar nem ensaiar essa mudança no ambiente instalado durante desenvolvimento.

### PROD-102 — autoridade do outbox (04/10/2026)

No PostgreSQL, `outbox_messages` é a autoridade para claims, tentativas, dead-letter, replay e métricas de entrega. O snapshot persistido e o cache mantêm `outbox: []`; comandos clínicos usam o array apenas para novos intents até o commit. O worker carrega uma mensagem elegível ou identificada sob lock na mesma transação do estado, sem carregar o histórico processado. Token, dono e validade do lease continuam obrigatórios no fechamento; confirmação durável, atualização da notificação e auditoria conservam os contratos existentes. Dead-letter conserva autorização, motivo operacional e idempotência no servidor.

`event_position` preserva a ordem de criação independentemente do horário alterado pelos retries. O leitor compartilhado recebe no máximo 100 mensagens `PENDING`/`PROCESSED`, o estado clínico e sua versão num único statement PostgreSQL. O filtro de visibilidade e a revalidação da autorização continuam no servidor; cursor fora da janela exige reconciliação. Retenção remove somente mensagens `PROCESSED` fora da janela de idade/quantidade existente, preservando mensagens pendentes, em processamento, falhas e descartadas. As métricas usam contagem/menor horário na tabela. Em memória, o array continua sendo a autoridade, com as mesmas interfaces.

A migration `014_outbox_read_authority` compara todos os campos clínicos/de entrega com os registros existentes, insere os ausentes, preserva registros presentes só na tabela e restaura a ordem do array legado antes de esvaziá-lo. Divergência, ID ausente ou duplicado abortam a migration e o ledger. A restrição `runtime_outbox_is_transient` rejeita escritores antigos. A implantação exige parar app e worker antigos antes da migration; não há convivência 013/014. O último ponto seguro de retorno é o banco 013 preservado. Após a troca, preferir reparo para frente; retorno ao código antigo exige reconstruir o array completo em ordem, restaurar fronteiras/ledger e restrições com escritores parados e papel de migration, preservando claims e mensagens novas. Essa operação não foi aplicada ao stack instalado. O lock global de escrita permanece; a retirada da fila de leituras está no PROD-105.

### PROD-105 — leituras concorrentes e cache por versão (04/10/2026)

No PostgreSQL, leituras clínicas, auditoria, outbox, autorização, atividade, saúde e reconciliação passam diretamente pelo pool, sem aguardar a fila local de escritas. Uma leitura iniciada durante uma escrita pode observar a versão anterior já confirmada pelo MVCC; transações de escrita continuam serializadas e sempre revalidam o estado bloqueado no banco. Backfill e retenção mantêm sua coordenação de escrita. A concorrência física exige `DB_POOL_MAX` ≥ 2 (4 no benchmark); com 1, consultas aguardam o único cliente ocupado por uma transação, sem garantia de paralelismo. Callbacks transacionais usam o estado/cliente fornecido, sem aguardar recursivamente leituras do mesmo store.

`readState` e `readStateSnapshot` consultam primeiro a versão escalar durável. Só reutilizam o snapshot em cache quando a versão coincide e não há invalidação pendente. Desde o PROD-112 o snapshot é congelado e compartilhado por todas as leituras (sem cópia), e um miss aplica as linhas alteradas numa transação REPEATABLE READ; chamadas simultâneas da mesma versão compartilham essa leitura. Uma resposta antiga não substitui uma versão mais nova do cache, nem atende uma chamada que já observou versão posterior. Erro, linha ausente ou versão inválida falham sem servir o cache como fallback. `getState` continua sendo apenas inspeção da última cópia validada.

O `LISTEN cvg_runtime_state_changed` invalida o cache sem carregar dados clínicos. Cada store mantém uma conexão dedicada, pool de tamanho 1, **adicional ao `DB_POOL_MAX`**; não consome a conexão das consultas quando esse limite é 1. Desconexão invalida e tenta reconectar após 5 s; uma notificação perdida não afeta a correção, pois cada hit exige consultar a versão no banco. O listener não é fonte de autorização. O realtime mantém estado, versão e janela limitada do outbox em uma única consulta MVCC; autorização estreita e históricos continuam lendo suas fontes duráveis diretamente. Ao encerrar, novas operações são rejeitadas e o store aguarda leituras/escritas já iniciadas e encerra listener e pools. Não exige migration nova.


### PROD-112 — snapshot compartilhado e armazenamento por entidade (08/10/2026)

O contrato `StoreState` e a autoridade SNAPSHOT continuam; muda a forma física e o custo. As leituras recebem o mesmo agregado congelado (`freezeState`): nenhuma leitura copia o estado, e uma mutação acidental no lugar vira `TypeError` em vez de corromper o cache. Uma escrita só congela as entidades e os arrays que substituiu. As referências entre entidades são resolvidas por índices (`src/server/domain/state-index.ts`) mantidos por array congelado num `WeakMap`: o índice vive o mesmo tempo que o array, e uma escrita reindexa só as coleções que trocou. Arrays ainda em construção dentro de uma transação não estão congelados e caem numa varredura, com o mesmo resultado de `.find`/`.filter` (primeira ocorrência, ordem do array).

A migration `015_runtime_entity_rows` move as 17 coleções restantes para `cvg_runtime_entities(collection, entity_key, position, data, written_version)`, uma linha por entidade, na ordem do array (`position`). `cvg_runtime_state` guarda só versão, trava global de escrita, gatilho de invalidação e cabeçalho escalar (`protocolSequence`); a constraint `runtime_entities_are_external` exige as coleções vazias no documento. A chave é o `id`, ou `JSON.stringify([actorId, scope, key])` para idempotência; a função SQL `cvg_runtime_entity_key` produz a mesma sequência de bytes. A migration valida tipos, chaves e duplicidade e compara cada coleção com o array original antes de esvaziar o documento; qualquer divergência aborta tudo, ledger incluído.

Uma escrita, sob a trava da linha de estado, grava o cabeçalho e depois só as entidades cuja identidade mudou (`writeEntityState`), com a nova versão em `written_version`; remoções apagam a linha e registram `(removed_version, collection, entity_key)` em `cvg_runtime_entity_removals`. A aplicação só acrescenta no fim e substitui no lugar; outra ordem renumera a coleção inteira, mais lento e igualmente correto. Um processo cujo cache está atrás aplica, numa transação REPEATABLE READ, só as linhas com `written_version` maior que a sua versão e as remoções posteriores (`refreshEntityState`). Ele relê tudo quando as remoções de que precisaria foram podadas (`entity_removal_floor`), quando o banco está atrás do cache ou depois de perder a conexão `LISTEN`, porque um restore pode até reutilizar uma versão. A retenção técnica poda remoções com mais de 24 h e avança o piso. O realtime lê o estado e a janela do outbox na mesma transação REPEATABLE READ; a reconciliação relacional exige exatamente a versão visível na transação.

Não há convivência 014/015: parar `proxy`, `app` e `worker`, fazer backup, aplicar a migration e subir o código novo (DEPLOYMENT §4.1). O rollback é o restore do backup. Medições e limites estão no [relatório de escala](../RELATORIO_ESCALA_2026-10-08.md).
### PROD-108 — despacho validado pelo manifesto (04/10/2026)

O transporte resolve cada `operationId` por um registro imutável, composto por handlers públicos, administrativos, clínicos e operacionais. Na inicialização, o registro exige correspondência exata com o manifesto: operação sem handler, duplicidade, handler extra ou não executável e classificação de autenticação divergente impedem sua criação. A correspondência entre método/path e operação permanece no manifesto.

O dispatcher conserva a fronteira central de headers/proxy, identidade do cliente, autenticação, CSRF, credencial temporária, rate limit, erros e observabilidade. Os handlers conservam schemas, autorização, reautenticação, motivo clínico, versão e idempotência no servidor. A extração dos helpers de administração e backfill do PostgreSQL preserva a fila de escrita, os clientes transacionais, locks, checkpoints, cache e encerramento. Não altera contratos HTTP nem exige migration. Testes de arquitetura impedem comparações/switch por `operationId` no transporte e exigem `route.ts` e `postgres-store.ts` abaixo de 600 linhas, mantendo as fronteiras, ausência de ciclos e limite geral de 800 linhas.

### PROD-109 — encerramento do adaptador realtime (04/10/2026)

O adaptador PostgreSQL de wake-up entrega hints somente enquanto aberto e pela aquisição corrente da conexão LISTEN, inclusive quando o pool reutiliza o mesmo client. `close()` desativa a entrega aos assinantes existentes imediatamente, libera as referências dos listeners e encerra conexão/pool. Callbacks retidos de uma aquisição liberada não podem acordar assinantes durante a reconexão nem após o encerramento. Se um assinante iniciar o fechamento durante um fan-out, os demais não recebem aquela notificação. Publicação, reconexão e inscrições posteriores ao fechamento permanecem inertes. Hints continuam sem conteúdo clínico; leitura durável, autorização e replay seguem nas fronteiras existentes, sem migration.

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
