# Correções de amostra, navegação e ensaio PostgreSQL

**Data:** 12/10/2026 · **Captura:** provas focadas concluídas; nova CI completa pendente do commit · **042:** PARTIAL · **051:** OPEN · **Release:** não aplicada.

O [registro](HOSPITAL_PLANNER_BROWSER_POSTGRES_FOLLOWUP_2026-10-12.json) e o [manifesto](HOSPITAL_PLANNER_BROWSER_POSTGRES_SOURCE_MANIFEST_2026-10-12.json) identificam **1090 arquivos**, fonte `782359aea3ca7f051b1f1bfd0532905ad76e332632e787712886718d36c2073e`. Contra `e224a23`, seis inputs mudaram e dois helpers de teste foram adicionados; **1082 inputs anteriores continuam byte a byte iguais**. A responsabilidade pelo piloto continua no [registro do solicitante](../operations/HOSPITAL_PLANNER_PILOT_OWNER_2026-10-12.json).

## Falha preservada e correções

A [quarta CI](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/38194246475) terminou **FAIL**: verify passou 5.305 testes, sentinel 7/7, build e privacidade; os três projetos completos de navegador passaram 65/65 cada, e imagem/benchmark/revisão de dependências passaram. O navegador com PostgreSQL terminou **39 PASS / 9 FAIL de 48**, sem retry ou skip. O Home foi reexecutado separadamente em três projetos e não é somado como cenário novo. As primeiras duas falhas e o cancelamento automático da terceira execução permanecem históricos no JSON e nos registros anteriores.

Uma leitura atrasada da etiqueta podia apagar EDTA mesmo após o usuário editar o campo, porque o valor coincidia com o default. O marcador explícito de edição protege o texto; RED e regressões focadas constam no registro. A navegação inferior também podia encobrir a última ação da lista: o espaço reservado passou ao pai do painel, reduzindo a área real de rolagem. A reprodução isolada com CSS real passou nos três tamanhos; a nova CI ainda precisa exercer o aplicativo completo.

Os três 422 de liberação no PostgreSQL vinham de uma guarda clínica correta: o catálogo padrão de demonstração não tem referências aprovadas. A lane descartável agora prepara uma política **artificial e explicitamente sintética** por comandos nativos ADMIN/VET, antes de pedidos ou snapshots. Opt-ins, CI, banco único em loopback e seed não produtivo são validados antes de conectar/resetar. O catálogo padrão continua pendente; a guarda de produção permanece. As faixas artificiais são dados de ensaio, sem validade clínica hospitalar.

O check nativo CodeQL falhou inicialmente por dois alertas HIGH, apesar de o job de análise concluir. A leitura dos paths SARIF e a revisão independente mostraram tokens aleatórios e IDs de catálogo classificados como senha pela heurística de retorno de chamadas. [Alerta 23](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/security/code-scanning/23) e [alerta 24](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/security/code-scanning/24) foram tratados individualmente como falsos positivos, com justificativa; o check nativo recomputou SUCCESS. Senhas continuam scrypt, tokens produtivos HMAC, query e gates intactos. Isso não certifica ausência de toda vulnerabilidade.

Também foram preservados 23 GETs proxy_untrusted 503 durante navegação, 19 em casos PASS. A rejeição ocorre antes do banco; o mecanismo de perda do header permanece UNKNOWN por falta de trace/headers no artefato, sem causa estabelecida para as nove falhas. A guarda permaneceu e esse fluxo deve ser conferido com o proxy aprovado no UAT.

## Fonte, validação e aceite

A checagem de privacidade encontrou credenciais fictícias em uma URL negativa de teste TEST-NET. O fixture passou a usar esse host sem credenciais, mantendo a recusa; os 24 testes do helper passaram novamente. O scanner permaneceu intacto e a falha original está preservada.

As provas focadas, revisões, hashes e limites estão no JSON; os resultados globais anteriores conservam a candidata original. Esta captura antecede o commit; conferir SHA publicado e nova CI completa no [PR #78](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/78). Não houve implantação ou alteração de dados hospitalares.

O [pacote de piloto](../operations/HOSPITAL_PLANNER_PILOT.md), o [roadmap](ROADMAP_HOSPITAL_PLANNER_2026-10-11.md) e o [backlog](BACKLOG_HOSPITAL_PLANNER_2026-10-11.md) mantêm integração 042 parcial e piloto 051 aberto. O solicitante executará os ensaios; resultados, aceite assinado e go/no-go ainda não foram registrados. HIS cvg-his-v4 informado, LIS/PACS desconhecidos.
