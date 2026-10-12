# VPS selecionada para homologação do planner

Em 12/10/2026, o solicitante confirmou: “podemos usar esse ambiente mesmo que ja é para testes”. **Esta VPS foi selecionada como alvo de homologação.** O responsável pela validação dos fluxos e pelo aceite é o solicitante, conforme o [registro de responsabilidade](HOSPITAL_PLANNER_PILOT_OWNER_2026-10-12.json). A [decisão estruturada](HOSPITAL_PLANNER_TEST_ENVIRONMENT_2026-10-12.json) conserva a declaração e os limites.

A seleção não registra instalação nova, UAT realizado, aprovação clínica, go-live ou autorização para alterar os serviços existentes. O gate **BLD-HPL-051 continua OPEN**; a homologação externa de **042 permanece pendente**. Provas técnicas sintéticas anteriores conservam seu próprio escopo e não passam a ser aceite do hospital.

Antes de iniciar o ambiente, seguir a separação prevista em [DEPLOYMENT, §13.1](DEPLOYMENT.md#131-dois-ambientes-nada-em-comum-prod-301): projeto sem colisão, rede, volumes, banco, bucket, contas, configuração e segredos próprios. Preservar todos os programas, bancos, dados, arquivos de ambiente e portas já instalados. Os novos ensaios usam dados sintéticos; os limites de CPU, memória e disco serão definidos e conferidos antes da execução. A limpeza alcança somente recursos próprios, sem parada ou remoção dos programas existentes.

Nenhuma porta foi inspecionada ou reservada nesta tarefa documental. Escolher uma porta livre no início do ensaio, preferindo alocação dinâmica em `127.0.0.1` para o app e acesso restrito por túnel/VPN quando necessário. A URL ainda será registrada; PostgreSQL, MinIO, scanner e Docker não recebem portas públicas para o ensaio.

Continuam pendentes:

- Pico de usuários simultâneos e metas de carga representativas.
- Endpoint e jornada homologada do `cvg-his-v4` informado como instalado nesta VPS; esta decisão não atesta a revisão em execução.
- Identificação de LIS/PACS, que permanecem desconhecidos e desligados até homologação.
- Candidata/digests/schema, escopo de jornadas, resultados e aceite nominal.

O [pacote de piloto](HOSPITAL_PLANNER_PILOT.md) e o [cutover](HOSPITAL_PLANNER_CUTOVER.md) continuam sendo as fichas de preparação e execução. Este registro não executou testes, Docker, implantação ou alterações nos serviços da VPS.
