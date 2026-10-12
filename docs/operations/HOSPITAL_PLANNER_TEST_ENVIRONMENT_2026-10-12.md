# VPS selecionada para homologação do planner

Em 12/10/2026, o solicitante confirmou: “podemos usar esse ambiente mesmo que ja é para testes”. **Esta VPS foi selecionada como alvo de homologação.** O responsável pela validação dos fluxos e pelo aceite é o solicitante, conforme o [registro de responsabilidade](HOSPITAL_PLANNER_PILOT_OWNER_2026-10-12.json). A [decisão estruturada](HOSPITAL_PLANNER_TEST_ENVIRONMENT_2026-10-12.json) conserva a declaração e os limites.

A confirmação inicial selecionou o alvo e o responsável pelo aceite. O ambiente isolado e o ensaio técnico posterior estão registrados em [UAT com 20 usuários](HOSPITAL_PLANNER_UAT_20_USERS_2026-10-12.md). O gate **BLD-HPL-051 continua OPEN**; a homologação externa de **042 permanece pendente**. Provas técnicas sintéticas conservam seu próprio escopo e não passam a ser aceite do hospital.

O solicitante também confirmou **20 usuários simultâneos** como pico a testar nesta VPS. Esse número define a concorrência do ensaio; não atesta capacidade medida, duração representativa nem aceite dos resultados. Registrar separadamente os tempos de resposta, erros, integridade e limites do teste executado.

Antes de iniciar o ambiente, seguir a separação prevista em [DEPLOYMENT, §13.1](DEPLOYMENT.md#131-dois-ambientes-nada-em-comum-prod-301): projeto sem colisão, rede, volumes, banco, bucket, contas, configuração e segredos próprios. Preservar todos os programas, bancos, dados, arquivos de ambiente e portas já instalados. Os novos ensaios usam dados sintéticos; os limites de CPU, memória e disco serão definidos e conferidos antes da execução. A limpeza alcança somente recursos próprios, sem parada ou remoção dos programas existentes.

A execução posterior verificou a disponibilidade da porta **18444** e publicou somente o proxy em `127.0.0.1` e no IP privado `192.168.15.8`: **https://192.168.15.8:18444**. PostgreSQL, MinIO e scanner permanecem na rede própria, sem portas publicadas. Certificado e contas de teste estão indicados no registro de UAT; os valores das senhas ficam na configuração privada.

Continuam pendentes:

- Duração, distribuição de jornadas e metas de carga representativas; o pico confirmado é de 20 usuários simultâneos.
- Endpoint e jornada homologada do `cvg-his-v4` informado como instalado nesta VPS; esta decisão não atesta a revisão em execução.
- Identificação de LIS/PACS, que permanecem desconhecidos e desligados até homologação.
- Candidata/digests/schema, escopo de jornadas, resultados e aceite nominal.

O [pacote de piloto](HOSPITAL_PLANNER_PILOT.md) e o [cutover](HOSPITAL_PLANNER_CUTOVER.md) continuam sendo as fichas de preparação e execução. Este registro não executou testes, Docker, implantação ou alterações nos serviços da VPS.
