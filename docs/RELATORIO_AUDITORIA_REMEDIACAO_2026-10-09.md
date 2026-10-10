# Auditoria da entrega 3d47f1f — 09/10/2026

> **Registro histórico:** esta auditoria examinou exclusivamente `3d47f1fc3a92f697e4eb008a05694e91a9a4eab9`. A publicação parte da main `64209e108111ed96f9fe54479d27f54edd952f67`, que já inclui [a correção REM-01](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/commit/3263ea7) e [a correção REM-02](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/commit/f9c406f). Os achados, contagens e testes abaixo descrevem o candidato auditado, não uma nova auditoria da main de publicação.

## Veredito no candidato auditado

Entrega parcialmente confirmada. As alegações verificáveis sobre main, CI, PRs, code scanning e contagem do backlog conferem. As correções dos nove contraexemplos anteriores funcionaram nas fronteiras examinadas. Foram encontrados **dois defeitos médios adicionais**, reproduzidos pelo revisor da respectiva frente e novamente pelo coordenador desta auditoria. A afirmação de estabilidade deve ficar condicionada à correção deles e aos aceites operacionais ainda abertos.

Isso não é autorização de produção. O próprio `docs/operations/PRODUCTION_READINESS.md` mantém `NOT READY`; carga representativa, backup completo PostgreSQL/S3, homologação, pentest, UAT e piloto continuam pendentes. Nenhum defeito alto novo foi demonstrado neste escopo. Não foram ensaiados serviços do hospital.

Candidato congelado: **3d47f1fc3a92f697e4eb008a05694e91a9a4eab9**, checkout isolada `/tmp/cvg-remediation-audit-20261009`. A main remota permanecia nesse SHA na reconferência final. Comparação: `2f8b78b..3d47f1f`, 51 arquivos. Revisão dividida com Euclid (críticos), Socrates (amostras/catálogo) e Hubble (arquivo/backup), com inspeção dos artefatos e síntese pelo coordenador. Os revisores reutilizaram contexto da auditoria anterior; não se alega uma revisão inteiramente sem contexto anterior.

## REM-01 — P2: resposta antiga de validação permite aplicar o CSV já substituído

Local: `src/components/admin-catalog-import.tsx:52`; aplicação na linha 62; troca da seleção nas linhas 37–40. Os campos de arquivo permanecem habilitados durante a validação. Trocar um arquivo limpa `validated`, mas uma resposta pendente volta a preenchê-lo com o conteúdo anterior, sem conferir a seleção atual.

Reprodução com componente real em jsdom e handlers reais, MemoryStore sintético:

1. Painel inicial com FIRST e SECOND, ambos obrigatórios.
2. Validar CSV contendo apenas SECOND e atrasar a entrega da resposta.
3. Selecionar outro CSV contendo FIRST e SECOND.
4. Entregar a resposta antiga e clicar Aplicar.
5. O campo continua selecionando o CSV novo; o envio e o painel armazenado contêm apenas SECOND.

Observação: `{"selectedFilename":"new-preserving-both.csv","submittedCodes":["SECOND"],"storedCodes":["SECOND"]}`. A expectativa de preservar FIRST/SECOND falha. Não é uma objeção à substituição integral intencional aprovada em D-042: o defeito é aplicar uma seleção obsoleta.

Ação recomendada: invalidar respostas por geração/identidade da seleção, ou bloquear mudanças dos dois arquivos enquanto a operação está pendente. Cobrir tanto a leitura FileReader quanto a resposta HTTP pendente. O defeito já existia no componente; não foi atribuído como introduzido pelo PR42.

Comando de reconferência do coordenador, cwd `/tmp/cvg-remediation-clinical-harness-20261009`:

```sh
env -i PATH=/home/ricardo/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin APP_TIMEZONE=America/Sao_Paulo ACCESSION_PREFIX=A node /tmp/cvg-remediation-audit-20261009/node_modules/vitest/vitest.mjs run --config /tmp/cvg-remediation-clinical-harness-20261009/vitest.config.mts --reporter verbose catalog-ui.test.tsx -t 'changing selected CSV'
```

Resultado: exit 1, falha esperada da asserção de preservação; outro teste não selecionado pelo filtro. Evidência: [log do coordenador](../.orchestrate/evidence/remediation-20261009/catalog-stale-response-lead.log), harness (`/tmp/cvg-remediation-clinical-harness-20261009/catalog-ui.test.tsx`), relatório clínico (`/tmp/cvg-remediation-clinical-20261009.md`). Sem navegador real ou PostgreSQL nesse contraexemplo.

## REM-02 — P2: backup parcial é aceito como válido e produz saúde falsa

Local: `deploy/backup/ship-offsite.sh:51`. O glob `base/*/base.tar.gz` inclui `base/<timestamp>.partial/base.tar.gz`. A checagem considera esse arquivo pelo tamanho e mtime, mas o envio nas linhas 84–85 exclui `*.partial/**`. O ciclo pode registrar sucesso sem enviar nenhum dump ou base backup concluído.

Reprodução independente do coordenador com destino inicialmente vazio, um segmento WAL sintético e somente `backups/base/20261009.partial/base.tar.gz` na origem:

- `ship_exit=0`, evento `offsite.shipped`, `lastResult=ok` e sucesso atualizado para agora;
- destino contém somente `remote/wal/000000010000000000000001`;
- `check-offsite.sh` retorna `health_exit=0`.

Nenhum backup completo foi enviado. A reprodução não tentou recuperar PostgreSQL de bytes sintéticos e não demonstra perda real de dados. Demonstra a divergência entre checagem e seleção de envio, inclusive durante a janela normal de criação de um base backup. A frente de backup também reproduziu o caso com um dump completo antigo e um base parcial recente.

Ação recomendada: excluir diretórios parciais também da seleção usada para determinar validade/frescor, usando o mesmo conjunto de artefatos finalizados do envio. Testar origem somente parcial e origem com backup completo vencido mais parcial recente; não avançar o último sucesso nesses casos. A eliminação destrutiva por `rclone sync` foi corrigida e os destinos anteriores foram preservados nos casos executados; essa proteção adicional permanece incompleta.

Repro: container efêmero `rclone/rclone:1.71.2`, `--network none`, filesystem de imagem somente leitura, bind apenas do caso sintético e dos scripts, remote `:local:/case/remote`, execução `sh /scripts/ship-offsite.sh --once` seguida do healthcheck. Comando completo, saídas e arquivos: [log](../.orchestrate/evidence/remediation-20261009/backup-partial-lead.log), caso sintético local `backup-partial-lead/`. Container removido automaticamente com `--rm`.

## Conferência dos achados anteriores

| Achado | PR | Evidência atual e conclusão no escopo |
|---|---|---|
| AUD-01, escalonamento atrasado | #41 | Cenário 40/61/240 min chega aos níveis 1/2/3; ciclos concorrentes não duplicam; ACK autorizado interrompe. Contraexemplo original fechado. |
| AUD-02, destinatário/ACK sem acesso | #41 | Candidato sem `result.view` é ignorado; acesso perdido após entrega produz 404 no ACK e preserva escalada. Contraexemplo original fechado. |
| AUD-03, tubo recebido compartilhado | #45 | Dois técnicos por serviço usam o mesmo tubo; código divergente, dígito inválido, versão stale e escopo errado recusados sem mutação. Contraexemplo original fechado. |
| AUD-04, exclusão externa | #40 | Origem vazia com 3/25 arquivos externos preserva hashes, inclusive ciclos repetidos; `copy --ignore-existing` preserva artefatos existentes. Exclusão original fechada; ver REM-02. |
| AUD-05, escopo do arquivo clínico | #48 | Paridade por item entre leitura ativa/arquivada em dez perfis; resultados, amostras, anexos e resumo acompanham os itens visíveis. Contraexemplo original fechado. |
| AUD-06, reset pendente sobrevive à mudança | #44 | `withoutPendingReset` aplicado na transação de mudança própria/inicial, regeneração, alteração de acesso e desativação; quatro regressões versionadas passam na suíte completa. Verificação defensiva de código/testes, sem repetir exploração de privilégio. |
| AUD-07, catálogo dividido remove silenciosamente | #42 | Novo contrato documenta substituição integral por exame e lista remoções obrigatórias/opcionais no dry run, UI e CLI. Fluxo normal verificado; ver REM-01. |
| AUD-08, paginação antes do escopo | #48 | Oito registros recentes de outro setor não escondem os dois autorizados; limites 1/2/100 respeitam escopo. Contraexemplo original fechado; materialização ampla continua abaixo. |
| AUD-09, home depende da ordem | #43 | Fixture própria; cenário isolado passou em Chromium/tablet/mobile, servidores novos, retries=0. Contraexemplo original fechado. |

Os merges #40–#48 estão na ancestralidade da main. #47 ajusta o relógio relativo da fixture PostgreSQL; #46 tira resetUrl do evento JSON e configura o serviço bootstrap com driver de log `none`. A inspeção confirma o caminho operacional documentado; não se garante sigilo de stdout se um operador o redirecionar fora desse caminho.

## Dívidas declaradas: confirmação e prioridade

- **P2 — materialização do arquivo clínico:** `archive-service.ts:43` consulta todo o histórico do paciente antes de filtrar e aplicar o limite. `postgres-clinical-archive.ts:80` admite `LIMIT NULL`; o queryspy materializou 80 linhas de 16 solicitações para devolver uma entrada, ou negar com 404. Há leitura antes de uma negativa posterior de escopo. A correção dos filtros evita exposição na resposta; não foi demonstrado vazamento nem medido OOM/latência. A guarda proposta para consulta sem filtro e sem limite ajuda, mas não limita esta chamada, que possui patientId. Considerar autorização no SQL ou varredura incremental limitada, preservando a ordenação/filtro anteriores à paginação.
- **P3 — mensagens do catálogo:** campo inválido de 20.000 caracteres gerou erro de 20.063 caracteres; UI concatena os erros sem truncamento. Prova: [log](../.orchestrate/evidence/remediation-20261009/catalog-long-message.log), harness local `catalog-long-message.mts`. Limitar trecho ecoado e apresentação; não foi demonstrada execução de conteúdo, pois React o renderiza como texto.
- **P3 — marcadores de conflito:** numa cópia sintética do material versionado, acrescentar `<<<<<<<`, `=======`, `>>>>>>>` em `docs/GLOSSARY.md` ainda deu exit 0 no validador. [Log](../.orchestrate/evidence/remediation-20261009/docs-marker-repro.log). Não foram encontrados marcadores atuais na documentação examinada. A dívida é a ausência do gate, não conflito atual na main.

## Alegações remotas e backlog

[CI 37887071373](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/37887071373), head exato 3d47f1f: seis jobs aplicáveis com success, Dependency review skipped pelo contexto push. Logs: 2.134 unitários + 109 PostgreSQL = 2.243 no agregado de cobertura; o gate passou com 20 exceções. Navegador: home isolada 3/3, suíte 90/90, acessibilidade 12/12; navegador PostgreSQL 48/48. Imagem/Trivy e benchmark HTTP/PostgreSQL/SSE passaram. Trivy tem `ignore-unfixed: true`; sucesso não significa ausência de vulnerabilidades sem correção publicada.

GitHub API: zero alertas abertos de code scanning; único PR aberto #26, branch `chore/audit-dependabot-2026-10-07`. Esses são snapshots de 09/10, não garantias futuras. O estado de outros agentes humanos/LLMs não pode ser comprovado por CI ou lista de PRs; não foi concluído que nenhum trabalho privado esteja em andamento.

Recontagem direta de `docs/build/PRODUCTION_BACKLOG.md`: **60**, DONE **13**, VERIFY **20**, IN_PROGRESS **1**, READY **10**, BLOCKED **16**. PROD-110 é o IN_PROGRESS. A lista de trabalho independente do hospital corresponde ao backlog: 303, 512 (depende de 303), 110 e 408. O benchmark atual ainda identifica workloadApproval D2_PENDING e não substitui a prova com 12 meses de entidades clínicas e simultaneidade representativa; avançar sinteticamente é possível, aceite operacional continua aberto. Dependências de servidor, operadores, valores críticos, fornecedor/templates, equipamentos, catálogo, retenção e piloto conferem com a documentação.

O ensaio de replay PostgreSQL de seis segundos é histórico, não foi repetido nesta auditoria e não é um restore completo cronometrado de PostgreSQL/S3 no hospital. PROD-514 permanece BLOCKED por esse motivo.

## Validação local e preservação

Node 22.23.2, npm ci na checkout isolada. Comandos no package.json e resultados observados:

| Verificação | Resultado |
|---|---|
| npm test | 2.134/2.134, 169 arquivos, exit 0, 288,36 s |
| npm run test:postgres | 109/109, 19 arquivos, PostgreSQL 16.15 efêmero, exit 0, 129,81 s |
| npm run test:config | 178 testes nativos + 7 TypeScript, sem falhas, exit 0 |
| typecheck; lint | exit 0; lint sem avisos |
| validate:docs | exit 0, 89 arquivos exigidos |
| validate:openapi | exit 0, 86 operações/79 paths; um aviso oneOf em DiagnosticServiceCreate, não investigado como achado adicional |
| validate:migrations | exit 0, 001–017 |
| Playwright home isolada | 3/3, retries=0, 30,8 s |

A frente de críticos executou nove cenários próprios e 41 testes focados, todos passando. A frente clínica executou nove testes próprios: oito passando e a falha que prova REM-01. A frente arquivo/backup executou 13 testes de arquivo e 8 de offsite, passando, e preservou probes, logs, hashes antes/depois e comandos dos casos locais. Relatório da frente (`/tmp/cvg-remediation-archivebackup-20261009.md`). Os artefatos desses revisores foram inspecionados; REM-01 e REM-02 receberam reprodução adicional do coordenador.

Cobertura, mutação, suíte browser completa, build da imagem e benchmark foram verificados nos registros da CI desse candidato; não foram todos reexecutados localmente. Não foi executado teste operacional do hospital, Meta, impressora/leitor, HIBP, backup S3 ou pentest.

Código versionado e checkout principal preservados; nenhum commit/push/merge ou leitura de .env/dados reais. PostgreSQL descartável encerrado por trap; containers dos probes rclone removidos com --rm. Worktree e evidências desta auditoria foram preservadas para revisão. As evidências principais publicadas estão em [remediation-20261009](../.orchestrate/evidence/remediation-20261009/MANIFEST.json), com hashes SHA-256 e identificação do candidato. O conjunto local completo e os harnesses permanecem na pasta original indicada acima; não foram copiados para o Git.
