# Roadmap Pós-Auditoria — CVG Diagnostics Hub

**Versão:** AUDIT-2026-10
**Data:** 01/10/2026
**Estado:** execução local parcial; gates técnicos aceitos no backlog, gates externos permanecem abertos

[Plano executivo](AUDIT_2026_10_EXECUTIVE_PLAN.md) · [Backlog](AUDIT_2026_10_BACKLOG.md) · [Relatório](../RELATORIO_AUDITORIA_2026-10-01.md)

## 1. Regra do roadmap

O roadmap é orientado a risco e a honestidade de gate, não a volume de funcionalidade. A sequência é:

G0 → G1 → G2 → G3 → G4 → G5

Preparação de documentação e itens sem dependência pode começar antes do gate anterior. Um gate só passa quando todos os seus critérios obrigatórios passam com evidência nova; trabalho iniciado não significa marco aceito, e packet histórico não fecha item.

Execução corrente: G0, G1, G2, G3 e a parte técnica de G4 têm evidência local
automatizada e estão refletidos como `DONE` no backlog. A rotina de limpeza pós-E2E
foi exercitada localmente e está conectada ao CI; inspeção manual, autoridade
operacional, ambiente-alvo e G5 independente continuam `BLOCKED`. O estado do produto permanece `CONDITIONAL PASS
LOCAL / BLOCKED` para produção clínica.

## 2. Visão por horizonte

| Horizonte | Gate | Janela | Resultado |
| --- | --- | ---: | --- |
| Fundição | G0 — gates honestos e higiene | semanas 1–2 | scan de segredos e validador de documentação falham corretamente; working tree e `tsconfig` limpos |
| Segurança | G1 — exposição eliminada | semanas 2–4 | zero critical/high na auditoria de dependências, rate limit por cliente, HSTS, timing uniforme e docs coerentes |
| Medição | G2 — o que importa é medido | semanas 3–6 | persistência coberta, gate por arquivo ativo, 500 correlacionado, migration no `/readyz` |
| Produto | G3 — interface consistente | semanas 5–8 | design system reconciliado, alvos e semântica uniformes, axe ampliado e inspeção manual registrada |
| Operação | G4 — caminho de operação | semanas 6–10 | imagem, deploy mínimo, supply chain automatizada, RPO/RTO decidido |
| Re-auditoria | G5 — prova independente | semanas 9–11 | relatório fresco com nota ≥ 85 e zero achado crítico/alto |

A faixa é hipótese de capacidade, não compromisso de data. Dependências externas (autoridade de RPO/RTO, secret manager, host com cluster PostgreSQL descartável e revisor independente) podem aumentar a duração.

## 3. Gates e critérios de saída

### G0 — Gates honestos e higiene

**Objetivo:** o sistema de garantia do repositório passa a falhar de forma verdadeira.

Entregas:

- `security:scan` com preflight da ferramenta de busca e falha explícita quando ausente, com fallback declarado;
- `validate:docs` com o mesmo preflight e com as três classes de checagem que hoje são puladas restauradas;
- `required_files` atualizada com os relatórios correntes e `docs/v2/LABORATORY_VERTICAL.md`;
- rotina de limpeza dos diretórios de build descartáveis e política para não reacumular;
- `tsconfig.json` sem globs de build descartável versionados;
- política explícita para os artefatos de processo (`.orchestrate`, `.gauntlet*`, `.agent`).

Saída:

- injeção proposital de falha nos dois scripts produz EXIT=1 com mensagem clara;
- árvore sem diretórios de build antigos e `tsconfig.json` estável entre execuções;
- G-2 do plano executivo atendido.

### G1 — Exposição eliminada

**Objetivo:** nenhuma vulnerabilidade crítica ou alta conhecida e nenhum vetor documentado inexistente no código.

Entregas:

- `next` atualizado para faixa sem advisories e `sharp` atualizado, com matriz browser completa verde antes e depois;
- chave de rate limit derivada do cliente real, com falha explícita quando o proxy não é confiável;
- `Strict-Transport-Security` e headers de origem complementares;
- comparação de senha em tempo constante mesmo para usuário inexistente ou inativo;
- fluxo de troca/redefinição de senha com backoff, ou remoção dessas promessas dos documentos;
- `docker-compose.yml` sem credenciais fixas e com portas restritas a loopback;
- `SECURITY.md`, `THREAT_MODEL.md` e o suplemento adversarial alinhados à implementação e à auditoria de dependências real.

Saída:

- `npm audit --audit-level=high` exit 0 em CI e local;
- nenhum item do relatório com severidade crítica ou alta em aberto;
- G-1 do plano executivo atendido.

### G2 — O que importa é medido

**Objetivo:** a persistência clínica e a falha de execução deixam de ser pontos cegos.

Entregas:

- suíte de integração PostgreSQL executada dentro do denominador de cobertura;
- `postgres-store.ts` e o adaptador relacional acima de 80% de lines, com justificativa registrada para qualquer exclusão;
- gate por arquivo de cobertura ativo no CI, com exceções declaradas e versionadas;
- envio de `logger.error` correlacionado para toda falha inesperada, sem vazar stack ao cliente;
- `/readyz` verificando compatibilidade de migration, conforme a observabilidade declara;
- alertas com thresholds, donos e roteamento publicados (mesmo que com destino local na ausência de ferramenta externa).

Saída:

- G-3, G-4 e G-5 do plano executivo atendidos;
- teste que injeta 500 e afirma correlação logada aprovado;
- nenhum arquivo de produto abaixo do limiar sem exceção justificada.

### G3 — Interface consistente

**Objetivo:** o que a documentação de design descreve existe, e a acessibilidade é uniforme em todas as telas.

Entregas:

- reconciliação de `DESIGN_SYSTEM.md` com os tokens e componentes reais (incluindo raios e inventário de componentes);
- kit de estados de feedback adotado por todos os consumidores, com semântica `aria-live` uniforme;
- focus trap único com restauração de foco, removida a reimplementação do drawer;
- alvos de interação ≥ 44 px na navegação e nas ações, fechando F-15;
- varredura axe ampliada em regras e fora do recorte `main`;
- inspeção manual com leitor de tela, zoom e touch executada e anexada;
- DTOs do frontend apontando para `@cvg/contracts` no lugar das declarações locais duplicadas.

Saída:

- G-6 do plano executivo atendido;
- matriz browser completa verde sem retry;
- evidência visual nova nos três viewports para o estado reconciliado.

### G4 — Caminho de operação

**Objetivo:** existe um caminho, ainda que mínimo e controlado, para construir, publicar e recuperar o serviço.

Entregas:

- Dockerfile da aplicação com build multi-stage e imagem auditada;
- pipeline com revisão automática de dependências (Dependabot ou equivalente) e análise estática;
- job de publicação em ambiente controlado, com rollback documentado;
- RPO/RTO aprovado ou substituído por decisão formal, com WAL archiving e exercício de restore completo;
- separação de ambientes e secret management decididos e implementados na forma disponível;
- cache de navegador do Playwright e remoção da execução duplicada de acessibilidade no CI.

Saída:

- G-7 do plano executivo atendido;
- imagem construída por pipeline e restauração exercitada com checksum;
- decisão de RPO/RTO registrada com autoridade e data.

### G5 — Prova independente

**Objetivo:** uma avaliação fresca, sem reaproveitar a evidência desta auditoria.

Entregas:

- re-execução integral dos gates (typecheck, lint, cobertura, browser, integração PostgreSQL, segurança, auditoria de dependências, documentação, rastreabilidade);
- revisor independente com contexto novo e veredito registrado em packet com hash;
- reconciliação final de números entre relatório, plano, roadmap, backlog e documentos de teste.

Saída:

- relatório independente com nota ≥ 85 e zero achado crítico ou alto aberto;
- G-8 do plano executivo atendido;
- estado do candidato reavaliado — que permanece `BLOCKED` para produção clínica de qualquer forma, conforme os gates humanos do AAA-3.

## 4. Dependências externas

| Dependência | Gate afetado | Se não chegar |
| --- | --- | --- |
| Host com `initdb`/`pg_ctl` ou Docker para cluster descartável | G2, G5 | itens de cobertura de integração ficam `BLOCKED` com registro do motivo |
| Autoridade de RPO/RTO e secret manager | G4 | gate G4 permanece aberto; onda não fecha |
| Revisor independente com contexto novo | G5 | re-auditoria adiada, sem reaproveitar parecer antigo |
| Ferramenta de alertas/observabilidade externa | G2 | thresholds e roteamento publicados com destino local, marcados como pendentes de integração |

## 5. Relação com o programa AAA-3

Este roadmap não substitui nem antecipa o [roadmap AAA-3](STATE_OF_ART_TRIPLE_AAA_ROADMAP.md). Fases AAA-3 com gate clínico ou de piloto permanecem pausadas nos seus próprios critérios; os itens desta onda são pré-condições técnicas verificáveis que a re-auditoria de G5 deve constatar antes de qualquer reapresentação do candidato.
