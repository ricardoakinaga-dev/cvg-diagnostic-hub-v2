# V2 — fatia vertical de Laboratório estruturado

## Escopo entregue localmente

Esta fatia adiciona suporte técnico executável para um painel sintético de
Hemograma dentro do runtime atual, sem declarar prontidão clínica. O serviço
`HEMOGRAM` referencia uma revisão versionada de painel com analitos, tipos,
unidades, obrigatoriedade e uma faixa de referência explicitamente marcada como
`PENDING_HUMAN_POLICY`.

O caminho implementado é:

```text
template versionado
  → validação pura de observações
  → draft/release/amend do lifecycle existente
  → snapshot de faixa e flag no resultado
  → contrato HTTP/OpenAPI
  → tabela/editor de analitos no resultado
  → jornada browser com round-trip real
```

## Invariantes técnicos

- O servidor valida painel, revisão, analito, duplicidade, completude, tipo e
  unidade; o browser não é a autoridade clínica.
- Flags `NORMAL`, `LOW` e `HIGH` só podem ser derivadas de uma faixa numérica
  configurada. A fixture usada pelo Hemograma não possui limites numéricos,
  portanto os valores ficam `UNINTERPRETED`.
- Nenhum código deriva criticidade, destinatário, prazo de comunicação ou
  escalonamento clínico.
- A faixa usada pelo resultado é copiada para a observação no momento da
  normalização, preservando a revisão aplicada mesmo que o catálogo evolua.
- Draft, release, amendment, void, revisão, idempotência, `expectedVersion`,
  auditoria e outbox continuam sendo os mecanismos existentes.
- Conteúdo legado continua aceito somente para abrir/editar snapshots em
  migração. O release revalida o draft e bloqueia qualquer serviço numérico com
  template ativo que não tenha observações estruturadas completas; a UI também
  não oferece liberação imediata para esse caminho.
- Um serviço Laboratório `NUMERIC_PANEL` novo só pode ser cadastrado com um
  template ativo e versionado. O CRP sintético atual permanece narrativo até
  receber seu próprio painel aprovado.
- Esta fatia não inclui autoria, revisão ou publicação de templates pelo
  usuário: o catálogo local só aceita um serviço numérico quando a definição
  ativa já existe. Isso é um gate fail-closed; a ferramenta de autoria aprovada
  fica para a próxima fatia clínica.

## Contratos e superfícies

- `packages/contracts`: `LaboratoryPanelTemplate`, `LaboratoryAnalyteDefinition`,
  `LaboratoryReferenceRange`, `LaboratoryObservation` e
  `StructuredLaboratoryResultContent`.
- `packages/domain/src/laboratory-result.ts`: validação/normalização pura e
  derivação de flags somente a partir de configuração.
- `GET /diagnostic-services/{serviceId}/result-template`: leitura autenticada e
  escopada do template ativo.
- Draft/update/amend aceitam o conteúdo discriminado
  `LABORATORY_STRUCTURED`; comandos narrativos existentes permanecem
  compatíveis durante a transição, mas não podem atravessar o release de um
  painel numérico ativo.
- `ResultView` mostra painel, unidade, faixa, flag e aviso de política pendente;
  o editor envia valores tipados e não envia flags calculadas pelo usuário.

## Evidência local

- Domínio: `packages/domain/src/laboratory-result.test.ts`.
- Aplicação/catálogo: `src/server/application/workflow-commands.test.ts` e
  `src/server/application/catalog.test.ts`.
- Schema/contrato: `src/server/http/command-schemas.test.ts`,
  `src/server/http/api-contract.test.ts` e
  `src/server/http/openapi-runtime-response.test.ts`.
- Rota e escopo: `src/app/api/v1/[...path]/route.test.ts`.
- UI: `src/components/result-view.test.tsx`.
- Jornada servida: `tests/e2e/clinical-lifecycle.spec.ts`, cenário de editor
  estruturado de Hemograma.

## Gates ainda abertos

OQ-016 precisa aprovar templates, analitos, unidades, obrigatoriedade, ordem e
faixas por espécie/população. OQ-005 precisa aprovar thresholds críticos,
destinatários, fallback e escalonamento. OQ-002/OQ-003/OQ-015/OQ-004/OQ-008
continuam necessários para autoridade, revisão, emenda, fallback e amostra.

Também permanecem fora desta fatia: tabelas relacionais clínicas, Patient
Workspace contextual, painéis de CRP e outras modalidades, realtime específico
de resultado, carga representativa, CI remoto, aceite clínico/manual, produção e
qualquer uso hospitalar.

**Veredito da fatia:** `PASS_WITH_CONDITIONS` para o escopo sintético local,
após reteste pós-crítica e verificação de paridade do contrato; `NOT_READY` para
o programa V2 completo, uso hospitalar e produção.
