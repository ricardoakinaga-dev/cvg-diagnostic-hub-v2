# Auditoria da entrega de dependências — 07/10/2026

> **Registro histórico:** as versões, contagens, proteções, resultados de CI e o achado `DEP-AUD-01` abaixo são observações da revisão de 07/10/2026 sobre `343c140` e `b12cb81`. A incorporação deste relatório em 10/10/2026 preserva essa evidência; não constitui uma nova auditoria da main nem confirma que o achado continue presente.

**Parecer:** merges, CI remoto e configuração do Dependabot confirmados, com uma ressalva local aberta (`DEP-AUD-01`). As atualizações incorporadas não apresentaram regressão de produção identificada nesta revisão. As majors adiadas continuam exigindo migração e validação próprias.

## Escopo e evidência

Revisão independente dos PRs [#15](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/15) e [#23](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/23), incorporados à `main` por `343c140` e `b12cb813a5557d4fa8683b3e1817c15d50bc5907`. O diff desde `159fe84` altera somente `package.json`, `package-lock.json`, `.github/dependabot.yml` e `.github/workflows/ci.yml`; não altera a aplicação nem remove testes ou gates.

Foram inspecionados o diff, o lockfile, as regras do bot, as proteções da `main`, os checks dos PRs e os logs dos jobs. A execução local usa Node **22.23.2**, conforme o runtime declarado pelo projeto. As atualizações incompatíveis não foram instaladas novamente nesta auditoria; as falhas atribuídas a elas têm os limites de evidência descritos abaixo.

## CI remoto confirmado

| Revisão da main | Execução do workflow CVG Diagnostics Hub CI | Resultado |
| --- | --- | --- |
| `343c140` | [37560069634](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/37560069634) | Sucesso |
| `b12cb81` | [37564180070](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/37564180070) | Sucesso |

Os logs do job `verify` de ambos confirmam **1.592 testes unitários**, **98 PostgreSQL** e **1.690 testes na cobertura agregada**. A segunda execução confirma **90 testes de navegador**, **12 de acessibilidade** e **48 de navegador com PostgreSQL**, sem falhas ou retries reportados nos resumos. Typecheck, lint, configuração, gate de cobertura, mutação, performance, build, CodeQL e benchmark HTTP/PostgreSQL/SSE terminaram com sucesso.

`Dependency review` é intencionalmente **skipped nos pushes à main**. Foi aprovado nos PRs: [#15, job 112588404614](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/37557943445/job/112588404614) e [#23, job 112601885154](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/actions/runs/37562135992/job/112601885154). A conclusão geral de sucesso não significa que esse job tenha executado no push.

Os três scans Trivy (aplicação, imagem operacional e MinIO) passaram. O critério permanece `HIGH,CRITICAL`, `exit-code: 1` e **`ignore-unfixed: true`**: o gate não garante ausência de vulnerabilidades sem correção publicada. A consulta aos alertas abertos do Dependabot retornou **0** e a lista de PRs abertos retornou **0** antes da publicação desta auditoria; são observações pontuais, não garantias futuras.

## Compatibilidade e bloqueios

React e React DOM estão ambos em **19.3.0**, acompanhados dos tipos 19.3; Vitest e seu provider de cobertura continuam ambos em **4.1.11**. As versões instaladas das dependências diretas correspondem ao lockfile após `npm ci`. Não foi necessária alteração de código para compilar os usos atuais de Zod 4.6.5. A revisão dos schemas e do tratamento de erros confirmou uso de `safeParse`, objetos estritos e `z.record` com chave e valor; a aplicação não depende da representação textual interna de `ZodError` nesses comandos.

| Atualização adiada | Evidência inspecionada nesta auditoria | Limite |
| --- | --- | --- |
| `@types/node` 26 | Runtime Node 22 no manifesto, CI e imagens; regra `versions: [">=23"]` | Tipos mais novos não representam o runtime atual |
| TypeScript 7 | `typescript-estree` instalado declara faixa suportada `>=4.8.4 <6.1.0` | Fora da faixa; candidato 7 não reinstalado |
| Vitest / coverage 5 | Quatro arquivos atuais usam `describe.sequential`; manifesto mantém provider e runner na mesma versão | As 111 perdas relatadas na migração não foram recontadas com Vitest 5 |
| jsdom 30 | Regra de ignore e justificativa registrada no PR #12 | As quatro falhas relatadas não foram reproduzidas nesta rodada |
| ESLint 10 | Regra de ignore; suíte de configuração corrente reexecutada | O erro de scopeManager e as 45 falhas do candidato não foram reproduzidos nesta rodada |
| plugin-react 6.1.1 | Metadados publicados exigem Vite `^8.0.0`; stack atual usa Vite 7 | A troca requer avaliar a stack de testes em conjunto |
| eslint-config-next 16.3.8 | `scripts/eslint-glob.test.mjs` exige explicitamente oracle 16.3.0 e verifica hashes/paridade | Atualizar exige recaptura justificada do oracle, preservando o gate |

São adiamentos de migração, não pendências eliminadas por compatibilidade comprovada. As regras de ignore para majors também impedem majors futuras desses pacotes; devem ser revistas quando a migração correspondente for feita. Playwright e eslint-config-next são ignorados em **todas as atualizações**, inclusive patches, e precisam continuar sob manutenção manual.

## Dependabot

O YAML foi validado novamente contra o [schema do SchemaStore](https://json.schemastore.org/dependabot-2.0.json), com Ajv. SchemaStore é um catálogo de schemas; a validação não deve ser descrita como homologação oficial de execução do bot. Também foram conferidas as opções na [documentação do GitHub](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

Os grupos específicos de Vitest e React aparecem antes do grupo geral, coerentemente com a regra do primeiro grupo correspondente. Os demais minor/patch são agrupados semanalmente e as Actions têm seu próprio grupo semanal. A frequência semanal pode gerar mais de um PR: cada grupo é independente e o limite configurado é 10. Grupos coordenam propostas, mas não substituem conferir peer dependencies e executar os checks.

A confirmação explícita para ignorar **Vitest 5.x.x** está no [PR #25](https://github.com/ricardoakinaga-dev/cvg-diagnostic-hub-v2/pull/25), após `@dependabot ignore this major version`; não depende da mensagem genérica de fechamento do PR #9. As regras YAML também cobrem `vitest` e `@vitest/*`. Esses grupos se aplicam às atualizações de versão por padrão; esta configuração não promete agrupar atualizações de segurança.

## Ambiente e revalidação local

O diretório `node_modules` inicialmente estava desatualizado: entre outras diferenças, continha React 19.2 e Zod 3 apesar do manifesto novo. `npm ci` sob Node 22 sincronizou as dependências, sem alterar arquivos versionados, e retornou **0 vulnerabilidades**. Testes executados antes dessa sincronização não seriam evidência das versões entregues.

Typecheck e lint passaram. Os testes de configuração passaram com **160 + 4 testes**. A OpenAPI passou com **73 operações em 68 paths**, mantendo um warning da regra `no-illogical-composition-keywords`. A suíte PostgreSQL passou **98/98 em 17 arquivos** contra um container PostgreSQL **16.15** descartável, publicado somente em loopback e removido ao término.

**DEP-AUD-01 — instabilidade local no teste de atalho (aberto).** A primeira execução completa de `npm test` terminou com **1.591/1.592**, em 219,13 s. Falhou somente `WorkItemsView > shows only the clinician's own requests in Meu trabalho and lets them create`: após a tecla `c`, não encontrou o diálogo “Solicitar exames” dentro do prazo. O mesmo arquivo passou **39/39 em quatro execuções isoladas**, sem alterações ou retries automáticos. A causa não foi isolada e não há evidência suficiente para atribuir a falha à atualização de React. A repetição isolada não apaga a falha completa observada; esse caminho precisa de investigação se voltar a ocorrer. Não foram ampliados timeouts, reduzidas asserções ou alterados gates para obter aprovação.

A segunda execução completa, com o mesmo código e dependências, passou **1.592/1.592 em 134 arquivos**, em **213,23 s**. Esse resultado confirma que a falha inicial não foi contínua, mas mantém a ressalva de instabilidade. Cobertura, browser, build de produção e scans de imagem foram conferidos no CI remoto; não foram todos repetidos localmente nesta auditoria. A alteração publicada contém somente este relatório e seu ponteiro no índice, verificados por `validate:docs` e `git diff --check`.

## Publicação e higiene

A `main` continua protegida: exige PR, branch atualizada e os sete checks configurados, inclusive revisão de dependências; a proteção também se aplica a administradores. A publicação desta auditoria deve ocorrer em branch própria, sem contornar esses controles.

As duas worktrees temporárias de dependências foram inspecionadas e estavam limpas; seus commits estão incorporados à `main`. A limpeza dessas worktrees e das branches correspondentes permanece separada desta revisão. As migrações adiadas e os gates institucionais/clinicamente necessários continuam fora do aceite desta entrega de dependências.
