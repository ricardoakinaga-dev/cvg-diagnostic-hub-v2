# Parecer independente — rodada 6

**Status:** `BLOCKED` para `AAA-READY` e release.

**Evidência documental corrente.** O packet registra **715 testes em 86 arquivos** e cobertura de **92,69% linhas / 86,00% branches / 94,40% funções**. Esses números são evidência documental, não resultado de nova execução. A documentação também registra a correção de `aria-controls`/`useId` e o teste de foco em `workflow-action`.

**Limites dos testes.** Os testes de `workflow-action` e demais testes UI/componente são mockados; não comprovam rotas reais, autorização, persistência, PostgreSQL, idempotência, integração distribuída ou aceitação manual em browser/dispositivo.

**Gates e provas externas abertas.** Permanecem abertos os gates D-01 (identidade/ownership e contexto de admissão), D-02 (estados e autoridade de amendment/void), D-03 (política de resultado crítico), D-04 (SLA/escalonamento), D-05 (infraestrutura, PostgreSQL, cutover, backup/restore, RPO/RTO e multi-instância) e D-06 (piloto, treinamento, suporte e autoridade formal de release). Também faltam rerun source-current em PostgreSQL descartável, volume/skew, rollback/cutover, carga/failover/recuperação/deduplicação realtime, scanner/object storage/secrets/egress e on-call reais, CI remoto clean-checkout/provenance/target approval, revisão manual de acessibilidade/touch e aceite clínico/hospitalar.

Não rodei a suíte, não toquei o PostgreSQL `127.0.0.1:5432` e não alterei outro arquivo. Este parecer não constitui aprovação clínica, operacional ou de release.
