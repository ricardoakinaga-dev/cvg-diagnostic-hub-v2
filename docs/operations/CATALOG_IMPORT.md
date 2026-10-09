# Importação do catálogo por planilha

Procedimento da decisão D10 ([D-035](../DECISION_LOG.md), item PROD-407): o catálogo de exames de produção nasce de duas planilhas-modelo preenchidas pelos setores e importadas com validação. A mesma planilha vale em homologação e em produção, e pode ser reimportada quantas vezes for preciso.

Os modelos ficam em `public/templates/` e são baixados pela própria tela de importação:

- [`catalogo-exames.csv`](../../public/templates/catalogo-exames.csv): uma linha por exame;
- [`catalogo-analitos.csv`](../../public/templates/catalogo-analitos.csv): uma linha por analito dos exames com `esquema_resultado = NUMERIC_PANEL` (painéis como o hemograma). Exames narrativos e de imagem não usam esta planilha.

## 1. Como cada setor preenche

1. Abra o modelo no Excel (ou LibreOffice) e **salve sempre como CSV UTF-8** (no Excel em português: "CSV UTF-8 (delimitado por vírgulas)" ou o CSV com ponto e vírgula; os dois separadores são aceitos).
2. **Apague as linhas de exemplo.** Elas têm o código iniciado por `EXEMPLO_` e a importação as recusa de propósito, para que nunca entrem no catálogo por engano.
3. Não renomeie, apague nem reordene colunas além do que o modelo permite: o cabeçalho é conferido e a importação cita a coluna com problema.
4. Preencha só as linhas do seu setor. Um exame que não está na planilha **não é alterado nem desativado**; para desativar, escreva o exame com `ativo = não`.
5. Se um texto tiver ponto e vírgula (por exemplo em `observacao`), coloque-o entre aspas.
6. Linhas totalmente vazias são ignoradas; espaços antes e depois dos valores são removidos.

Valores de sim/não aceitam `sim`, `não` (ou `nao`), `s`, `n`, `true`, `false`, `1` e `0`, em maiúsculas ou minúsculas.

### 1.1 Planilha de exames (`catalogo-exames.csv`)

| Coluna | Obrigatória | Valores permitidos e regra |
| --- | --- | --- |
| `codigo` | sim | Código único e estável do exame: 2 a 60 caracteres, letras, números e `_`, começando por letra (ex.: `HEMOGRAMA`). Vira maiúsculo. É a chave da importação: mudar o código cria outro exame. |
| `nome` | sim | Nome exibido às equipes, até 120 caracteres. |
| `categoria` | sim | `LABORATORY` ou `IMAGING` (aceita também `laboratório` e `imagem`). |
| `setor` | sim | Código do setor responsável (ex.: `LABORATORY`, `RADIOLOGY`, `ULTRASOUND`). |
| `fluxo` | sim | `LABORATORY`, `RADIOLOGY` ou `ULTRASOUND`. `LABORATORY` combina só com a categoria `LABORATORY`; `RADIOLOGY` e `ULTRASOUND` combinam só com `IMAGING`. |
| `exige_amostra` | sim | sim/não. Exames de laboratório normalmente exigem. |
| `tipo_amostra` | não | Material ou tubo a usar (ex.: `Sangue total (EDTA)`), até 60 caracteres; aparece na etiqueta. Só pode ser preenchido quando `exige_amostra = sim`. |
| `exige_agenda` | sim | sim/não. Ultrassom costuma exigir agenda. |
| `permite_anexo` | sim | sim/não. Imagem costuma permitir anexo (PDF, JPEG, PNG). |
| `esquema_resultado` | sim | `NUMERIC_PANEL` (painel de analitos, só laboratório) ou `NARRATIVE` (laudo em texto). |
| `sla_rotina_h`, `sla_urgente_h`, `sla_emergencia_h` | sim | Prazo em horas, número inteiro de 1 a 720, para cada prioridade. |
| `ativo` | não | sim/não; vazio vale sim. `não` desativa o exame (ele deixa de ser oferecido, o histórico permanece). |

### 1.2 Planilha de analitos (`catalogo-analitos.csv`)

| Coluna | Obrigatória | Valores permitidos e regra |
| --- | --- | --- |
| `codigo_exame` | sim | Código de um exame que **consta na planilha de exames** e tem `esquema_resultado = NUMERIC_PANEL`. Analito de exame ausente da planilha de exames é erro. |
| `codigo_analito` | sim | Código do analito dentro do exame (ex.: `HEMOGLOBINA`); único por exame. |
| `nome` | sim | Nome exibido no editor de resultado, até 120 caracteres. |
| `tipo_valor` | sim | `NUMERIC`, `QUALITATIVE` ou `TEXT` (aceita também `numérico`, `qualitativo`, `texto`). |
| `unidade` | numérico: sim | Unidade (ex.: `g/dL`, `10^9/L`). Vazia para texto e qualitativo. A unidade é conferida no lançamento do resultado. |
| `obrigatorio` | sim | sim/não: se o analito precisa ser informado para liberar o resultado. |
| `ordem` | não | Posição na tela (1 a 1000); vazia segue a ordem das linhas. |
| `referencia_minima`, `referencia_maxima` | não | Limites da faixa de referência, só para `NUMERIC`; decimal com vírgula ou ponto. Podem ser só um dos dois. |
| `observacao` | não | Texto livre, até 500 caracteres, guardado junto à faixa. |

Com `referencia_minima` e/ou `referencia_maxima`, o analito recebe uma faixa numérica **aprovada** (usada para marcar baixo/alto). Sem nenhum dos dois, a faixa fica **pendente de política**: o resultado é aceito, mas não é interpretado.

## 2. O que a importação faz

- A planilha é a fonte da verdade **para as colunas que carrega**. Campos que ela não carrega (por exemplo as permissões dos colaboradores) não são tocados.
- Cada linha vira `CRIAR`, `ATUALIZAR`, `SEM MUDANÇA` ou `ERRO`. Reimportar a mesma planilha dá `SEM MUDANÇA` em tudo e não grava nada.
- Exames **com solicitações** não aceitam troca de categoria, setor, fluxo, `exige_amostra`, `exige_agenda` ou `esquema_resultado` (mesma regra `CATALOG_IN_USE` da tela): a linha dá erro. Nome, tipo de amostra, anexo, prazos e `ativo` podem mudar.
- Em um exame `NUMERIC_PANEL`, os analitos montam o painel (código do painel = código do exame). Se os analitos mudam, a **versão do painel sobe**; se não mudam, ela é mantida. Sem linhas de analitos, um exame que já tem painel ativo mantém o painel. **Cada exame deve vir inteiro em uma única parte da planilha:** a planilha de analitos de um exame precisa trazer **todos** os seus analitos. Os que faltarem são **removidos** do painel; a validação mostra a linha `analitos removidos: ...` (com `(obrigatório)` quando for o caso), a tela diz "Remove: ..." e a CLI imprime o aviso. Confira essa lista antes de aplicar.
- Tudo ou nada: se qualquer linha tiver erro, **nada é gravado** e o relatório aponta a linha (número da linha no arquivo, como o Excel mostra) e o motivo. Corrija e envie de novo.
- Cada exame criado ou alterado gera um evento de auditoria, e a importação gera um evento `CatalogImported` com as contagens. Um exame novo e ativo já fica disponível para os técnicos que tinham todos os exames do setor.
- Um gestor só importa linhas dos setores que administra; linhas de outros setores dão erro.

## 3. Como validar e aplicar

### 3.1 Pela tela (ADMIN ou gestor)

1. **Administração → Serviços diagnósticos → Importar catálogo por planilha**.
2. Escolha o CSV de exames e, se houver painéis, o CSV de analitos.
3. **Validar**: mostra a tabela com linha, código, ação e detalhes (o que muda campo a campo). Nada é gravado.
4. Sem erros, **Aplicar importação**; a lista de serviços é recarregada.

### 3.2 Pela linha de comando (servidor)

Requer `APP_DATA_MODE=postgres` e `DATABASE_URL` do ambiente. O responsável (`--actor`) precisa ser um usuário ativo ADMIN ou gestor.

```bash
# validação (padrão): imprime a tabela e o resumo JSON, nada é gravado
npm run catalog:import -- --services exames.csv --analytes analitos.csv --actor admin@hospital.example

# aplicação
npm run catalog:import -- --services exames.csv --analytes analitos.csv --actor admin@hospital.example --apply
```

O código de saída é `1` quando há linha com erro (inclusive na validação) e `0` caso contrário, o que permite usar o comando em um passo de pipeline.

No servidor do hospital (Compose de produção) o comando roda de dentro da imagem de operações, que já contém os scripts e a credencial de runtime do banco; as planilhas entram por um volume somente leitura:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps \
  -v "$PWD/planilhas:/planilhas:ro" worker \
  node_modules/.bin/tsx scripts/catalog-import.ts --services /planilhas/exames.csv --analytes /planilhas/analitos.csv --actor admin@hospital.example
```

Acrescente `--apply` para gravar. `--no-deps` evita que o Compose reexecute o `migrate` antes da importação.

### 3.3 Ordem recomendada: homologação e produção

1. Cada setor entrega a sua planilha; consolide em um único par de arquivos e guarde-o no repositório do hospital ou em local controlado (a planilha é o registro do que foi aprovado).
2. **Homologação:** validar, corrigir até zerar os erros, aplicar, e conferir na tela de resultado os painéis criados (nomes, unidades, faixas).
3. Revisão dos responsáveis técnicos sobre faixas e prazos, com ajustes na planilha e nova importação (só as linhas alteradas aparecem como `ATUALIZAR`).
4. **Produção:** com a instalação já em pé ([DEPLOYMENT §3](DEPLOYMENT.md)), validar o **mesmo par de arquivos** e aplicar. Importe os exames **antes de criar os colaboradores** quando possível: um técnico novo recebe todos os exames ativos do setor.
5. Mudanças futuras: edite a planilha, valide e aplique de novo. Nada é apagado: para aposentar um exame, use `ativo = não`.

## 4. Limites conhecidos

- **Tamanho do envio.** As duas planilhas viajam em um único corpo JSON, limitado por `JSON_BODY_MAX_BYTES` (1 MiB por padrão). A tela recusa arquivos acima de 900 KB cada um; se a soma passar de 1 MiB, divida as planilhas em partes **por exame**: cada exame vai inteiro, com todos os seus analitos, em uma única parte (nunca o mesmo exame em duas partes), e cada parte traz os exames correspondentes na planilha de exames ou aumente o limite com revisão de risco.

- **Faixas por espécie:** o modelo atual guarda **uma** faixa de referência por analito, sem distinguir cão, gato ou outras espécies. Enquanto não existir um modelo de faixas por espécie, registre as faixas específicas em `observacao` e deixe `referencia_minima` e `referencia_maxima` vazias (faixa pendente) ou preencha só a faixa que valha para todos os pacientes atendidos. A observação é exibida junto à faixa, mas não é usada para marcar baixo/alto.
- **Valores permitidos de analito qualitativo** (lista fechada de opções) ainda não fazem parte da planilha: um analito `QUALITATIVE` aceita qualquer texto.
- Alterar os analitos de um exame sobe a versão do painel; rascunhos de resultado abertos na versão anterior precisam ser relançados no painel novo.
- O formato aceito é CSV (UTF-8). Arquivos `.xlsx` precisam ser salvos como CSV; cada arquivo tem no máximo 2000 linhas de exames, 10000 de analitos e cerca de 900 KB.
- A importação nunca remove exames (para aposentar um, use `ativo = não`). Já o painel de um exame é **substituído por inteiro**: analitos que não estão na planilha de analitos são removidos do painel, e a validação os lista (marcando os obrigatórios).

## 5. Mensagens de erro frequentes

| Mensagem | O que fazer |
| --- | --- |
| `Coluna desconhecida no cabeçalho` / `Coluna obrigatória ausente no cabeçalho` | O cabeçalho foi alterado: copie-o do modelo original. |
| `A linha tem N colunas; o cabeçalho tem M` | Há ponto e vírgula dentro de um texto sem aspas, ou uma coluna a mais ou a menos. |
| `Linha de exemplo do modelo` | Apague a linha de exemplo ou troque o código `EXEMPLO_...`. |
| `A estrutura deste serviço já está referenciada por solicitações` | O exame já foi solicitado; reverta a coluna estrutural para o valor atual. |
| `analitos removidos` | A planilha não trouxe analitos que o painel atual tem: confira se a planilha trouxe todos os analitos do exame. Se a remoção for intencional, siga em frente. Uma lista que passa de 1000 caracteres termina em `… e mais N`; a lista completa continua em `removedAnalytes` (tela "Remove: ..." e CLI). |
| `O esquema NUMERIC_PANEL exige linhas de analitos` | Preencha a planilha de analitos para esse exame. |
| `o exame X não consta na planilha de exames` | Inclua o exame na planilha de exames (mesmo que sem mudança) ou corrija o código no analito. |
| `Você não tem permissão para gerenciar o catálogo do setor` | A linha é de um setor que o seu perfil não administra; peça ao ADMIN ou ao gestor do setor. |
