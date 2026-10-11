# Auditoria de prontidão para produção em 11 de outubro de 2026

**Destinatário:** Ricardo Akinaga, responsável pelo produto.
**Base auditada:** `main`, commit `6fb180a5029ff3ad1ef19c80b00f42ab6f7a1715`.
**Veredito:** **NOT READY para produção clínica**. Há cinco defeitos de alta prioridade reproduzidos, uma lacuna de recuperação após exclusões e gates de implantação e aceite hospitalar ainda abertos.

**Atualização posterior:** as correções da candidata local estão no [relatório de correções de 11/10/2026](RELATORIO_CORRECOES_AUDITORIA_2026-10-11.md). Este documento preserva a evidência da base `6fb180a`; as reproduções abaixo ocorreram antes dessas alterações. Os gates externos continuam válidos.

Os cinco defeitos devem ser corrigidos antes de um piloto com dados clínicos reais. O relatório de [10/10](RELATORIO_PRONTIDAO_2026-10-10.md) considerava o código pronto para homologação e piloto acompanhado; os novos cenários desta auditoria reabrem esse aceite. Homologação com dados sintéticos pode continuar enquanto as correções e a preparação do hospital avançam.

## 1. Escopo e base de evidências

A auditoria examinou autenticação, autorização por paciente/setor/exame, sessões, uploads, logs, catálogo, pedidos, amostras, resultados, notificações, arquivo clínico, migrações, concorrência, desempenho, testes, CI, release, backups, monitoramento e procedimentos de operação. A base considera as decisões D1–D12 de 08/10 e as correções D-055–D-062, em vez de tomar pendências antigas como defeitos atuais.

As reproduções de negócio e segurança usaram as funções reais da aplicação com `MemoryStore` e fixtures sintéticas. Os testes de integração e a carga usaram PostgreSQL 16.15 em um cluster temporário, autenticado, exclusivo desta auditoria em `127.0.0.1:55489`. O localhost existente e o banco configurado no `.env` ficaram fora dos ensaios de dados. O build de produção foi isolado em um diretório próprio.

Docker, MinIO e ClamAV reais não estão disponíveis neste ambiente. Os ensaios de recuperação completa e indisponibilidade de 10/10 permanecem evidência de laboratório documentada; a CI remota do commit foi consultada diretamente. Nenhum resultado local comprova a configuração, a carga, a recuperação ou o aceite do hospital.

Prioridades: **P1** exige correção ou prova antes de liberar o cenário afetado; **P2** exige tratamento planejado e, quando indicado, bloqueia a ativação da funcionalidade correspondente. A ausência de um ensaio no alvo é identificada como gate, sem ser contabilizada como bug reproduzido.

## 2. Validações executadas

| Verificação | Resultado desta auditoria | Limite da prova |
| --- | --- | --- |
| Tipos e lint | `npm run typecheck` e `npm run lint`: PASS | Código da base auditada |
| Localhost preservado | `/login` e `/api/v1/livez`: 200; `/api/v1/readyz`: 503 | PostgreSQL configurado no `.env` indisponível neste ambiente; o cluster descartável da auditoria não substitui esse banco |
| Contratos e configuração | 209 testes passaram; um teste de renderização do Compose foi ignorado por falta de Docker | 210 casos no total; não comprova o Compose em execução |
| Documentação | 89 arquivos obrigatórios e gates documentais: PASS | Links e contratos não substituem comprovação operacional |
| OpenAPI | 88 operações em 81 caminhos: PASS, com um warning de composição de schema | Warning sem falha no validador |
| Rastreabilidade e migrações | 43 requisitos/43 critérios; migrações 001–017: PASS | Integridade do conjunto; upgrade do banco hospitalar exige ensaio próprio |
| Segredos e dependências | Secret scan PASS; `npm audit` completo e de produção: zero advisories; SBOM com 512 componentes | Resultado do registro npm nesta data; não cobre sistema operacional, imagens ou pentest |
| Build e privacidade do bundle | Build Next.js de produção PASS; 36 arquivos de bundle, zero achados no privacy scan | Scanner de padrões não garante ausência de todo dado pessoal |
| Testes de performance e recuperação | 61 contratos de performance, cinco testes de manifesto de recuperação e sete controles de mutação: PASS; gates de snapshot e realtime: PASS | Controles de regressão; não equivalem ao restore completo |
| Testes e cobertura agregada | Repetição completa: 2.317 testes em 199 arquivos PASS; linhas 97,78%, branches 91,75%, funções 96,43%, statements 95,47%; `coverage:gate` PASS | Inclui 2.206 casos unitários/API/UI e 111 PostgreSQL; 20 exceções de cobertura declaradas, sem entradas descobertas ou vencidas. A primeira rodada falhou em um teste assíncrono de troca obrigatória de senha; seus 46 casos passaram isoladamente e a suíte inteira passou na repetição |
| PostgreSQL | 111 testes em 19 arquivos: PASS | Banco temporário; inclui migrações e os cenários implementados na suíte |
| Navegador desktop/tablet/mobile | Local: 102/105 passaram, três falhas de comparação visual que se repetiram. CI do mesmo commit: 93 E2E e 12 de acessibilidade passaram, incluindo as três comparações visuais | Indícios de diferença de fontes/ambiente local, sem causa exata fechada; baselines preservadas. Execução local com memória, armazenamento local e scanner sintético; inspeção manual e alvo produtivo permanecem necessários |
| CI do commit no GitHub | [Run 38067613242](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/38067613242): seis jobs concluídos com sucesso; Dependency review ignorado no evento push | Inclui PostgreSQL, browser, CodeQL e imagem; não equivale ao aceite hospitalar |
| Publicação de release | [Run 38069129648](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/38069129648): skipped | A publicação está desabilitada; uma candidata publicada e promovida ainda precisa ser comprovada |

### Ensaio curto de carga e falhas

`perf:hospital` foi executado com **um mês de histórico**, 150 exames/dia, 10 mil eventos de auditoria adicionais, 42 profissionais e 30 streams SSE. Foram medidos os níveis 1× e 25× do pico estimado, por 30 segundos cada, seguidos de falhas do app e do worker a 25×.

| Medida | Resultado |
| --- | --- |
| 1× | p95 agregado de leitura 14,61 ms; escrita 49,91 ms; zero erros no nível |
| 25× | p95 agregado de leitura 14,87 ms; escrita 22,78 ms; zero erros no nível |
| App morto com SIGKILL | Recuperação em 5,81 s; 41 requisições falharam durante a indisponibilidade e foram tratadas pelo harness |
| Worker morto com SIGKILL | Recuperação/entrega pendente em 16,01 s |
| Integridade ao final | 34 solicitações confirmadas e duráveis; 34 resultados e notificações entregues; zero solicitações ou entregas duplicadas |

Esse ensaio confirma integridade nas jornadas executadas. A amostra curta, o histórico reduzido, as sessões sintéticas e a ausência de upload/antivírus impedem inferir capacidade anual ou um SLA hospitalar. A prova de 12 meses/50× e o soak de duas horas são do [laboratório de 10/10](RELATORIO_CARGA_HOSPITALAR_2026-10-10.md), com outro host. Continuam pendentes pico real, carga no alvo, login/anexos/ClamAV e soak de pelo menos 24 horas.

## 3. Cinco defeitos que precisam de correção

### A01 Liberação de resultado com amostra rejeitada

**P1 — integridade clínica.** Dois exames configurados para compartilhar um tubo EDTA são recebidos. Rejeitar o primeiro por `UNPROCESSABLE` marca a amostra inteira como `REJECTED`, mas deixa o outro exame `RECEIVED` vinculado à mesma amostra. É possível iniciar esse segundo exame, criar o draft e liberar o resultado. A reprodução terminou com **`ResultVersion.status=RELEASED` e `Sample.status=REJECTED`**.

**Causa:** [workflow-service.ts](../src/server/application/workflow-service.ts), linhas 511–517, atualiza o estado da amostra e somente um item; início do processamento, linhas 300–321, e [result-service.ts](../src/server/application/result-service.ts), linhas 328–341, não exigem uma amostra válida.

**Fechamento:** definir com o laboratório a diferença entre rejeição do exame e rejeição física do tubo. Propagar os efeitos aos vínculos que dependem do tubo e impedir processamento/liberação com amostra rejeitada ou substituída. Testar tubos compartilhados com outros itens recebidos, processando e já concluídos, preservando resultados já liberados e sua auditoria.

### A02 Recoleta impossível em tubo com versões diferentes

**P1 — continuidade do fluxo clínico.** Dois exames do mesmo tubo ficam na versão 2 após o recebimento. Iniciar apenas um deixa suas versões em 3 e 2. A recoleta exige um único `expectedVersion` para todos os itens: informar 2 falha no item de versão 3; informar 3 falha no de versão 2. Atualizar a tela não resolve.

**Causa:** [workflow-service.ts](../src/server/application/workflow-service.ts), linha 247, compara cada item com o mesmo valor; o recebimento da substituição repete o padrão na linha 276.

**Fechamento:** controlar concorrência pelo agregado amostra ou por um mapa explícito de versões dos itens, validado atomicamente. Demonstrar recoleta/recebimento da substituição com itens em fases e versões diferentes, incluindo itens cancelados ou concluídos, conforme a política do laboratório.

### A03 Desativar um exame retira acesso ao histórico

**P1 — disponibilidade clínica.** Um exame é solicitado, processado e liberado. Depois o ADMIN desativa o serviço no catálogo. A consulta do laudo, do pedido, do painel, da lista de pedidos e da busca passam a responder **404 `NOT_FOUND`**, com “Serviço diagnóstico indisponível”. Uma operação legítima do catálogo afeta registros já existentes e telas inteiras.

**Causa:** [service-common.ts](../src/server/application/service-common.ts), linhas 452–454, recusa `active:false` também nas projeções históricas e na autorização; [management-service.ts](../src/server/application/management-service.ts), linha 526, permite essa desativação. Contraria a preservação de histórico descrita em [CATALOG_IMPORT](operations/CATALOG_IMPORT.md).

**Fechamento:** resolver referências históricas independentemente de `active`, exigindo atividade apenas para oferta/novos pedidos. Testar desativação após pedido e liberação, leitura histórica, fila/painel/busca e continuidade ou cancelamento dos pedidos anteriores.

### A04 Rotação da chave não encerra sessões existentes

**P1 — contenção de incidente.** O [procedimento de deploy](operations/DEPLOYMENT.md), linhas 39 e 589, afirma que girar `SESSION_SECRET` encerra as sessões. A autenticação usa o SHA-256 do token, sem depender dessa chave. Após login real, troca do segredo e reconstrução do store com os registros persistidos sintéticos, a sessão antiga continuou autenticada e `revokedAt` permaneceu vazio.

**Causa:** [session.ts](../src/server/security/session.ts), linhas 16, 96 e 122. A chave tem outros usos, mas sua rotação não constitui revogação global do cookie.

**Fechamento:** implementar invalidação global vinculada à rotação ou um comando de revogação global auditável, tornando-o obrigatório no procedimento. Demonstrar cookie antigo recusado, novo login válido, reset links antigos inválidos e encerramento de SSE nas instâncias envolvidas. Corrigir o runbook junto com a implementação/procedimento.

### A05 Deploy aprova worker em execução mas sem saúde

**P1 — entrega de notificações e operação.** Com app saudável e worker `running=true`, mas `health=unhealthy`, o script de deploy sai com sucesso, registra `release.deployed` e grava a release em `.current`. A reprodução usou Docker simulado e constatou que a saúde do worker nem foi consultada.

**Causa:** [deploy.sh](../deploy/release/deploy.sh), linhas 114–116, verifica somente `.State.Running`, embora o [Compose de produção](../docker-compose.prod.yml), linha 249, tenha healthcheck. Depois, `pull-release.sh`, linha 61, considera a candidata já implantada.

**Fechamento:** aguardar a saúde de app e worker, com timeout e diagnóstico, antes de gravar sucesso. Testar worker vivo sem heartbeat, unhealthy e sem entrega; todos devem impedir `.current`/promoção. Demonstrar também uma mensagem entregue pelo outbox após implantação no alvo.

## 4. Recuperação e monitoramento que precisam ser completados

### R01 Recuperação de anexos após exclusões

**P1 — gate de recuperação.** A cópia externa conserva objetos com `copy --ignore-existing` ([ship-offsite.sh](../deploy/backup/ship-offsite.sh), linha 124). O restore copia esses objetos de volta ([full-restore-drill.sh](../scripts/full-restore-drill.sh), linha 201). Objetos já excluídos após o backup podem voltar sem linha correspondente no banco; a [reconciliação](../src/server/storage/attachments-reconcile.ts), linhas 76–80, então reprova objetos órfãos.

O cenário já pode ocorrer com anexos pendentes expirados removidos na liberação do resultado ([result-service.ts](../src/server/application/result-service.ts), linhas 344–364), além do expurgo futuro. A orientação de reaplicar o expurgo em [BACKUP_RESTORE](operations/BACKUP_RESTORE.md), linha 162, não resolve chaves cujas linhas já foram eliminadas. A sonda pura confirmou objeto restaurado sem referência → `ok=false`, `orphanObjects=1`; o ciclo MinIO/backup real desse cenário não foi repetido nesta máquina.

**Fechamento:** manter manifesto de exclusões/tombstones ou selecionar, de forma verificável, os objetos referenciados pelo banco no ponto recuperado. Preservar extras para investigação antes de qualquer eliminação. Ensaiar expiração, expurgo, versões de objetos e PITR antes/depois da exclusão, partindo somente do destino externo. Demonstrar reconciliação final e tempos dentro do RPO/RTO aprovado.

### R02 Monitoramento externo e entrega de alertas

**Gate obrigatório de implantação.** Há métricas, regras e runbooks, mas a configuração de [Prometheus](../deploy/observability/prometheus.yml) não encaminha alertas a Alertmanager; o [Compose de observabilidade](../docker-compose.observability.yml) instala logs/Grafana, sem instalar Prometheus/Alertmanager/exporters. O [DEPLOYMENT](operations/DEPLOYMENT.md), linha 291, deixa exporters, blackbox/cron e roteamento para o ambiente.

Falta comprovar monitoramento de backup base e externo, disco/WAL, validade TLS, ClamAV, heartbeat do worker inclusive quando ocioso e disponibilidade do host. Definir apenas os nomes da escala não fecha esse gate: instalar a coleta/probes e a entrega para titular e reserva, com monitor fora do host. Demonstrar cada alerta recebido e um ensaio com o host inteiro indisponível.

O [outage-drill](../scripts/outage-drill.sh), linhas 180–186, observa ClamAV pelo healthcheck do scanner, mantendo `/readyz=200`; não comprova entrega de alerta externo. A afirmação ampla “cada componente detectado pela regra certa” no relatório de 10/10 deve ser limitada ao que o ensaio efetivamente mediu.

## 5. Pendências adicionais e funcionalidades condicionadas

| Item | Prioridade e efeito | Evidência | Fechamento |
| --- | --- | --- | --- |
| Exportação após revogação concorrente | P2: a requisição começou autorizada, mas devolve dados depois de a sessão ser revogada durante a leitura paginada | `data-subject-service.ts:219–250`; reprodução devolveu um pedido/um laudo, enquanto a próxima autenticação falhou | Revalidar sessão, usuário, perfil e reautenticação na transação final antes da resposta; testar revogação/desativação/mudança de perfil |
| Leitura de laudo arquivado sem evento de acesso | P2; fechar antes de homologar arquivamento | `archive-service.ts:76–83,125–143`; consulta ativa gerou `ResultRead`, arquivada devolveu duas versões e zero eventos | Registrar ator, registro/versões, correlação e instante antes de devolver; falha de auditoria impede resposta |
| Anexo arquivado sem download pelo produto | P2 funcional; afeta histórico e entrega de PDFs arquivados | `attachment-service.ts:258–264` procura apenas anexos ativos; `archive-service.ts:150–152` retorna metadados | Rota de download com escopo e auditoria para o arquivo; testar após mover o pedido para arquivo |
| Falha de apagar objeto após expurgo não tem retry durável | P1 antes de ativar expurgo; expurgo permanece desligado | `clinical-archive-job.ts:97–114` elimina linhas/chaves e só conta falhas S3; duas rodadas tentaram a remoção uma única vez | Intent de exclusão persistente, retry e alerta, com chave exata recuperável pelo operador; testar crash/falha entre commit e S3 |
| Promessa de apagar cadastro não corresponde ao expurgo | P2 antes de aprovar procedimento/ativar expurgo | `DATA_SUBJECT_REQUESTS.md:55`; pacientes/atendimentos/internações ficam fora do arquivo em `clinical-archive-policy.ts:157–160` | Alinhar procedimento e implementação de exclusão/anonimização com a decisão institucional, mantendo integridade |
| Release manual pode publicar sem consultar CI do commit | P2 antes de habilitar publicação | `release.yml:27–29` permite `workflow_dispatch` na main; somente o caminho workflow_run exige CI success | Exigir CI verde para o SHA em ambos os caminhos; testar negativa e aprovação de produção |
| Gates locais instáveis/incompletos | P2 de qualidade; fechar antes de aceitar candidata | Uma falha assíncrona em `app-shell.test.tsx:458`, ausente na repetição completa; três comparações visuais falharam localmente e passaram na CI do mesmo commit, cujo browser usa imagem fixada | Aguardar o efeito de redirecionamento no teste; reproduzir o ambiente de fontes/browser da CI e verificar a candidata final sem substituir baselines para esconder diferenças |
| Documentação de segurança e status antigos | P2 operacional | README/ADR-005/SECURITY mantêm trechos anteriores às decisões e às correções atuais | Atualizar referência de prontidão, modelo de identidade e procedimento real de exportação/rotação |

O arquivamento vem **ligado por padrão**, com `ARCHIVE_ACTIVE_MONTHS=24` no Compose e no exemplo de produção. Enquanto acesso aos anexos e auditoria do arquivo não estiverem concluídos, manter `ARCHIVE_ACTIVE_MONTHS=0` na candidata usada com dados reais e planejar a capacidade correspondente. Dados já arquivados precisam das correções de leitura/download. Essa suspensão é temporária e deve respeitar a política aprovada; não resolve os registros que já saíram do conjunto ativo.

Nenhum destes achados de arquivo/exportação demonstrou quebra geral de escopo ou estabelece, por si só, uma conclusão jurídica. A política de retenção e o procedimento institucional precisam de aprovação do responsável competente.

## 6. O que falta no hospital e na publicação

| Entrega necessária | Responsável | Evidência objetiva para fechar | Referências |
| --- | --- | --- | --- |
| Servidor de homologação e produção, DNS/TLS, rede/VPN/firewall e destino externo de backup | TI do hospital | Instalações isoladas, acesso pela borda real, segredo em arquivo/cofre e inventário dos responsáveis | PROD-301/302/304/309/514; D11 |
| Candidata publicada e promovida | Engenharia + dono da release | Quatro imagens/digests/SBOM, CI verde no SHA, ambiente/revisor de produção, deploy/rollback em homologação e `installation-provenance.sh --expect <SHA>` | PROD-303; D-060 |
| Segredos, storage privado, criptografia, ClamAV e quarentena | TI + segurança | Credenciais próprias, permissões mínimas, testes de rotação e EICAR, responsável nominal pela quarentena | PROD-302/307/308 |
| Backup e recuperação completa no alvo | TI + gestão | Banco + bucket + aplicação recuperados só do destino externo; cenários R01, checksum/reconciliação, RPO ≤15 min e RTO ≤4 h conforme decisão D2 | PROD-304/514 |
| Monitoramento e escala operacional | TI + gestão | R02 implantado; titular/reserva, contatos e janela definidos; cada alerta realmente recebido | PROD-511…516 |
| Catálogo aprovado por setor | Laboratório, radiologia, ultrassom e gestão | Planilhas revisadas, códigos/unidades/amostras/tempos/faixas corretos e importação validada | PROD-407; D10 |
| Críticos, escalonamento e canal redundante | Direção clínica + laboratório | Lista de críticos, política nominal, plantão por setor, ensaio de entrega/confirmação/esgotamento; WhatsApp Business real ou aceite formal do canal somente no sistema | PROD-401/402 |
| Identidade do paciente e operação de amostras | Gestão clínica + laboratório + TI | Responsável pela conferência com prontuário, casos de homônimos, tubo compartilhado, recoleta e etiquetas na impressora/leitor reais | PROD-405/408 |
| Privacidade e retenção | Jurídico + encarregado institucional | Prazo e procedimento aprovados, responsável/canal nomeados; expurgo continua desligado até tratar os itens condicionados do §5 | PROD-501/502; D5 |
| Capacidade e contingência no alvo | TI + gestão | Pico real de usuários; carga com login/anexos/AV, soak ≥24 h, falhas/restarts/energia e contingência manual | PROD-110; D2; PROD-515 |
| Segurança e experiência independentes | Revisores humanos designados | Pentest sem achados altos/críticos abertos; threat model; inspeção manual com leitor de tela, teclado, zoom e touch; revisão independente | PROD-601…605 |
| Aceite clínico e entrada em operação | Setores + dono do produto | UAT por jornada, treinamento, piloto acompanhado de 6–8 semanas, suporte/contingência e decisão go/no-go assinada | PROD-701…704/801 |

A consulta ao GitHub mostrou proteção da `main`, sete contextos obrigatórios, aplicação aos administradores e bloqueio de force push. O número de reviews obrigatórios é zero: isso é uma escolha de governança a revisar. As APIs de variáveis e ambientes retornaram listas vazias; `RELEASE_PUBLISH_ENABLED` e a aprovação do ambiente produtivo ainda precisam ser configurados antes da publicação padronizada.

## 7. Decisões atuais que devem orientar o fechamento

**Identidade:** D1 escolheu contas do Hub para o piloto. OIDC/AD é uma reavaliação posterior, conforme PROD-200. O primeiro deploy precisa comprovar contas individuais, perfis, escopos, troca obrigatória de senha e procedimentos de revogação na borda real.

**Persistência:** auditoria e outbox já são autoridades em tabelas próprias; o núcleo clínico mantém um snapshot com transação e lock. D-061 aceita essa implementação para o volume D2 e uma instância, com monitoramento. Os triggers documentados para antecipar o cutover relacional são saturação da fila em uso normal, volume acima de 450 exames/dia, pico acima de 10× a estimativa ou necessidade de mais de uma instância. O gate atual é comprovar essa capacidade no hardware e no volume reais.

**Correções anteriores:** revalidação de acesso às notificações, avisos de retificação/anulação, reserva e saída operacional de críticos, boot do worker, proveniência das imagens e redução de escritas ociosas estão implementados. A01–A05 são cenários adicionais; as correções anteriores permanecem válidas dentro do seu escopo testado.

## 8. Ordem de execução e critério de liberação

1. **Engenharia:** corrigir A01–A05, completar R01 e tratar os gates de teste; acrescentar regressões para os cenários reproduzidos. Completar acesso/auditoria do arquivo; até lá, suspender o arquivamento automático na candidata clínica conforme §5.
2. **Em paralelo, hospital:** entregar servidor/rede/destino externo, nomes da escala, catálogo, política de críticos, canal, identidade do paciente e decisões de privacidade.
3. **Homologação:** congelar uma nova candidata com CI e gates locais verdes, publicar as imagens e comprovar SHA implantado. Instalar monitoramento, testar segredos/permissões, upgrade do banco de origem, rollback coordenado, restore completo e indisponibilidade dos componentes/host.
4. **Aceite:** repetir carga e soak no alvo; executar pentest, acessibilidade manual e UAT incluindo A01–A03, críticos, retificações, anexos, queda/retry e contingência.
5. **Piloto e produção:** treinar os setores, executar o piloto acompanhado e decidir go/no-go com os responsáveis. Qualquer limitação aceita deve especificar escopo, responsável, mitigação e condição de revisão.

**Critério de liberação:** A01–A05 fechados por teste e revisão; R01 e R02 comprovados; imagem/SHA verificáveis; restauração, segurança e carga aprovadas no alvo; conteúdo clínico e operação nomeados; UAT, treinamento, contingência e aceite formal concluídos. Cada prova deve corresponder à candidata final e à configuração que será implantada.

## 9. Evidências reproduzíveis desta rodada

Logs, JSONs e reproduções sintéticas estão em `/tmp/cvg-production-audit-20261011/`, com uma cópia compactada em `evidence.tar.gz`; são artefatos temporários e não fazem parte da release. As reproduções A01–A04 foram reexecutadas pelo auditor principal. A05 foi executado com um simulador de Docker; R01 tem inspeção do fluxo e sonda de reconciliação, sem uma execução MinIO real nesta máquina. Os builds e o PostgreSQL temporários foram encerrados/removidos ao final; o localhost existente foi preservado.

| Cenário | Resultado bruto resumido |
| --- | --- |
| A01 | `releaseStatus=RELEASED`, `sampleStatus=REJECTED` |
| A02 | versões dos itens 3/2; expectedVersion 2 e 3 produzem `STALE_VERSION` |
| A03 | cinco consultas passam antes; as cinco respondem `NOT_FOUND/404` depois de desativar |
| A04 | `authenticatedAfterRotationAndRestart=true`, `revokedAt=null` |
| A05 | app healthy + worker running/unhealthy → exit 0, `.current` gravado, nenhuma leitura da saúde do worker |
| Exportação concorrente | `exportReturnedAfterRevocation=true`, próxima autenticação `SESSION_EXPIRED` |
| Leitura arquivada | leitura ativa `ResultRead`; arquivo retorna duas versões com zero eventos de acesso |
| Falha de expurgo | duas rodadas retornam sucesso; linhas eliminadas; uma única tentativa de apagar o objeto |
| Reconciliação após restaurar objeto eliminado | `ok=false`, `orphanObjects=1` |

Para repetir os gates no ambiente adequado: `npm run validate`, build, privacy scan do bundle, browser sem retries, `npm run perf:hospital`, restore completo e outage drill. Os comandos com PostgreSQL precisam de `ALLOW_POSTGRES_INTEGRATION_TESTS=true` e URL de administração de um cluster loopback descartável. Drills destrutivos devem continuar usando exclusivamente seus projetos e alvos descartáveis previstos, separados da instalação clínica.
