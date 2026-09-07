# Evidence packet — full browser regression under Node 22

**Data:** 2026-09-07  
**Escopo:** fluxo principal, ciclo clínico, acessibilidade e realtime em
Chromium, tablet e mobile.  
**Ambiente:** Node 22.23.2; servidores E2E isolados; dados sintéticos; sem uso
do PostgreSQL persistente `127.0.0.1:5432`.  
**Veredito local:** `PASS_WITH_CONDITIONS`.  
**Veredito de release:** este packet não é homologação clínica, aceite
hospitalar ou autorização de produção.

## Comando

```text
source /home/ricardo/.nvm/nvm.sh && \
E2E_PORT_BASE=6400 nvm exec 22 npm run test:e2e -- \
  --retries=0 --fail-on-flaky-tests
```

## Resultado terminal

- **57/57 testes PASS**;
- Chromium, tablet e mobile incluídos;
- retries desabilitados e `--fail-on-flaky-tests` ativo;
- nenhuma repetição ou flake aceito como sucesso;
- a fatia realtime (`tests/e2e/realtime.spec.ts`) passou junto da matriz.

O denominador é a soma da matriz de fluxo principal, ciclo clínico,
acessibilidade e realtime. O packet não prova carga representativa, proxy/TLS,
IdP, storage/AV real, restart/failover, RPO/RTO ou aceite manual de
acessibilidade.

