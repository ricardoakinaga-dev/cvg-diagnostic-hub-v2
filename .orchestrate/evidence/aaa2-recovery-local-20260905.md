# AAA2-044/045 recovery and governance local evidence — 2026-09-05

**Estado:** `CONDITIONAL` para a fatia local; `BLOCKED EXTERNAL` para o aceite AAA-2/NFR-OPS-001 completo.

Este packet registra contratos executáveis e verificações locais. Não é um restore de PostgreSQL/object storage em homologação, não mede RPO/RTO e não contém segredos, chaves ou dados clínicos.

## Prova executada

| Verificação | Resultado | Limite |
| --- | --- | --- |
| `npm run test:recovery` | **PASS** — 5 testes: manifesto de banco/object metadata/config refs, checksum/tamanho em conjunto copiado, mismatch de artefato, plano isolado sem escrita, traversal/duplicidade/redaction guard e objetivos RPO/RTO não aprovados | Fixtures são arquivos sintéticos locais; não são dumps válidos executados, bucket ou aplicação restaurada |
| `node --test scripts/backup-restore.test.mjs` | **PASS** — 3 contratos: backup gera manifesto, restore exige manifesto + opt-in, smoke verifica manifesto/checksum e identifica `NOT_CAPTURED` para object storage | Inspeção estática dos scripts; Docker/PostgreSQL não foi executado |
| `npm run typecheck` | **PASS** na verificação consolidada após a correção do mock relacional; o novo módulo não introduziu erro próprio | O resultado continua limitado à análise estática local |
| `npm run lint` | **PASS** | Lint local apenas |
| CLI `create`, `verify`, `plan` com fixture sintética | **PASS** — manifesto criado, checksum verificado e plano `DRY_RUN` emitido sem `pg_restore`, cópia de objeto, recuperação de chave ou inicialização da aplicação | Não prova semântica de banco nem leitura clínica |

## Contrato entregue

- [`src/server/operations/recovery-manifest.ts`](../../src/server/operations/recovery-manifest.ts) define manifesto versionado com artefato `pg_dump-custom`, inventário de object storage, metadata por objeto, referências de configuração sem valores, checksum SHA-256, tamanho, guard de isolamento e estados explícitos `CAPTURED`/`NOT_CAPTURED`.
- [`scripts/recovery-manifest.ts`](../../scripts/recovery-manifest.ts) implementa `create`, `verify` e `plan`; o plano é somente leitura e rejeita alvo igual à origem ou raiz do sistema.
- [`scripts/backup-db.sh`](../../scripts/backup-db.sh) cria o manifesto ao lado do dump e aceita inventário de objetos/config refs por referências externas; ausência de inventário deixa o estado `NOT_CAPTURED`.
- [`scripts/restore-db.sh`](../../scripts/restore-db.sh) exige `ALLOW_DB_RESTORE=true`, manifesto correspondente e verificação do artefato exato antes de chamar `pg_restore`.
- [`scripts/backup-restore-smoke.sh`](../../scripts/backup-restore-smoke.sh) mantém banco descartável e limpeza por `trap`; o smoke declara explicitamente quando object storage não foi capturado.
- [`src/server/operations/data-governance-policy.ts`](../../src/server/operations/data-governance-policy.ts) adiciona guard local para residência, classes de retenção, exportação escopo-limitada, eliminação com aprovação e auditoria imutável. Sem política aprovada, toda decisão falha fechada.

## Limites que continuam abertos

1. D-05/OQ-013 ainda não fornece política institucional aprovada de retenção, residência, exportação/eliminação, chaves, provedor ou RPO/RTO; os guards não inventam esses valores.
2. O manifesto pode carregar referências e metadata de objetos, mas o backup atual não coleta automaticamente anexos de um bucket nem metadados reais de KMS.
3. Não houve `ALLOW_POSTGRES_INTEGRATION_TESTS=true`, banco vivo, restore em ambiente vazio, consulta de linhagem, leitura pela aplicação, duas instâncias, medição de perda/tempo ou aceite humano.
4. `PASS` de checksum comprova bytes e tamanho do artefato referenciado; não comprova integridade relacional, constraints, migrations, autorização clínica, disponibilidade ou recuperação operacional.

Portanto AAA2-044/045 permanecem **IMPLEMENTED LOCAL / CONDITIONAL**, e NFR-OPS-001 permanece sem aprovação final até a execução externa e assinatura exigidas pelo plano.
