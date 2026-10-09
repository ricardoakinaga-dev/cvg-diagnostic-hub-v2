# Arquivamento clínico e expurgo (PROD-501)

**Knowledge status:** `DECISION` (D5, 08/10/2026) para o arquivamento após 24 meses; o prazo legal de guarda que autoriza o expurgo é `OPEN QUESTION` do jurídico e o expurgo fica desligado até ele ser definido.

Decisão D5: **24 meses ativo, depois arquivo; exclusão no fim do prazo legal**. Este documento descreve o que é arquivado e quando, o que permanece, como executar e consultar, a política de expurgo, a remoção dos anexos no S3 e a evidência. O desenho está registrado em [D-038](../DECISION_LOG.md).

## 1. O que é arquivado e quando

Uma solicitação é arquivada quando **todas** as condições valem:

- o estado agregado é `COMPLETED` ou `CANCELLED`;
- todo exame da solicitação está em estado final: `COMPLETED`, `CANCELLED` ou `REJECTED`; um exame `RESULT_VOIDED` só conta como final se todos os resultados dele estão invalidados e não há rascunho mais novo;
- a última atividade (`updatedAt` da solicitação, `completedAt` dos exames, criação e liberação das versões de resultado) é **anterior a `agora − ARCHIVE_ACTIVE_MONTHS` meses** (padrão 24, em meses de calendário UTC);
- nenhuma notificação da solicitação está `PENDING`, `DELIVERED`, `SEEN` ou `ESCALATED`;
- todos os anexos estão `FINALIZED` (nenhum upload em andamento).

Junto com a solicitação saem do agregado ativo, na mesma transação, os exames, amostras, procedimentos, agendas, resultados, versões de resultado, notificações e anexos (metadados) dela. Cada entidade vira uma linha em `cvg_clinical_archive`, agrupada por `request_id`, com a posição original, o JSON completo, a data e o lote. O lote fica em `cvg_clinical_archive_batches` (data, corte, contagens, ator).

## 2. O que permanece

- **Pacientes, atendimentos, internações, usuários, serviços e motivos** nunca são arquivados: o arquivo aponta para eles.
- **Auditoria** (`audit_events`) é append-only e não é arquivada nem expurgada. O arquivamento grava **um** evento `ClinicalRecordsArchived` por lote (entidade `ClinicalArchive`, id do lote, contagens e corte); o evento não lista solicitações nem dados clínicos. O expurgo grava `ClinicalArchivePurged`, também só com contagens.
- **Idempotência, sessões e outbox** seguem a retenção técnica (DEPLOYMENT §6.2), não o arquivo.
- Os objetos de anexo no S3 **não são movidos nem apagados** no arquivamento: continuam no mesmo bucket e só saem no expurgo.

Efeito no sistema: o agregado em memória e o snapshot ficam limitados a cerca de dois anos de exames. Telas de fila, busca, painel e timeline mostram só o que está ativo; o que foi arquivado é lido pelas duas consultas da seção 4.

## 3. Executar

O worker do outbox roda o arquivamento uma vez por `ARCHIVE_INTERVAL_MS` (padrão 24 h, mínimo 1 h), logo depois da retenção técnica, e escreve `clinical.archive_applied` (só contagens) quando algo foi arquivado. Para executar ou ensaiar sob demanda:

```bash
# ensaio (padrão): mostra o que seria arquivado, sem gravar nada
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm worker npm run runtime:archive -- --dry-run

# aplicar
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm worker npm run runtime:archive -- --apply

# janela diferente só nesta execução (por exemplo, 36 meses)
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm worker npm run runtime:archive -- --dry-run --months 36
```

A saída é um JSON com o corte, as contagens (solicitações, entidades, anexos) e os ids das solicitações. O ensaio lê o agregado em cache e não toma a trava de escrita. A aplicação é uma única transação: insere as linhas no arquivo, remove as linhas ativas (registrando as remoções para os outros processos) e grava o evento de auditoria; se qualquer passo falha, nada muda. Uma execução sem nada a arquivar não grava lote nem evento.

Recomenda-se rodar o ensaio e conferir as contagens antes de ligar o job no primeiro ambiente com dados antigos. Para desligar o job, defina `ARCHIVE_ACTIVE_MONTHS=0`.

## 4. Consultar

| Consulta | Rota | Permissão e escopo |
| --- | --- | --- |
| Exames arquivados de um paciente | `GET /api/v1/patients/{patientId}/archive?limit=` (`listPatientArchive`) | `patient.view` e `diagnostic.timeline.view`, no mesmo escopo de `getPatientDiagnostics`; o resumo de cada solicitação lista só os exames (e conta só os anexos) que o perfil veria na leitura ativa, e o escopo é aplicado **antes** do `limit` (AUD-05/08); fora do escopo responde 404 |
| Uma solicitação arquivada | `GET /api/v1/archive/requests/{requestId}` (`getArchivedRequest`) | `request.view`, no escopo da solicitação; **todo** perfil vê só os exames que veria na leitura ativa (`item.view` por setor e serviço do item: executores pelo seu serviço, gestores pelos setores delegados, clínicos pelos pacientes atribuídos), e resultados, versões, amostras e anexos derivam só desses exames (AUD-05); fora do escopo responde 404 |

Nenhuma leitura percorre o arquivo inteiro: as duas lojas recusam uma consulta sem paciente, sem solicitação e sem `limit` (`CLINICAL_ARCHIVE_QUERY_UNBOUNDED`), e um `limit` que não seja inteiro positivo (`CLINICAL_ARCHIVE_QUERY_INVALID_LIMIT`).

A segunda rota devolve a solicitação, os exames, os resultados e as versões **liberadas, substituídas ou invalidadas** (conteúdo e narrativa), as amostras e os metadados dos anexos; rascunhos e chaves de armazenamento nunca saem. É somente leitura: não há rota de escrita sobre o arquivo.

Na interface, a área do paciente tem a seção recolhida **Arquivo (exames com mais de 24 meses)**, que só consulta o servidor quando é aberta e leva a `/archive/{requestId}`, página com o aviso "Somente leitura — registro arquivado".

## 5. Expurgo e prazo legal

O expurgo existe, mas **fica desligado** enquanto o prazo legal de guarda não estiver definido pelo jurídico (backlog PROD-501, pergunta aberta de D5). Sem `ARCHIVE_PURGE_AFTER_MONTHS` (ou com `0`), o worker e o CLI não apagam nada e o CLI recusa `--purge`.

Para ligar quando o jurídico definir o prazo (em meses, contado **a partir da data de arquivamento**):

1. registrar o prazo e a data da decisão em `docs/DECISION_LOG.md`;
2. definir `ARCHIVE_PURGE_AFTER_MONTHS=<meses>` em `.env.production` e recriar o `worker`;
3. antes da primeira execução real, ensaiar: `npm run runtime:archive -- --dry-run --purge` informa quantas solicitações, entidades e objetos seriam removidos;
4. aplicar com `--apply --purge` ou deixar o worker agir na próxima cadência.

O expurgo apaga as linhas de `cvg_clinical_archive` das solicitações arquivadas há mais de `ARCHIVE_PURGE_AFTER_MONTHS` meses (até 5.000 solicitações por execução; o restante sai na seguinte), grava `ClinicalArchivePurged` e **devolve as chaves dos anexos** dessas solicitações. O lote (`cvg_clinical_archive_batches`) e a auditoria permanecem como prova de que o arquivamento e o expurgo ocorreram.

### Objetos no S3

Depois do expurgo confirmado no banco, o job chama `FileStore.remove` para cada chave de anexo (S3 ou armazenamento local). Uma falha de remoção **não derruba o job nem desfaz o expurgo**: o job registra `clinical.archive_object_removal_failed` com o prefixo `attachments/<resultId>` (nunca o nome do arquivo) e conta `objectRemovalFailures` no log `clinical.archive_applied`. Como as linhas já foram apagadas, o objeto órfão deve ser removido manualmente pelo prefixo registrado. Se o bucket usa versionamento (PROD-307), a remoção cria um marcador de exclusão: a regra de ciclo de vida do bucket precisa expirar também as versões não correntes no mesmo prazo, senão o conteúdo continua recuperável.

## 6. Variáveis de ambiente

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `ARCHIVE_ACTIVE_MONTHS` | `24` | Meses em que a solicitação concluída permanece ativa. `0` desliga o arquivamento. |
| `ARCHIVE_INTERVAL_MS` | `86400000` (24 h; mínimo 1 h) | Cadência do job no worker. |
| `ARCHIVE_PURGE_AFTER_MONTHS` | vazio | Prazo legal em meses a partir do arquivamento. Vazio ou `0`: nunca expurgar. |

## 7. Banco, papéis e backup

- Migration `017_clinical_archive` cria `cvg_clinical_archive` e `cvg_clinical_archive_batches` (aditiva, sem cutover; o registro de versões do runtime avança para ela). O papel `cvg_runtime` recebe `SELECT`, `INSERT` e `DELETE` nas duas tabelas e **não** pode `UPDATE`, `TRUNCATE`, `ALTER` nem `DROP` (`db:roles`; teste de privilégios negativos em `tests/postgres`).
- As linhas arquivadas fazem parte do banco: entram no `pg_dump` do backup diário e na restauração ([BACKUP_RESTORE](BACKUP_RESTORE.md)).
- O runtime relacional em sombra (`createWithRelationalClinicalCore`) não suporta arquivamento nem expurgo e recusa as chamadas.

## 8. Evidência

- Testes unitários da política (`clinical-archive-policy.test.ts`), das lojas em memória e PostgreSQL simulada, do job, do CLI, do serviço de leitura, da rota e da interface.
- `tests/postgres/clinical-archive.integration.test.ts`, em PostgreSQL 16 descartável: migration, arquivamento atômico com remoções registradas, outro processo atualizando sem a solicitação arquivada, rollback quando a inserção falha, consultas por paciente e por solicitação, expurgo com devolução das chaves e papel de runtime sem `ALTER`/`DROP`/`UPDATE`.
- Prova no hospital, antes de ligar o expurgo: ensaio com `--dry-run`, conferência de uma solicitação arquivada pela tela e restauração de um backup contendo o arquivo.
