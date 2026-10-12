# Atualização do planner hospitalar — candidato de 11/10/2026

Este procedimento acompanha o [roadmap](../build/ROADMAP_HOSPITAL_PLANNER_2026-10-11.md) e o [backlog](../build/BACKLOG_HOSPITAL_PLANNER_2026-10-11.md#execucao). É preparação para uma release identificada; os testes locais não constituem aceite institucional ou autorização de produção. A instalação local e os dados hospitalares existentes não foram migrados durante esta implementação.

## Migrações e acesso

As migrações 019–027 adicionam setores, grupos, definições de exames, serviços gerais, tarefas, planos, plantões, checklists, inventário, colaboração e capacidades externas. A 024 é `024_hospital_planning_resources` (118 permissões); a 025 é `025_hospital_collaboration` (146); a 026 é `026_hospital_external_capabilities` (148). A 027, `027_hospital_his_v4_deliveries`, acrescenta recibos deduplicados do HIS sem ampliar permissões. As migrações publicadas anteriores permanecem imutáveis. Ao acrescentar comandos, somente o grupo de sistema que ainda corresponde integralmente à matriz anterior recebe a ampliação. Grupos personalizados ou reduzidos conservam suas restrições. Versões e sessões dos usuários afetados são atualizadas; planejar novo login depois da atualização.

Seguir a janela e o procedimento de [cutover coordenado](DEPLOYMENT.md#41-atualizacao-que-contem-as-migrations-013-014-ou-015-cutover): identificar imagem/commit e versões, ensaiar backup e restauração em alvo isolado, interromper app e worker, aplicar as migrações com o runtime parado, validar e reiniciar. A trava de migração recusa sessões concorrentes; não a contornar para manter um runtime antigo em operação. Usar o pipeline de manutenção existente. Registrar o ponto de retorno e a evidência do ensaio antes da aplicação.

O pacote inicia as novas coleções vazias. Não cria recursos hospitalares reais, espécies compatíveis, plantões, aprovações clínicas ou ocupações fictícias. Antes de ampliar um grupo reduzido, revisar a diferença efetiva com seu responsável; não substituí-lo silenciosamente pela matriz de sistema.

## Inventário e internações existentes

Cadastrar os recursos reais por setor. Profissional deve corresponder a um usuário ativo e integrante da equipe; sala e equipamento precisam de janelas explícitas de disponibilidade. Disponibilidade ausente significa **desconhecida**, sem capacidade horária presumida. Leito exige ala, identificação e espécies compatíveis; sua ocupação vem exclusivamente de `Admission`.

Reconciliar as internações vigentes sem `bedResourceId` por mudança de leito explícita e auditada, com a política D-01 adotada. Não deduzir IDs a partir de nomes antigos. Enquanto houver ocupação sem vínculo no setor, o censo sinaliza `UNRECONCILED` e novas ocupações em leitos registrados são recusadas; leitura, assistência existente e alta permanecem disponíveis. Capacidade de leitos fica desconhecida até a reconciliação. Não remover internações para liberar o bloqueio.

Novas reservas e internações em produção exigem IDs cadastrados. O texto legado continua legível; ele não comprova disponibilidade. Ao iniciar um exame com reserva de inventário, validar reserva vigente, recursos atuais, profissional elegível e intervalo `[início,fim)`. Mudança de horário exige remarcação explícita. Uma execução ainda em andamento mantém o recurso ocupado, inclusive depois do término planejado. Agenda e capacidade não suspendem nem recalculam o SLA diagnóstico.

## Modelos, recorrência e assistência

Preparar os checklists e submeter sua aprovação ao profissional autorizado. Para cuidado/procedimento, registrar modalidade, perfis executores, política de confirmação e sistema de prontuário adotados. A aprovação de conteúdo do hospital deve ser real e rastreável. Revisões não reescrevem os snapshots já utilizados.

O worker existente verifica rotinas a cada minuto, com até 100 ocorrências por lote. A ocorrência e seu cursor são persistidos atomicamente; dois workers não duplicam a mesma tarefa. Cada geração revalida autor, permissões, modelo e contexto. Falhas mantêm o cursor e aparecem em `lastError`, auditoria e no evento operacional `hospital.recurrence_blocked`. A geração cria trabalho pendente: não executa cuidado nem confirma etapas clínicas. Verificar atrasos de geração e bloqueios antes do piloto.

Concluir um cuidado exige comando próprio, confirmação explícita, executor elegível, etapas obrigatórias cumpridas e referência ao prontuário. Essa referência registra a declaração do executor; não comprova entrega a um sistema externo. Fechar um plano e aceitar uma passagem de plantão também não encerram exames, não alteram SLA e não confirmam alertas críticos.

## Colaboração, indicadores e instituição

A 025 inicia documentos, comentários, anexos de tarefas, preferências, avisos de trabalho, relatórios, jobs, configuração institucional e convites vazios. Anexos reutilizam armazenamento privado e scanner exigido: ensaiar upload real, quarentena, download depois de finalização e retirada de acesso. Biblioteca começa sem conteúdo aprovado; cadastrar documentos institucionais e capturar suas versões explicitamente nas tarefas/planos.

Além de recorrências, o worker existente verifica relatórios e avisos de prazo a cada minuto. Um lote gera até dez relatórios; cada job limita-se a 50 mil linhas. Falhas persistem e o operador solicita retry explícito. Avisos processam até 100 tarefas elegíveis por lote e deduplicam o evento por usuário, tarefa e prazo. Conferir `hospital.report_batch`, `work.notification_batch`, status dos jobs e heartbeat; recibo de leitura não confirma crítico, aceite de plantão ou execução.

Configurar nome e fuso IANA da instituição com versão inicial zero no corpo. O fuso deve corresponder ao `APP_TIMEZONE` da API e ao `NEXT_PUBLIC_HOSPITAL_TIMEZONE` compilado na interface. Alteração de fuso exige reconstruir a release com o mesmo argumento nas imagens app/ops; o procedimento de deploy confere configuração e labels antes de parar serviços ou migrar. A gestão pode impedir novas atividades por módulo/setor conservando assistência pendente. Convites mantêm token no fragmento do navegador, retornam o segredo uma vez e exigem escolha de senha pelo destinatário; verificar grupo e delegação antes da emissão. Não distribuir contas administrativas pelo fluxo de convite.

Homologar as definições `HPL-OPERATIONAL-1` e reconciliar agregado, drill-down e exportação com a equipe. Pendência é coorte no estado atual; início planejado do plantão não significa presença. Exportação consulta autorização ao gerar e novamente ao baixar, preservando fatos capturados mesmo quando a atividade muda de fase. Purga ou perda de acesso omite a linha; referências clínicas frias usam o arquivo nativo. Job de handover sem a referência privada da passagem original deve ser gerado novamente, sem inferir outra passagem. O conteúdo histórico de uma tarefa arquivada pode continuar nas métricas; rascunhos permanecem excluídos.

## Capacidades externas opcionais

O dono informou que o hospital usa o `cvg-his-v4` instalado nesta VPS. LIS e PACS ainda não foram identificados. Registrar compatibilidade do HIS adotado e seu contrato antes de habilitar tráfego; a presença na mesma VPS não autoriza escrever diretamente no banco ou dispensar credenciais e recibos. A 026 inicia somente coleções vazias de credenciais, mensagens e sugestões.

O perfil `HIS_V4` usa descoberta do catálogo com `X-API-Key` e ingresso de webhook v2 com assinatura HMAC do timestamp e corpo original, tolerância de 300 segundos e identificação explícita de conta, webhook e credencial. O evento `encounter.created` em estado HIS `reception` pode criar uma demanda `RECEIVED` para triagem humana. Ele exige um vínculo previamente conciliado entre paciente/atendimento HIS e paciente/atendimento Hub; vínculo ausente recusa o evento sem criar trabalho. Configurar esse perfil pelos parâmetros `HOSPITAL_HIS_V4_*` e pelo procedimento de [capacidades externas](HOSPITAL_EXTERNAL_CAPABILITIES.md); as credenciais do protocolo CVG genérico não substituem as do HIS.

A fonte inspecionada do HIS é o commit `0ebfc5b6627c8ed006075dc5285fd3514443c806`. A [observação de proveniência instalada](HIS_V4_INSTALLED_PROVENANCE_2026-10-11.json) registra IDs/digests das imagens SPA/API/worker, tag `272581dc60b7`, sem labels de revisão/origem; correspondência à fonte permanece `UNKNOWN`. Foram consultados somente metadados, sem Env, segredos, API clínica ou banco. Correlacionar artefato e fonte/contrato e ensaiar a jornada real antes da ativação. O HIS rejeita destinos privados de webhook; definir um endpoint HTTPS aceito pela política dele, sem relaxar a proteção para usar loopback ou rede interna. A instalação na mesma VPS, por si só, não resolve esse requisito.

Integrações ficam desligadas por padrão. Para cada sistema adotado, configurar `HOSPITAL_INTEGRATION_{HIS|LIS|PACS}_ENABLED=true`, endpoint HTTPS, `ALLOWED_HOSTS`, `ALLOWED_IPS`, `TOKEN_FILE`, `HMAC_SECRET_FILE`, `CONTRACT_REFERENCE` e, se necessário, `CA_FILE/TIMEOUT_MS`. Usar caminhos absolutos de arquivos privados de segredos; nunca colocar seus valores no backlog. TLS, assinatura HMAC, finalidade, escopo, sequência, idempotência e recibo remoto são exigidos. Credenciais emitidas na aplicação são limitadas ao ingresso dedicado e não autenticam a API geral. Homologar duplicidade, ordem, rotação, revogação e falha com o sistema real antes do piloto; destinos sintéticos provam os controles locais.

IA também fica desligada por padrão. Habilitação exige `HOSPITAL_AI_ENABLED=true`, fornecedor/modelo, `DECISION_REFERENCE`, `PURPOSE=OPERATIONAL_DOCUMENT_TEXT` e configuração HTTPS/allowlists/arquivos de segredo do transporte sob prefixo `HOSPITAL_AI_`. A interface pede confirmação para transmissão e revisão humana para aplicar ou rejeitar a sugestão. Aplicação altera somente o rascunho atual; aprovação de documento e comandos assistenciais continuam explícitos e separados. Homologar fornecedor, finalidade e conteúdo autorizado antes de transmitir dados.

## Evidência e liberação

As verificações locais de migração, contratos, reserva/ocupação concorrentes e ocorrência durável usam PostgreSQL descartável e fixtures sintéticas. Registrar o resultado integrado contra o candidato definitivo; não somar contagens de frentes que se sobrepõem nem reaproveitar resultados de um código anterior.

O gate BLD-HPL-051 continua aberto até existirem conteúdo clínico aprovado, jornadas com os perfis reais, inventário conciliado, volume representativo, backup/restore completos, observabilidade e aceite nominal no ambiente alvo. Usar o [pacote de UAT e piloto](HOSPITAL_PLANNER_PILOT.md) para registrar candidata, pré-requisitos, testes permitidos/negados, jornada HIS v4, resultados e assinaturas. Os critérios detalhados permanecem no [backlog](../build/BACKLOG_HOSPITAL_PLANNER_2026-10-11.md#bld-hpl-051) e no [checklist de produção](RELEASE_CHECKLIST.md).
