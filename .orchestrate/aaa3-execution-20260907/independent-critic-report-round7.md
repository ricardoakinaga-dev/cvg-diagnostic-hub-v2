# Parecer de qualidade — rodada 7, delta de acessibilidade transacional

**Status:** `BLOCKED` para `AAA-READY` e release.

**Independência:** `PEER`, não `INDEPENDENT`. O mesmo revisor que produziu a rodada 6 foi retomado para uma revisão somente-leitura do delta; portanto, este parecer não autentica aprovação independente AAA. O revisor não editou arquivos nem executou a suíte ampla.

## Escopo e evidência

O delta revisado foi limitado a `src/components/result-view.tsx` e
`src/components/result-view.test.tsx`. A implementação agora deriva o bloqueio
global de `pendingAction`, mas expõe `pending`/`aria-busy` somente na ação ativa
(`release`, `review`, `upload` ou `editor`). Os testes adicionais cobrem revisão
e upload pendentes; a validação local observada pelo host fechou em **719 testes
(719/719)**, 92,69% linhas, 86,02% branches e 94,40% funções. Esses números são
evidência do host, não uma reexecução pelo revisor.

## Resultado

Não foram encontrados achados concretos remanescentes nos dois arquivos
revisados. A correção do achado da rodada anterior foi observada como fechada:

| ID | Local | Esperado | Observado | Severidade | Evidência | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| PEER-07-001 | `src/components/result-view.tsx` — ações assíncronas | Somente a transação ativa deve anunciar `aria-busy` e bloquear duplicação | `pendingAction` isola o estado por ação; testes de release, editor, review e upload verificam pending/idle | High | fonte atual e `src/components/result-view.test.tsx` (19 testes do componente) | `FIXED` |

## Gates ainda bloqueados

O veredito permanece `BLOCKED` porque esta revisão de delta não fecha os gates
de autoridade clínica, infraestrutura ou aceite humano: D-01 identidade e
ownership/admissão/alta; D-02 autoridade de estado, emenda e void; D-03
política de resultado crítico; D-04 SLA/calendário/escalonamento; D-05
PostgreSQL source-current, cutover/rollback, volume/skew, carga, failover,
backup/restore completo, storage/AV/secrets/egress, CI remoto e on-call; e
D-06 treinamento, piloto, suporte e autoridade formal de release. Também não
há certificação manual de leitor de tela, touch, zoom, UX clínica ou golden
visual. JSONB continua a autoridade clínica; a projeção relacional é shadow-only.

## Scores e confiança

- Qualidade do delta de código observado: **alta confiança local**, sem score AAA
  agregado; a revisão não reexecutou a suíte e não recebeu render interativo.
- Qualidade visual, clínica, hospitalar e produtiva: **não pontuada nesta rodada**;
  a evidência necessária é ausente ou não observada.
- A média técnica anterior não cancela os gates bloqueados.

## Stop reason e próxima ação segura

O delta local foi corrigido e não há outro defeito concreto nos arquivos
revisados que possa ser fechado sem ampliar o escopo. O próximo passo seguro é
executar revisão `INDEPENDENT` host-observada sobre um render/interação atual e
fechar D-01–D-06 com os responsáveis humanos e o ambiente alvo; até lá,
manter `release_claim: false`.

## Revalidação local posterior — 07/09/2026

Após esta revisão peer, o candidato recebeu um hardening adicional de busca e
interação: o dashboard passou a implementar Meta/Ctrl+K, combobox/listbox ARIA,
navegação por teclado, Escape e descarte de respostas fora de ordem. A
reexecução do host passou **721 testes (721/721)**, com 92,70% linhas, 86,05%
branches e 94,31% funções; a matriz browser corrente passou 57/57 sem retry e
os 20 PNGs visuais foram recapturados com hashes atuais. Esta seção é uma
reconciliação factual do candidato, não uma nova execução pelo revisor e não
converte o parecer `PEER` em aprovação independente.

## Revalidação local posterior 2 — 07/09/2026

Após o hardening de busca, o candidato recebeu isolamento de estado pendente
entre submit/release no workflow e descarte de respostas fora de ordem nos
filtros de notificações. A execução full posterior passou **723 testes
(723/723)** em 86 arquivos, com 92,71% linhas, 86,06% branches e 94,31%
funções; a matriz browser corrente passou 57/57 sem retry e os 20 PNGs visuais
foram recapturados com hashes atuais. Esta seção é evidência host-observada
posterior, não nova execução pelo revisor; o parecer continua `PEER` e
`BLOCKED` para `AAA-READY`.
