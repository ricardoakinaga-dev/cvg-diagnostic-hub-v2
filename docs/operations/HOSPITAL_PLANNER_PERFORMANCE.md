# Carga sintética do planner hospitalar

O comando `npm run perf:hospital:planner` mede HTTP real contra um bundle Next em modo production e PostgreSQL descartável. Complementa `perf:hospital`, que mede o fluxo diagnóstico. O perfil próprio do planner cobre documentos, tarefas, planos, recursos, reservas, agenda, capacidade e indicadores. Seus resultados são regressões técnicas locais; o volume e o aceite do hospital continuam no [gate 051](../build/BACKLOG_HOSPITAL_PLANNER_2026-10-11.md#bld-hpl-051).

## Preparação e execução

Use uma cópia privada das fontes, sem arquivos de ambiente reais, e um PostgreSQL criado exclusivamente para este ensaio. O harness cria, migra e remove seu banco de teste; a instância administrativa deve pertencer ao ensaio e atender à validação de endereço loopback do harness. A execução recusa arquivos `.env` conhecidos na raiz e exige duas confirmações explícitas por variável. Essas confirmações identificam o contexto sintético; elas não autorizam usar uma base hospitalar existente.

| Variável | Significado |
| --- | --- |
| `PERF_HPL_ALLOW_ISOLATED_RUN=true` | Executar na cópia privada destinada ao ensaio. |
| `ALLOW_POSTGRES_INTEGRATION_TESTS=true` | Habilitar o harness PostgreSQL descartável. |
| `POSTGRES_TEST_ADMIN_URL` | URL administrativa do PostgreSQL exclusivo do ensaio, em loopback. Deve ficar na configuração temporária do executor. |
| `PERF_HPL_JOURNEYS` | Quantidade de jornadas: padrão 12, intervalo 1–500. |
| `PERF_HPL_CONCURRENCY` | Jornadas simultâneas: padrão 2, intervalo 1–20, sem ultrapassar a quantidade de jornadas. |
| `PERF_HPL_READ_ROUNDS` | Rodadas de consulta por jornada: padrão 3, intervalo 1–100. |
| `PERF_HPL_CONTENT_CHARS` | Tamanho sintético declarado do conteúdo; o programa aplica o limite aceito pela API. |

O comando aceita `--output=/caminho/novo/report.json`, cria o relatório com modo `0600` e recusa sobrescrever um arquivo existente. O executor deve registrar, junto ao relatório, a imagem usada, os limites reais de CPU/memória, as fontes da cópia, o código de saída e a remoção dos recursos próprios. O total de CPUs do host não representa o limite do contêiner.

## Jornadas e autoridade

O gestor mantém seu perfil padrão e recebe delegação somente para ultrassom. O operador usa o perfil normal da equipe de ultrassom; laboratório serve como conta fora do escopo. Nenhum perfil é promovido a superadmin para fazer o ensaio passar. As sessões são sintéticas e previamente inseridas; o custo do login não integra a medição.

Cada jornada cria, edita e aprova um documento sintético, captura sua revisão em uma tarefa, vincula a tarefa a um plano de paciente/atendimento sintéticos, cria uma sala com disponibilidade explícita e reserva o intervalo. Consulta listas e detalhes, agenda, capacidade e indicadores; inicia e conclui a tarefa e fecha o plano. A aprovação do documento é identificada como controle sintético e não aprova protocolo do hospital. O encerramento do plano não executa atividades clínicas.

As leituras de uma rodada usam chamadas paralelas. A concorrência configurada controla jornadas; o relatório deve distinguir esse valor da quantidade de requisições HTTP simultâneas. A geração é um circuito fechado, sem extrapolação para taxa de chegadas ou capacidade hospitalar.

## Critérios e limites

O perfil preserva os limites técnicos existentes: p95 de leitura até 500 ms, p95 de escrita até 800 ms e taxa de erros até 1%. Além da latência, exige ausência de duplicação, revisão documental capturada, vínculo único e contagem coerente de atividades, unidades de capacidade explícitas e uma única reserva vencedora na disputa pelo mesmo recurso.

Recusas esperadas de acesso e de versão/reserva são controles de correção separados do orçamento de erro do caminho de sucesso. Falha inesperada, transporte inválido, jornada incompleta, integridade divergente ou fonte modificada fazem a execução falhar. A retirada de permissões altera somente os grupos sintéticos do banco descartável e verifica acesso atual por HTTP; não mede a administração de grupos.

O armazenamento é uma sonda HTTP de saúde sintética. Anexos, scanner, entrega a fornecedores, TLS/rede institucional, carga de várias instâncias, recuperação externa e aceite nominal permanecem fora desta medição. O ensaio deve ser repetido no alvo com volume e processos aprovados, seguindo o [pacote de piloto](HOSPITAL_PLANNER_PILOT.md) e a [operação de monitoramento](MONITORING.md).

Os testes de configuração e de jornadas nativas ficam em `npm run test:perf:planner`, também incluído em `npm run test:perf` e na suíte unitária de cobertura. Uma regressão unitária não substitui a execução HTTP/PostgreSQL do perfil.
