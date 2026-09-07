# Evidência AAA-3 — PostgreSQL 16 / Node 22 revalidação corrente

**Data:** 07/09/2026 04:52–04:53 (America/Sao_Paulo)  
**Classificação:** integração local sintética; nenhuma autoridade clínica ou produtiva é alegada.

- Runtime: Node `v22.23.2`, npm `10.9.8`.
- Cluster PostgreSQL `16.15` novo, loopback `127.0.0.1:55483`, socket privado em diretório temporário.
- Comando: `ALLOW_POSTGRES_INTEGRATION_TESTS=true POSTGRES_TEST_ADMIN_URL=postgresql://ricardo@127.0.0.1:55483/postgres npm run test:postgres -- --run --reporter=dot`.
- Resultado: **5 arquivos, 33/33 testes PASS**, duração `43.92 s`.
- Log bruto temporário: `/tmp/cvg-aaa3-postgres.vFrYOD/postgres-tests.log`.
- SHA-256 do log: `2ff2ace297f94b17b9efeaf828da340a488c3b2d9245ec7226bbfc857cc1ce35`.
- O cluster foi parado ao final; `127.0.0.1:5432` permaneceu intocado.

O pacote prova migrations, constraints, projeção/reconciliação, backfill/replay e contratos de integração no cluster descartável. Não prova que a projeção relacional seja a autoridade clínica, nem cutover, workload aprovado, failover, restore de ambiente-alvo ou release.
