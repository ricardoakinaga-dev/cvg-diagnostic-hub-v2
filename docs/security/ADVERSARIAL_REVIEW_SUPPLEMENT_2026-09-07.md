# Suplemento de revisão adversarial — 07/09/2026

**Status:** `REVIEW_REQUIRED / BLOCKED`; este suplemento atualiza a evidência local após a rodada independente anterior e não substitui a revisão independente, a aprovação clínica ou a decisão de release.

## Escopo da rodada

Após o packet independente [`independent-critic-report-round2.md`](../../.orchestrate/aaa3-execution-20260907/independent-critic-report-round2.md) e a rechecagem read-only da rodada 3 ([`independent-critic-report-round3.md`](../../.orchestrate/aaa3-execution-20260907/independent-critic-report-round3.md)), foram incorporados e revalidados quatro controles locais:

1. logger HTTP estruturado com allowlist explícita, redaction de campos sensíveis, labels limitadas e writer fail-safe;
2. geração de SBOM CycloneDX no CI, com artefato publicado no job de verificação;
3. relatório de cobertura por camada, com thresholds globais e lista de arquivos abaixo do limiar;
4. runbooks de incidente, outbox, storage/scanner, realtime, segurança e fechamento em [`INCIDENT_RUNBOOKS.md`](../operations/INCIDENT_RUNBOOKS.md), ainda sem exercício em ambiente-alvo;
5. correlação de request caller-controlled não é persistida no logger: somente IDs `corr_<UUID>` gerados pelo servidor são preservados, e os demais viram `external`;
6. o sentinel [`MUTATION_CONTROLS.md`](MUTATION_CONTROLS.md) detecta 7/7 mutações deliberadas em auth, version, migration, upload, outbox, realtime e recovery.

## Evidência reproduzida

| Controle | Resultado local | Limite residual |
| --- | --- | --- |
| `source /home/ricardo/.nvm/nvm.sh && nvm exec 22 npm run validate` | **725/725 testes em 86 arquivos**; typecheck, lint, docs, OpenAPI 65/60, traceabilidade 43/43 e migrations 001–010 | não é CI remoto nem prova de ambiente hospitalar |
| Cobertura V8 + `npm run coverage:report` | **92,72% lines, 94,31% functions, 85,82% branches** na execução full corrente; thresholds globais 90/90/85; 35 arquivos abaixo de pelo menos um limiar por arquivo | o relatório não transforma cobertura agregada em prova de cenários clínicos ou de produção |
| `nvm exec 22 npm run build` | build Next.js 16.3.0/Turbopack concluído com 15 rotas da aplicação (11 estáticas e 4 dinâmicas) | não prova deploy, rollback ou tráfego real |
| `nvm exec 22 npm run security:scan` + `npm audit --audit-level=high` | secret scan PASS; 0 vulnerabilidades de dependências | não substitui pentest, revisão de egress, secrets manager ou provenance assinada |
| `nvm exec 22 npm --silent run security:sbom` | SBOM CycloneDX 1.5 com 560 componentes; job CI valida JSON e publica artefato | revisão de dependências, assinatura/proveniência e aprovação de supply chain continuam abertas |
| testes de logger e rota HTTP | campos sensíveis não são serializados; status/duração/labels são normalizados; correlação externa vira `external`; writer falho não altera a resposta | thresholds, roteamento, retenção e acesso a logs dependem de D-05 |
| [`KNOWN_BAD_CONTROL_MATRIX.md`](KNOWN_BAD_CONTROL_MATRIX.md) | oito fronteiras negativas catalogadas com testes executáveis locais | mutation control independente, target identity e efeito distribuído ainda não foram aceitos |
| [`MUTATION_CONTROLS.md`](MUTATION_CONTROLS.md) | 7/7 mutações catalogadas detectadas em cópia temporária sob Node 22 | não é mutation score global, revisão independente ou prova no ambiente-alvo |

## Achados locais fechados nesta suplementação

- O caminho HTTP não registra corpo, payload clínico, token, cookie, autorização, credential, connection string ou conteúdo arbitrário.
- A pipeline passou a produzir um SBOM consumível, mas o artefato permanece evidência de inventário, não de aprovação de risco.
- A cobertura agora explicita camadas e arquivos abaixo do limiar, evitando esconder a concentração de lacunas em persistência, UI e realtime.
- O operador possui um primeiro conjunto de runbooks reproduzíveis e uma regra explícita para não confundir teste local com RPO/RTO ou restore completo.

## Veredito adversarial

O candidato permanece **forte localmente e bloqueado globalmente**. A suplementação não fecha:

- D-01 a D-06 e a autoridade clínica/hospitalar;
- PostgreSQL relacional como autoridade, cutover, volume/skew, rollback e reconciliação no ambiente-alvo;
- storage/AV/secrets/DNS/egress reais, carga representativa, failover, dois workers sob crash e restore completo dentro de RPO/RTO;
- revisão manual de acessibilidade, touch, leitor de tela e jornadas clínicas;
- CI remoto, pentest, revisão independente final, piloto e autoridade formal de release.

O manifesto AAA-3 continua sendo a fonte corrente de status e mantém `local_automated_status=PASS_WITH_CONDITIONS`, `aaa3_verdict=BLOCKED_REVIEW_REQUIRED` e `release_claim=false`.
