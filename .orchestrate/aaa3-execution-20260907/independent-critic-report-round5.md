# Parecer independente — rodada 5

**Status:** `BLOCKED`

**AAA-READY/release:** `BLOCKED`. A inspeção do quality bar e do manifesto confirma `BLOCKED_REVIEW_REQUIRED`, `PASS_WITH_CONDITIONS` apenas para a automação local e `release_claim: false`. Não há aprovação clínica, operacional, externa ou de release inventada.

**Números atuais.** Confirmo-os como a evidência documental corrente, não como uma nova execução: **712 testes em 86 arquivos**; cobertura **92,69% linhas / 85,96% branches / 94,40% funções**. O manifesto e `scripts/validate-aaa3-evidence.mjs` são consistentes nesses valores; o validador fixa 712 e as três coberturas, mas não conta independentemente os 86 arquivos. A inspeção não encontrou contradição, e não rodei suíte nem PostgreSQL.

**API e testes novos.** `packages/ui/src/index.tsx` adiciona `ActionButton` com `tone`, `icon` e estados `idle/pending/confirmed/failed/unknown/denied`; `pending`/`denied` desabilitam, e `pending` expõe `aria-busy`. `packages/ui/src/index.test.tsx` cobre defaults, tons, props e estados. `src/components/workflow-action.tsx` consome a API; `src/components/workflow-action.test.tsx` mocka `next/link` e espiona `apiFetch`, cobrindo amostra, agenda/reagenda, recoleta, erro, draft e liberação. São testes UI/componente mockados: não provam rota real, autorização, persistência, PostgreSQL, idempotência nem aceitação manual/browser-device.

**Gates D-01–D-06 ainda abertos.**

- **D-01:** identidade, ownership, alta/baixa e política de contexto de admissão.
- **D-02:** estados de resultado e autoridade para amendment/void.
- **D-03:** aprovação da política de resultado crítico.
- **D-04:** ownership de SLA e escalonamento.
- **D-05:** infraestrutura alvo, PostgreSQL relacional/cutover, backup/restore, RPO/RTO e autoridade multi-instância.
- **D-06:** piloto, treinamento, suporte e autoridade formal de release.

Restam também o rerun source-current em PostgreSQL descartável, prova de volume/skew e rollback/cutover; carga, failover, recuperação e deduplicação realtime no alvo; scanner/object storage/alertas/on-call reais; CI remoto clean-checkout, provenance/target approval; e revisão manual de screen reader, toque e aceite clínico/hospitalar. Portanto, o parecer final permanece **BLOCKED para AAA-READY/release**. O mutation sentinel não foi executado neste turno.
