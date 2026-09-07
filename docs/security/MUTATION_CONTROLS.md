# Controles de mutação e regressão negativa

O controle `npm run test:mutation` cria uma cópia temporária do workspace, injeta sete mutações deliberadas em fronteiras de alto risco e exige que as suítes focais falhem. A execução corrente está registrada no [packet Node 22](../../.orchestrate/aaa3-execution-20260907/mutation-controls-node22-20260907.md).

As fronteiras cobertas são autorização, versão otimista, checksum de migrations, MIME de upload, lease/deduplicação do outbox, replay realtime e integridade de recovery. Cada mutação exige um único ponto de substituição; ausência ou ambiguidade do ponto faz o harness falhar fechado.

O job `verify` do CI também executa `npm run test:mutation` após a suíte de
cobertura. A configuração do pipeline aumenta a proteção contra regressões,
mas só uma execução remota bem-sucedida pode ser usada como evidência do gate
de CI; o packet local continua sendo classificado separadamente.

Este é um controle local de sensibilidade das regressões. Ele não substitui revisão independente, mutation testing completo, CI remoto, ambiente-alvo, pentest, aceite clínico ou decisão de release.
