# Revisão independente read-only — rodada 3

**Data:** 07/09/2026  
**Natureza:** crítica adversarial de contexto fresco, sem alteração de arquivos e sem tocar a instância PostgreSQL persistente `127.0.0.1:5432`.  
**Status:** `BLOCKED` para `AAA-READY` e para qualquer claim de release.

## Escopo e resultado

O crítico independente reexecutou a leitura do candidato local, dos artefatos de governança, dos controles de segurança e das evidências disponíveis. A devolutiva confirmou que a base automatizada é forte, mas que o candidato permanece bloqueado por gates humanos, de ambiente-alvo e de autoridade clínica.

Na fotografia observada pelo crítico, os seguintes pontos foram registrados para tratamento pelo coordenador:

- o fingerprint do candidato ainda estava defasado em relação à árvore corrente;
- `x-correlation-id` fornecido pelo chamador podia carregar um valor clínico até a superfície de logging;
- havia discrepância documental entre SBOM com 541 e 560 componentes;
- o contrato de observabilidade ainda precisava explicitar os campos permitidos e a separação entre log HTTP e auditoria;
- a lista corrente de arquivos abaixo de limiar de cobertura ainda não refletia o novo teste.

## Disposição após a crítica

Esses achados locais foram tratados antes do fechamento desta rodada:

- o logger aceita como correlação preservável somente o formato gerado pelo servidor (`corr_<UUID>`); valores externos são normalizados para `external`, sem alterar o contrato de resposta da API;
- o SBOM corrente é produzido e validado sob Node 22.23.2, com 560 componentes, e essa condição está explicitada nos documentos e no CI;
- o contrato do logger foi documentado com allowlist, limites, redaction e separação da trilha de auditoria;
- a fotografia final registra 39 arquivos abaixo de pelo menos um limiar individual;
- o fingerprint será recalculado depois de todos os artefatos desta rodada, excluindo apenas o próprio manifesto para evitar autorreferência.

## Revalidação final local

Após o tratamento, a validação ampla corrente passou com **660/660 testes em 79 arquivos**, cobertura agregada de **92,17% lines, 94,01% functions e 85,24% branches**, OpenAPI **65 operações/60 paths**, rastreabilidade **43/43**, migrations **001–010**, build Next.js e `git diff --check`. A suíte PostgreSQL descartável permanece **39/39**, e as lanes browser locais registradas permanecem **36/36**, **9/9**, **9/9** e **51/51** conforme os packets vinculados.

## Bloqueios que permanecem

O resultado independente continua `BLOCKED` porque ainda não há evidência aceita para: D-01–D-06; autoridade relacional/cutover/rollback; volume e skew representativos; failover, dois workers e deduplicação distribuída; restore completo de banco, objetos, configuração e chaves dentro de RPO/RTO aprovado; scanner/storage/secrets/egress reais; CI remoto; pentest; revisão manual de acessibilidade, touch e jornadas clínicas; piloto e decisão formal de release.

Este packet é uma transcrição coordenada da devolutiva read-only do crítico e da disposição verificável posterior; não é aprovação independente nem substitui a assinatura dos responsáveis.
