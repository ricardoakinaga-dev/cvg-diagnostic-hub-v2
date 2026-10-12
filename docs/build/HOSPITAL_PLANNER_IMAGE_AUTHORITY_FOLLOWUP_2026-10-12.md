# Planner hospitalar — imagens e autoridade persistida

**Data:** 12/10/2026 · **Estado:** alterações preparadas para uma nova candidata; CI, quatro imagens com revisão e execução da fonte commitada pendentes. [Evidência](HOSPITAL_PLANNER_IMAGE_AUTHORITY_FOLLOWUP_2026-10-12.json) · [Fonte selecionada](HOSPITAL_PLANNER_IMAGE_AUTHORITY_SOURCE_MANIFEST_2026-10-12.json) · [PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/78).

## Problema e mudança

`FACT` — A CI da candidata anterior `eacb520e4b71aeb2f6e0283de4fc08af5cafd661`, [38217435108](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/38217435108), passou: 5.319 testes unitários, 141 PostgreSQL, 195 cenários principais de navegador e 48 jornadas PostgreSQL. A varredura original das imagens excluía vulnerabilidades sem correção publicada. A varredura ampliada das quatro imagens encontrou 103 registros HIGH/CRITICAL em app/ops, correspondentes a 14 CVEs; MinIO/mc e segredos tiveram zero achados. A adjudicação manteve sete CVEs abertos. Esse resultado não equivale a 103 defeitos distintos do produto.

`DECISION` — App e ops passam a usar a mesma base Alpine/musl, com o índice multiarch Node 22 fixado por digest. Dependências nativas são instaladas novamente nessa base; não há cópia de dependências Debian. A imagem ops conserva o tsx local e remove os gestores globais npm/npx/Yarn/corepack, que não são necessários para seus entrypoints. A imagem web remove os mesmos executáveis. CI e release mantêm severidades e reprovação por HIGH/CRITICAL e passam a incluir achados sem correção disponível, sem supressões novas.

`FACT` — Os comandos Compose de migração, bootstrap e worker já usam tsx diretamente. Os exemplos de retenção e arquivamento foram alinhados a esses comandos. Backup/restore executados no host conservam seus clientes e dependências de host.

## Ensaios anteriores à adoção

`FACT` — Duas imagens de protótipo foram construídas de um archive exato de EACB com um Dockerfile privado explícito. Suas labels e logs dizem `SOURCE_REVISION=unknown`, protótipo e fonte não commitada; não são imagens de release. Os dois scans incluíram vulnerabilidades não corrigidas e segredos, sem supressões, com zero achados HIGH/CRITICAL e zero segredos. Foram gerados dois SBOMs CycloneDX. O índice de base conferido no registry corresponde ao material de build e inclui cinco plataformas Linux; apenas `linux/amd64` foi exercitada.

`FACT` — O ensaio nativo final passou **63 verificações e 20 jobs**, incluindo um job negativo com exit 1 esperado. Validou Sharp/libvips, Intl/fuso e DST histórico, TLS com CA confiável e recusa da CA ausente, migrações e papéis de banco limitados, bootstrap real, login/negativas com conta veterinária comum, tarefa operacional, upload/finalização/download de anexo CLEAN e recusa de finalização/download de anexo QUARANTINED. Validou também pg_dump/pg_restore entre bancos próprios, manifesto/checksums, plano de anexos, reconciliação, rejeição de cópia corrompida, retenção, archive dry-run sem alteração nas tabelas verificadas e worker real com heartbeat saudável.

O transporte HTTPS de scanner usa um veredito sintético determinístico. Ele comprova a chamada do adaptador e a aplicação da quarentena; **não comprova eficácia de antivírus, ClamAV ou EICAR**. A retenção foi uma execução real em banco sintético próprio; esse CLI não possui dry-run. A recuperação não comprova destino externo hospitalar, PITR nem RPO/RTO institucionais.

As três tentativas anteriores do smoke permanecem FAIL: inspeção de `Config.User` ausente no MinIO; Content-Type errado na fixture de upload; caminho relativo errado na fixture do manifesto. Somente o executor/fixtures foram corrigidos, preservando os guards do produto. Na execução final, todos os containers próprios, a rede própria e as chaves TLS efêmeras foram removidos; os 24 containers anteriores mantiveram suas identidades, estados e portas.

## PostgreSQL e matriz de acesso

`FACT` — O novo arquivo de integração acrescenta **20 cenários distintos**: 12 combinações de executor e criação/importação/reativação/transferência de exame; três casos de primeiro exame com catálogo vazio; prévia de impacto obsoleta e replay; reautenticação real; proteção do último administrador efetivo ADMIN e SUPERADMIN; e gravações concorrentes por dois stores independentes. Exercita login, troca de senha, revogação de sessão, API de serviço, auditoria/outbox, SQL e reabertura do store. Não usa MemoryStore nem autenticação simulada.

O primeiro ensaio executou 20 casos: **19 PASS e um FAIL**. A fixture de visibilidade concedia apenas `request.list`, embora a leitura de exames exija também `item.view`. Foi incluído esse grant no grupo sintético; as assertivas de acesso permitido/negado, rejeição da prévia obsoleta e ausência de mutação foram preservadas. O ensaio focado corrigido aprovou **um caso**, deixando 19 não selecionados. Os 20 casos estão cobertos por composição de duas execuções, **sem alegar um ensaio único corrigido de 20/20**. Os demais 19 corpos de teste e os helpers são idênticos. A próxima CI deve executar o arquivo completo.

Os checks de ausência de mutação comparam as projeções de autoridade, entidades, auditoria, outbox e remoções; a atividade legítima de sessão não está incluída nessa comparação. A disputa por dois stores comprova o resultado seguro, sem medir espera simultânea de locks. Esses testes são de serviços de aplicação; não acrescentam prova HTTP ou de navegador.

## Nova fonte e gates abertos

`FACT` — O manifesto usa a mesma política de seleção e o mesmo algoritmo da captura anterior: fontes, testes, deploy, workflows e oito documentos normativos. Inclui o novo arquivo PostgreSQL; relatórios e documentação operacional permanecem fora do fingerprint para evitar autorreferência. Este registro antecede o commit da nova fonte e não atribui a ela os resultados de EACB ou do protótipo. CI e evidências da fonte commitada serão vinculadas ao SHA no PR, sem reescrever os FAILs históricos.

`FACT` — A revisão suplementar anterior permanece **82,5/100, REPROVADA** para EACB, com contagem real HIGH/CRITICAL não atestável e sete CVEs ainda abertos naquela captura. A adoção proposta não altera retroativamente essa nota. A revisão externa contratada exigida por PROD-605 continua pendente.

`OPEN QUESTION` — Alpine usa musl; a documentação upstream do Node classifica o suporte amd64/musl como Experimental. O ensaio nativo reduz a incerteza de compatibilidade dessa candidata em amd64, sem alterar o suporte upstream nem provar outras arquiteturas. `apk upgrade` recebe atualizações do repositório Alpine; cada nova imagem requer seus próprios scans, SBOM e identificação.

Permanecem pendentes o alvo hospitalar e pico de carga aprovados, conteúdo clínico e inventário reais, acessibilidade manual, pentest/revisão externa, seis jornadas HIS reais e UAT/piloto/aceite. Os cinco p95 propostos falharam no benchmark anterior com 12 meses; o workload e a topologia do hospital ainda não foram aprovados. Os scans desta etapa cobrem as quatro imagens candidatas, sem certificar scanners, monitoring ou toda a VPS.

As 50 entregas, o gate 051, os 137 itens de origem, as 15 garantias e suas dependências conservam os critérios literais. Nenhum aceite institucional ou DONE é inferido destes ensaios. O solicitante fará a validação e o aceite, conforme o [registro de responsabilidade](../operations/HOSPITAL_PLANNER_PILOT_OWNER_2026-10-12.json) e o [pacote do piloto](../operations/HOSPITAL_PLANNER_PILOT.md). HIS informado: cvg-his-v4; LIS/PACS continuam desconhecidos e desligados. A instalação em uso não foi atualizada; merge, publicação e implantação permanecem fora desta etapa.
