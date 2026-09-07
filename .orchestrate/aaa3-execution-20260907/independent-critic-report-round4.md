# Revisão independente read-only — rodada 4

**Data:** 07/09/2026  
**Natureza:** rechecagem adversarial em contexto fresco, sem alteração de arquivos e sem tocar a instância PostgreSQL persistente `127.0.0.1:5432`.  
**Status:** `BLOCKED` para `AAA-READY` e para qualquer claim de release.

## Resultado da rechecagem

O crítico confirmou que o pacote local está internamente consistente nos pontos
corrigidos nesta rodada:

- o contrato em [`REALTIME.md`](../../../docs/spec/REALTIME.md) corresponde
  exatamente ao envelope emitido por `realtime-stream.ts`: `eventId`, `type`,
  `occurredAt`, `entityType`, `entityId` opaco e `correlationId`; o evento SSE
  é `diagnostic.updated`;
- o manifesto registra a fotografia corrente de **665 testes**, **92,25% de
  linhas**, **85,25% de branches** e **94,20% de funções**;
- os documentos AAA-2 têm marcação explícita de históricos superseded e não
  são tratados como evidência corrente do AAA-3;
- o manifesto mantém `PASS_WITH_CONDITIONS` apenas para a automação local,
  `BLOCKED_REVIEW_REQUIRED` no veredito AAA-3 e `release_claim=false`;
- o PostgreSQL persistente `127.0.0.1:5432` não foi tocado.

## Disposição

O achado remanescente da rodada anterior — a referência ao relatório
`round3` com métricas antigas — é tratado como histórico imutável. Esta rodada
é o packet fresco vinculado ao manifesto e fixa a fotografia atual; o packet
antigo permanece arquivado para preservar a cadeia de auditoria.

## Bloqueios que permanecem

O bloqueio não é um defeito que possa ser removido apenas por edição local.
Continuam abertos: decisões D-01–D-06; autoridade relacional, cutover e
rollback; rerun da suíte PostgreSQL contra um cluster descartável disponível;
volume/skew representativos; failover, dois workers e deduplicação distribuída;
restore completo de banco, objetos, configuração e chaves dentro de RPO/RTO
aprovado; scanner/storage/secrets/egress reais; CI remoto; pentest; revisão
manual de acessibilidade, touch e jornadas clínicas; piloto; e assinatura
formal de release.

Esta é uma crítica independente read-only e não constitui aprovação
independente, homologação clínica, autorização operacional ou autorização de
release.
