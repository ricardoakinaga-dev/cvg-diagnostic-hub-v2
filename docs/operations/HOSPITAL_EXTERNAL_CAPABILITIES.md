# Integração externa e assistência de texto operacional

Os adaptadores concretos usam os contratos `CVG_OPERATIONAL_V1` (HIS/LIS/PACS), o perfil específico `HIS_V4` e `CVG_DOCUMENT_ASSISTANCE_V1` (assistência de documento). Eles estão desativados por padrão. O hospital informou adoção do `cvg-his-v4` nesta VPS; LIS/PACS e provedor de assistência permanecem não informados. Código de referência HIS foi inspecionado, sem consultar dados, segredos ou alterar o programa instalado. `deploymentVerified:false` permanece explícito: não houve endpoint/credencial aprovados, transmissão real ou piloto homologado. Aceite externo, proteção de dados e responsável institucional continuam necessários no gate de implantação. Ensaios locais usam receptores HTTPS descartáveis e dados sintéticos.

## Configuração do operador

Para cada `HIS`, `LIS` ou `PACS`, configure o prefixo `HOSPITAL_INTEGRATION_<SYSTEM>_` com:

| Sufixo | Requisito |
| --- | --- |
| `ENABLED` | `true` somente após decidir habilitação do canal. Ausente/desativado recusa comandos com 503. |
| `ENDPOINT` | HTTPS aprovado, com caminho do contrato; sem credenciais na URL, query ou fragmento. |
| `ALLOWED_HOSTS` | Hosts exatos separados por vírgula, sem wildcard. |
| `ALLOWED_IPS` | Todos os endereços IP autorizados do destino; DNS que retorna endereço fora da lista é recusado. |
| `TOKEN_FILE` | Caminho absoluto de arquivo regular privado (0600 ou mais restritivo), token remoto de pelo menos 32 caracteres sem espaços. |
| `HMAC_SECRET_FILE` | Arquivo privado com segredo compartilhado de pelo menos 32 caracteres sem espaços. |
| `CONTRACT_REFERENCE` | Referência real do contrato institucional/fornecedor adotado. |
| `TIMEOUT_MS` | Inteiro entre 1.000 e 60.000; padrão 10.000. |
| `CA_FILE` | Opcional: certificado CA do destino privado; validação TLS continua obrigatória. |

Monte arquivos somente no processo que precisa do canal, com propriedade de leitura compatível com seu usuário e sem gravar segredos no repositório. O endpoint não pode ser fornecido pelo cliente. A conexão usa o IP aprovado resolvido para aquela transmissão, exige TLS 1.2 ou posterior e não segue redirects. Revalidar DNS/endereços e o certificado faz parte da manutenção do destino.

A administração emite token de ingresso pela API/UI com ator existente ativo, finalidade única, setores restritivos, pacientes opcionais e validade entre 5 minutos e 90 dias. O ator conserva suas permissões/grupo e escopo atuais; credencial não concede acesso adicional. Administrador técnico prepara credenciais; transmissão clínica exige `integration.exchange` e autorização nativa correspondente. Token bruto é exibido uma vez; perda exige rotação. Rotação invalida o anterior, revogação não pode reativar a credencial.

## Contrato de entrada e saída

O ingresso usa `POST /api/v1/hospital-integrations/<SYSTEM>/ingress`, bearer dedicado e `x-hub-signature-256: sha256=<hex minúsculo>` calculado sobre bytes UTF-8 exatos do JSON enviado. O bearer não autentica outras APIs. Limite: 2.000.000 bytes e profundidade 32. As identidades externas devem ser opacas, sem dados identificáveis em códigos ou referências técnicas.

O envelope de entrada tem `contract`, `messageId`, `externalEntityId`, `sequence`, `occurredAt`, `purpose` e `payload`. A sequência começa em 1; cada mensagem seguinte depende de sucesso da anterior. Identidade tem unicidade institucional por sistema/direção; trocar credencial não permite repetir conteúdo diferente sob o mesmo identificador. A versão OpenAPI descreve os payloads estritos e obrigatoriedade de revisão do item. HIS cria demanda sujeita à triagem; LIS/PACS criam somente rascunho do executor atual. Liberação, revisão, alerta crítico e cuidado mantêm seus comandos humanos e políticas existentes.

A saída recebe referência a demanda HIS ou item diagnóstico LIS/PACS e captura versão/hash, mantendo o payload na autoridade original. Envia envelope JSON com a mesma identidade, `idempotency-key: <messageId>`, bearer remoto, `x-cvg-contract` e HMAC em `x-cvg-signature`. O receptor adotado precisa tornar essa identidade idempotente, inclusive após timeout ambíguo. O recibo externo estrito é `{contract:"CVG_OPERATIONAL_V1",messageId,receiptId,status:"ACCEPTED"}`. Isso prova a resposta de aceitação do receptor e não comprova execução clínica ou publicação no fornecedor.

Timeout/falha registra código seguro, tentativas e retry. Repetição explícita espera 30 segundos, verifica origem/permissões atuais e conserva payload/identidade. Uma origem alterada não pode ser reenviada sob a identidade anterior; mensagem permanente ou resultado externo ambíguo bloqueia avanço da sequência. Concilie o recibo e estado no fornecedor antes de decidir novo fluxo; não troque identificadores para escapar desse bloqueio. Reconciliação específica do fornecedor e prova de recepção após perda de resposta precisam ser aprovadas no piloto, sem considerar um estado `CLAIMED` ou `FAILED` como entrega.

## Perfil real HIS v4

A referência é `/home/rmakinaga/cvg-his-v4`, branch `codex/install-host-dependencies`, commit `0ebfc5b6627c8ed006075dc5285fd3514443c806`. Os arquivos de implementação usados estavam iguais ao commit; o OpenAPI da árvore de trabalho tinha alterações alheias, portanto não foi a autoridade isolada. A revisão de fonte não confirma a revisão da imagem instalada. Contratos observados: `apps/api/src/routes/api-keys-routes.ts:135` (`GET /integrations/catalog`), `apps/api/src/helpers/auth-helpers.ts:33` (`X-API-Key`), `packages/modules/webhooks/src/index.ts:613` (headers de entrega), `:759` (assinatura v2), `apps/api/src/runtime.ts:669` (evento `encounter.created`) e `packages/modules/event-consumers/src/webhooks.consumer.ts:76` (adoção desse evento). A SPA também encaminha `/api/integrations/catalog` à mesma rota, removendo `/api/` no nginx.

A [observação sanitizada dos artefatos instalados em 2026-10-11](HIS_V4_INSTALLED_PROVENANCE_2026-10-11.json) registra SPA, API e worker com tag `272581dc60b7`, seus IDs e digests, obtidos por leitura de metadados Docker. Os labels permitidos de revisão, versão e origem estavam ausentes nas imagens e containers; a correspondência com o HEAD de referência permanece `UNKNOWN`. A tag não comprova o commit usado na construção. Essa identificação dos artefatos não comprova compatibilidade de integração, entrega ou homologação, e conserva `deploymentVerified:false`.

O HIS não oferece o envelope/recibo `CVG_OPERATIONAL_V1`. Suas APIs clínicas usam sessão JWT e IDs próprios; o `X-API-Key` de descoberta não concede criação de atendimento, pedido ou laudo. O catálogo anuncia capacidades, inclusive bridge laboratorial, sem comprovar uso em produção: `apps/api/src/routes/laboratory-integration-routes.ts:31` proíbe montar o ingresso local de equipamentos em ambiente production-like. Não há contrato LIS/PACS real identificado nesta avaliação.

`GET /api/v1/hospital-integrations/his-v4/catalog` consulta apenas o catálogo do HIS por HTTPS, com `X-API-Key` de servidor e permissão remota `integrations.read`. Exige sessão interna, `integration.manage` e administração global `ADMIN|SUPERADMIN`; retorna conta, data da observação e anúncios sanitizados. Não retorna chave/API-key ID, configurações de segredos, endpoints de operadores, pacientes ou provas de homologação. A consulta é explícita e não publica mensagens no HIS.

Configure `HOSPITAL_HIS_V4_ENABLED=true` e os seguintes sufixos no prefixo `HOSPITAL_HIS_V4_`:

| Sufixo | Requisito |
| --- | --- |
| `CATALOG_ENDPOINT` | HTTPS aprovado, caminho exato `/integrations/catalog` ou `/api/integrations/catalog`; nenhuma query, credencial ou fragmento. |
| `ALLOWED_HOSTS`, `ALLOWED_IPS`, `TIMEOUT_MS`, `CA_FILE` | Mesmas restrições de host/IP, DNS fixado, tempo limitado e TLS verificável dos adaptadores CVG. |
| `API_KEY_FILE` | Arquivo privado absoluto com chave HIS de pelo menos 32 caracteres, limitada a `integrations.read`. |
| `ACCOUNT_ID`, `CONTRACT_REFERENCE` | Conta exata e referência institucional do contrato real adotado; resposta de outra conta é recusada. |
| `WEBHOOK_ENABLED` | Ausente/false mantém recebimento indisponível; `true` exige toda a ligação abaixo. |
| `WEBHOOK_SECRET_FILE` | Arquivo privado com segredo compartilhado forte, configurado também no webhook HIS pelo operador autorizado. Webhook sem assinatura é recusado. |
| `WEBHOOK_ID`, `CREDENTIAL_ID`, `CREDENTIAL_VERSION` | Webhook HIS exato, credencial Hub `profile:HIS_V4`/`HIS_INTAKE` e sua versão atual. Rotação invalida o pin até reconciliação explícita da configuração. Revogação/expiração/ator desabilitado bloqueiam novos eventos e replay. |
| `MAPPINGS_FILE` | Arquivo privado JSON, versão 1, ações e vínculos explícitos abaixo. Nenhuma aproximação de nome, rótulo, espécie ou código. |

Emita a credencial HIS v4 pela operação já existente de credenciais, selecionando `profile:"HIS_V4"`, sistema HIS, finalidade HIS_INTAKE e ator/setores/pacientes autorizados. A configuração de descoberta válida permite emissão antes de instalar o vínculo do webhook. Seu token bruto não autentica o ingresso v2: esse canal autentica a assinatura do HIS e revalida a credencial persistida por ID/versão. Credenciais sem profile mantêm CVG; uma credencial HIS v4 não pode autenticar o ingresso CVG genérico.

O arquivo de mapeamentos contém `{version:1,actions:[{event:"encounter.created",action:"CREATE_INTAKE",departmentCode,title,priority,typeId?}],patients:[{hisId,hubId}],encounters:[{hisId,hubId}]}`. Cada lista de vínculos é unívoca; IDs Hub devem existir e estar relacionados entre si, com autorização atual do ator. Título/tipo/prioridade/setor são decisões explícitas do mapeamento institucional. A única ação adotada é o evento real `encounter.created` com `data.status:"reception"`, valor produzido em `packages/modules/encounters/src/index.ts:500`, originando demanda Hub manual em `RECEIVED`, sujeita à triagem. O atendimento mapeado do Hub conserva seu próprio estado `OPEN`; não se traduz FSM clínica por aproximação. Motivo/identificações do payload não são copiados para logs ou recibos. Não cria paciente/atendimento por aproximação, pedido diagnóstico, tarefa aceita, execução, laudo ou aprovação automática. Evento não adotado, conta divergente ou vínculo ausente é recusado sem criar demanda.

`POST /api/v1/hospital-integrations/his-v4/webhooks/<credentialId>` é público somente para autenticação dedicada v2, sem cookie, CSRF ou bearer. Exige `application/json`, UTF-8 e no máximo 100.000 bytes. Aceita os headers reais `X-Webhook-ID`, `X-Webhook-Event`, `X-Webhook-Delivery-ID`, `Idempotency-Key` (igual ao delivery ID), `X-Webhook-Signature`, `X-Webhook-Timestamp` e `X-Webhook-Signature-Version:v2`. A assinatura é `sha256=<hex minúsculo>` do HMAC-SHA256 de `<timestamp-unix-segundos>.<corpo UTF-8 exato>`. Rejeita diferença temporal maior que 300 segundos, adulteração, ausência de assinatura e divergência entre evento no header/corpo ou conta do corpo/ligação. O envelope real contém `{id,event,timestamp,accountId,data}`; não existe `sequence` nesse perfil.

O produtor HIS acrescenta `data._meta` antes de enfileirar o webhook. Quando presente, esse objeto exige os nove campos canônicos do EventBus, versão `1`, origem `encounters` e conta igual ao envelope; aceita somente os extras técnicos conhecidos `publishedAt`, `sourceService`, `tenantId` e `traceparent`. Identificadores técnicos têm limite de 255 pontos de código Unicode. IDs do EventBus, payload e entrega são distintos. A metadata não escolhe ator, paciente, atendimento ou ação no Hub e não é copiada para demanda, auditoria ou resposta pública; o hash opaco do evento completo continua detectando colisões. A validação local e o catálogo HTTPS da fonte pinada estão no [registro de 12/10](../build/HOSPITAL_PLANNER_HIS_CONTRACT_FOLLOWUP_2026-10-12.md); isso não certifica a imagem instalada.

Comando nativo e recibo ficam na mesma transação. Unicidades `(webhookId,deliveryId)` e `(accountId,providerPayloadId)` impedem duplicata na reentrega e recriação do webhook; hash de payload/mapeamento e ator são conferidos antes do replay. O mesmo `encounter.created` com outro provider-payload ID é recusado para conciliação, em vez de criar segunda demanda. O recibo seguro informa `RECEIVED_FOR_TRIAGE`, nunca execução externa. Redelivery pode receber o ID original de entrega no recibo; ambos se referem à mesma ocorrência persistida.

O HIS existente bloqueia destinos privados no envio de webhook (`packages/modules/webhooks/src/index.ts:600`). Receber diretamente em loopback, IP LAN ou bridge Docker nesta VPS continua bloqueado pelo HIS. Este trabalho não altera esse controle, rede, portas, contêineres, credenciais ou dados do HIS. Antes de habilitar, o operador precisa definir um receptor HTTPS aprovado acessível segundo essa política, configurar segredos e identidades reais, comprovar roteamento/entrega, revisar o mapeamento e validar a jornada com o responsável institucional. A descoberta em endpoint privado explicitamente aprovado pelo Hub não remove a restrição do HIS no sentido inverso.

## Assistência opcional

Use prefixo `HOSPITAL_AI_` com os mesmos sufixos de transporte (`ENDPOINT`, `ALLOWED_HOSTS`, `ALLOWED_IPS`, `TOKEN_FILE`, `HMAC_SECRET_FILE`, `TIMEOUT_MS`, `CA_FILE`) e adicionalmente `ENABLED=true`, `PROVIDER`, `MODEL`, `PURPOSE=OPERATIONAL_DOCUMENT_TEXT` e `DECISION_REFERENCE`. A decisão institucional deve cobrir conteúdo permitido, transmissão, retenção no provedor, proteção de dados e revisão humana. Não existe provedor fictício habilitado automaticamente.

Após confirmação explícita de transmissão, somente conteúdo do rascunho operacional e instrução são enviados com contrato `CVG_DOCUMENT_ASSISTANCE_V1`, identidade idempotente, modelo e finalidade. O provedor precisa retornar `{contract,messageId,receiptId,model,content}` compatível com o modelo configurado e JSON rico seguro. O pedido possui claim durável de 120 segundos; falha libera repetição do mesmo pedido/identidade, enquanto requisição concorrente ou conteúdo diferente sob a chave é recusado. Timeout ou crash pode exigir replay no receptor idempotente.

Sugestão permanece pendente de revisão. Aplicar exige confirmação, motivo e versões atuais iguais à origem; edição posterior impede sobrescrever o texto. Aplicação altera rascunho; publicação clínica mantém aprovação separada. Sugestões podem ser rejeitadas, acessos são revalidados após resposta e em replay, e conteúdo do provedor não entra nos logs técnicos/auditoria. Nenhuma operação de assistência executa cuidado ou interpreta/libera laudo automaticamente.

## Evidência e aceite

Testes incluem receptor HTTPS real descartável com CA própria, HMAC, IP aprovado, bloqueio de DNS fora da lista/redirect/recibo inválido/limite de resposta; HTTP com token dedicado, limite de corpo, revogação e configuração ausente; PostgreSQL descartável com duas stores concorrentes, rollback após comando nativo e repetição exata. Eles verificam o mecanismo e não representam homologação de HIS/LIS/PACS ou provedor IA real. Antes do piloto, comprovar contrato/adaptação do fornecedor, entrega/recibo reais, sequência e repetição após falha, restrições de escopo, proteção dos segredos e revisão humana com responsáveis nomeados.
