# Backup and restore

**Knowledge status:** `DECISION/PROPOSAL` operacional; RPO/RTO e retenção aguardam aprovação de TI/gestão.

**AAA-2:** [barra](../build/AAA_2_QUALITY_BAR.md) · [plano](../build/AAA_2_EXECUTIVE_PLAN.md) · [roadmap](../build/AAA_2_ROADMAP.md) · [backlog](../build/AAA_2_BACKLOG.md) · [auditoria de 05/09/2026](../RELATORIO_AUDITORIA_2026-09-05.md)

## Current audit evidence (05/09/2026)

O contrato local de manifesto/checksum/plano dry-run está registrado no packet [`aaa2-recovery-local-20260905.md`](../../.orchestrate/evidence/aaa2-recovery-local-20260905.md). O packet AAA-2 [`aaa2-postgres-local-20260905.md`](../../.orchestrate/evidence/aaa2-postgres-local-20260905.md) permanece histórico e registra uma execução anterior em cluster PostgreSQL 16.15 descartável, `db:smoke` e `db:restore:smoke` direto. O packet V2 [`v2-relational-sample-lineage-backfill-20260906.md`](../../.orchestrate/evidence/v2-relational-sample-lineage-backfill-20260906.md) registra a execução atual 30/30 em cluster efêmero, incluindo migration 010, projection/read/reconciliation, `EXPLAIN` estrutural e wake-up PostgreSQL real; isso não é um restore. O packet browser production-like acrescenta um banco e serviços S3/scan sintéticos descartáveis, mas também não é um restore. Restore de object storage, metadados reais de chaves, aplicação restaurada, RPO/RTO aprovado e evidência de ambiente produtivo continuam ausentes. Este runbook permanece proposta operacional e não sustenta readiness de produção.

## 1. Scope

Backup must cover PostgreSQL data, object storage attachments, encryption/key metadata required to decrypt, configuration needed to rebuild and documented external references. The local manifest contract records these categories and marks uncaptured object inventory as `NOT_CAPTURED`; it does not collect provider data automatically. A database-only backup is insufficient for released result attachments. Clinical records archived after 24 months (`cvg_clinical_archive`, `cvg_clinical_archive_batches`; [CLINICAL_ARCHIVE](CLINICAL_ARCHIVE.md)) live in PostgreSQL, so they are part of the database backup and of its restore; their attachment objects stay in object storage until the legal-period purge.

## 2. Proposed pilot targets

`ASSUMPTION/PROPOSED`: RPO ≤ 15 minutes and RTO ≤ 4 hours for pilot. TI/management must approve or replace these targets before production.

## 3. Strategy

> **Scheduled backup in the production Compose.** The `backup` service writes a custom-format `pg_dump` every `BACKUP_INTERVAL_SECONDS` (default daily) into the `cvg-backups` volume, validates it with `pg_restore --list`, and keeps `BACKUP_RETENTION_DAYS` (default 14). It runs as the runtime role, so no administrative credential is stored in it. It lives on the same host as the database: copy the volume off the machine and rehearse the restore below. To take one on demand: `docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps backup --once`. Keep `--no-deps`: the `backup` service depends on `migrate`, so without it Compose applies pending migrations before taking the copy (verified 06/10/2026). Dump files are created owner-only (`umask 077`). These dumps carry no recovery manifest, so restore them with the procedure in §4.1, not with `npm run db:restore`.

### 3.1 Copy a dump off the host

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps \
  --entrypoint sh backup -c 'ls -1t /backups/cvg-*.dump | head -1'
docker compose -f docker-compose.prod.yml --env-file .env.production cp \
  backup:/backups/<file>.dump ./<file>.dump   # requires the backup service to be running
```

Then move the file to encrypted storage outside the machine and record its checksum (`sha256sum`).


- PostgreSQL: encrypted point-in-time/WAL plus periodic full backup; verify completion and size.
- Object storage: versioning/replication or scheduled encrypted snapshot according to provider; preserve checksum/metadata.
- Config/secrets: never backup plaintext secrets in repo; store recoverable references and rotation procedure.
- Retention: duration is OQ-013; do not enable deletion until approved.
- Separate credentials and backup access from application role; least privilege and MFA where available.

## 4. Restore runbook

1. declare incident and freeze writes if integrity is uncertain;
2. identify recovery point and scope (DB/files/config);
3. run the dry-run plan and verify that the target is isolated;
4. provision the isolated target with approved credentials before any destructive command;
5. restore PostgreSQL and object storage;
6. verify checksums, migrations/schema, request/result counts and attachment links;
7. run smoke tests: login, scoped request view, result/version/timeline, notification queue;
8. compare approved RPO/RTO and record gaps;
9. approve cutover/rollback; preserve incident/audit evidence.

### 4.1 Restore a Compose dump (rehearsed 06/10/2026)

Rehearsed on an isolated copy of the production Compose stack: the database
was dropped, the latest scheduled dump restored, and `readyz`, login, row
counts, table ownership and the append-only guard on `audit_events` were
verified afterwards. The dump is written with `--no-owner --no-privileges`, so
it is restored as the administrative role and the `migrate` service then
hands every object back to the migration role and re-grants the runtime role.
This restores the database only; attachments in object storage need their own
restore (§3).

```bash
DC="docker compose -f docker-compose.prod.yml --env-file .env.production"
$DC stop proxy app worker backup
# Destructive: only after the incident owner approved the recovery point.
$DC exec postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE \"$POSTGRES_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$POSTGRES_DB\""'
$DC run --rm --no-deps -T --entrypoint sh -e PGUSER="$POSTGRES_USER" -e PGPASSWORD="$POSTGRES_PASSWORD" backup -c \
  'pg_restore --no-owner --no-privileges --exit-on-error -d "$PGDATABASE" /backups/<file>.dump'
$DC run --rm migrate      # ownership, runtime grants, migration checksums
$DC up -d
curl -fsS "https://$APP_DOMAIN/api/v1/readyz"
```

`POSTGRES_USER`/`POSTGRES_PASSWORD` are the administrative credentials from
`.env.production` (export them in the shell first). Every migration must report
"já aplicada"; a checksum error means the dump comes from a different release
and the matching image tag must be used.

## 5. Drill cadence and evidence

At least monthly backup verification and periodic full restore drill during pilot (final cadence to TI). Evidence includes backup ID/time, restore target, duration, checksum/sample reconciliation, test results and owner sign-off. Never run a destructive restore over production.

## 6. Failure handling

Missing/failed backup is a release/operations alert, not a warning to ignore. Storage unavailable blocks attachment release where required; DB unavailable makes readiness false. Ransomware scenario uses immutable/offline copy and credential rotation.
