# V2 — contrato do Patient Workspace

## Estado da decisão

**SPEC congelada para implementação local — 05/09/2026.** Este documento
define a próxima fatia vertical do V2. Ele não é aceite clínico, não concede
autoridade hospitalar e não representa prontidão para produção.

O workspace preserva a rota existente `GET /patients/{patientId}/diagnostics`
e adiciona uma projeção `workspace` ao mesmo envelope. A compatibilidade evita
uma segunda fonte de verdade e mantém os consumidores legados funcionando.

## Objetivo do slice

Dar ao profissional uma visão contextual, escopada e acionável de um paciente
sem transformar a UI em autoridade clínica. A leitura precisa reunir, no mesmo
snapshot servidor:

```text
patient
  → encounter/admission atuais
  → requests paginadas
  → items visíveis + contexto operacional
  → sample/result/attachment summaries vinculados
  → próximos passos e timeline auditável
```

O workspace mostra somente recursos que o ator pode consultar. Um item oculto
não aparece como linha vazia, contador, amostra, resultado, anexo ou evento
indireto.

## Shape público congelado

O payload existente continua obrigatório: `patient`, `encounters`,
`admissions`, `items`, `events`, `nextActions`, `limit` e `total`; `nextCursor`
continua opcional. A nova propriedade `workspace` é obrigatória para respostas
novas:

`admissions` mantém o shape legado da rota para compatibilidade. A regra de
minimização abaixo se aplica à projeção `workspace`, em especial a
`workspace.currentContext`; consumidores novos devem preferir essa projeção e
não depender de detalhes internos do shape legado.

`items` continua paginado pela rota existente. `workspace.summary`,
`nextActions` e `events` representam o conjunto autorizado completo da leitura,
não somente a página retornada; `asOf` é comum a essa projeção.

```ts
workspace: {
  asOf: string; // snapshot do servidor em ISO-8601
  currentContext: {
    encounterId: string | null;
    admissionId: string | null;
    departmentCode: string | null;
    ward: string | null;
    bed: string | null;
    responsibleLabel: string | null;
  };
  summary: {
    requestCount: number;
    itemCount: number;
    activeItemCount: number;
    availableResultCount: number;
    sampleCount: number;
    attachmentCount: number;
  };
}
```

Cada `item` visível recebe `workspaceContext`:

```ts
workspaceContext: {
  operationalContext: OperationalContext;
  sample: {
    id: string;
    requestId: string;
    accessionCode: string;
    sampleType: string;
    status: "EXPECTED" | "RECEIVED" | "REJECTED" | "REPLACED";
    collectedAt?: string;
    receivedAt?: string;
  } | null;
  result: {
    id: string;
    versionId: string;
    status: "RELEASED";
    releasedAt?: string;
    needsReReview: boolean;
  } | null;
  attachments: Array<{
    id: string;
    resultVersionId: string;
    safeName: string;
    detectedMime: string;
    sizeBytes: number;
    scanStatus: "CLEAN";
    uploadStatus: "FINALIZED";
    createdAt: string;
  }>;
}
```

Regras deliberadas do shape:

- `OperationalContext` é derivado no servidor a partir do estado do item, SLA e
  workflow; o browser não envia nem recalcula `nextAction`.
- A amostra é a mais recente vinculada ao item e ao request visível. O resumo
  não inclui credencial, conteúdo binário ou dados de coleta além do necessário
  para reconciliação operacional.
- O resultado só é resumido quando sua versão corrente está `RELEASED` e o ator
  passa a mesma autorização de `result.view` do endpoint de resultado. Draft,
  versão invalidada e resultado fora do setor são omitidos, não mascarados.
- Anexos só entram quando pertencem à versão liberada visível e estão
  `CLEAN`/`FINALIZED`. O workspace nunca expõe `storageKey`, token de upload ou
  URL de download; o download continua no endpoint protegido.
- `responsibleLabel` é um nome de apresentação derivado de uma identidade
  autorizada. Em `workspace.currentContext`, ID, e-mail, senha e objeto de
  usuário não são projetados; o shape legado de `admissions` não é alterado
  nesta fatia.
- Ausência é representada por `null` ou array vazio, nunca por dado estimado.
  `asOf` permite ao operador saber que a leitura é um snapshot.

## Matriz de escopo

| Recurso | VETERINARIAN / INPATIENT_TEAM / VIEWER | LAB_TECH | RADIOLOGY_TEAM / ULTRASOUND_TEAM | MANAGER |
| --- | --- | --- | --- | --- |
| identidade do paciente | paciente atribuído | somente com item de serviço visível | somente com item de serviço visível | paciente com request em setor delegado |
| encounter/admission | no paciente autorizado | no contexto do item autorizado | no contexto do item autorizado | no paciente delegado |
| request | requests com ao menos um item visível | requests com item do serviço permitido | requests com item da modalidade permitida | requests com setor delegado |
| item + `OperationalContext` | item visível | item no `serviceCodes` | item da modalidade e setor | item nos setores delegados |
| sample summary | amostra de item visível | amostra do serviço permitido | vazio quando não aplicável | amostra de item visível |
| result summary | versão liberada no escopo | versão liberada no serviço | versão liberada na modalidade | versão liberada no setor |
| attachment summary | somente anexo limpo/finalizado da versão autorizada | idem | idem | idem |
| timeline | eventos sem item oculto | eventos do contexto visível | eventos do contexto visível | eventos do setor delegado |

ADMIN permanece sem patient scope nesta fronteira. Falhas de escopo respondem
`404` através da autorização existente, sem confirmar a existência do paciente.
Permissão de leitura não autoriza comandos; ações continuam nas rotas de
workflow com `expectedVersion`, idempotência e auditoria.

## Barra da jornada

O componente precisa provar os estados abaixo em desktop 1440px, tablet 834px
e mobile 375–390px:

| Estado | Comportamento obrigatório |
| --- | --- |
| loading | região nomeada e layout estável, sem salto de conteúdo |
| erro/negado | mensagem segura, retry e retorno a Pacientes; nenhum dado parcial inventado |
| vazio | identidade/contexto continuam úteis e a ausência de requests é explícita |
| snapshot parcial | aviso não bloqueante quando a leitura auxiliar falhar; requests autorizadas permanecem utilizáveis; métricas e campos dependentes mostram `—`/“Indisponível nesta leitura”, sem zeros fabricados |
| stale | `asOf`/atualização visíveis; o snapshot confirmado permanece na tela e o aviso/status stale continua visível durante uma reconciliação pendente; refresh é explícito e não limpa o status localmente |
| completo | identidade, contexto atual, métricas, próxima ação, requests/items, amostra/resultado/anexos e timeline |

Critérios de interação: foco visível, ordem de tabulação previsível, links para
request/result, labels sem depender apenas de cor, sem overflow horizontal e
sem duplicar tabela desktop e árvore mobile simultaneamente.

## Evidência de aceite local

- [Packet corrente da fatia](../../.orchestrate/evidence/v2-patient-workspace-current-20260906.md);
- contrato TypeScript + OpenAPI/runtime schema alinhados;
- testes de aplicação para autorização, não vazamento e vínculos
  request/item/sample/result/attachment;
- teste de rota/envelope;
- componente com loading, erro, vazio e workspace completo;
- refresh stale/degraded com preservação do último snapshot confirmado;
- axe e jornada Playwright nos três breakpoints;
- `typecheck`, `lint`, `build`, suite regressiva e `git diff --check`;
- crítica independente read-only registrada no packet visual corrente, ou
  veredito explicitamente `NOT_RUN` quando o ambiente não permitir sua execução.

A apresentação mantém todas as `nextActions` server-provided visíveis. A
timeline, quando maior que a prévia operacional de vinte eventos, identifica
explicitamente o recorte como “últimos N de total”; no mobile, serviço, status,
próxima ação e responsável têm wrapping intencional para não ocultar contexto
operacional.

Quando a rota está carregando, a região nomeada mantém a geometria do workspace
com skeletons para identidade, contexto, métricas, solicitações e timeline; a
troca do shell de autenticação não deve deslocar o conteúdo. Se `nextCursor`
estiver presente, o operador pode carregar a próxima página autorizada sem
perder a página já confirmada. Eventos de auditoria e estados conhecidos são
apresentados com rótulos operacionais em português; tipos desconhecidos usam
uma descrição genérica e segura, sem expor códigos internos.

O mesmo princípio vale para o contexto operacional: setores solicitantes
conhecidos são apresentados com seus nomes operacionais (por exemplo,
“Equipe solicitante · Internação”), enquanto códigos desconhecidos resultam em
“Equipe solicitante”/“Setor não informado”, sem ecoar identificadores técnicos.
Os estados loading inicial e carregamento de páginas preservam a geometria e a
página já confirmada; os artefatos visuais correntes registram ambos os casos.

Quando recursos auxiliares falham, a leitura marca o contexto como “Leitura
parcial” e identifica visualmente cada métrica/item dependente indisponível.
Durante uma atualização, “Snapshot anterior preservado” permanece visível até
o novo snapshot ser confirmado; uma resposta parcial não é tratada como um
resultado vazio. A barra de frescor tem texto visível (“Snapshot atual”,
“Leitura parcial” ou “Snapshot anterior preservado”) além do indicador cromático.

Antes da busca do paciente, paginação inválida é rejeitada e as capacidades de
leitura autorizadas são verificadas; paciente desconhecido e paciente existente
fora do escopo retornam o mesmo envelope seguro `404`, sem confirmar existência.

Fora desta fatia permanecem autoridade hospitalar, thresholds/criticidade,
identidade real, migração relacional final, dados de produção, retenção,
antimalware, aceite clínico e qualquer decisão de release.
