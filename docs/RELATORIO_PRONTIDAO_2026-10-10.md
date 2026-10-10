# Prontidão para produção depois da auditoria de 10/10/2026

**Para:** Ricardo Akinaga (dono do produto). **Base:** `main` depois das PRs desta rodada. **Veredito:** o código está pronto para a **homologação no servidor do hospital e para o piloto acompanhado**; a entrada em produção continua `NOT READY` até os itens do §4, que dependem do hospital e não podem ser feitos nem simulados pelo time técnico.

## 1. Os quatro bloqueadores técnicos da auditoria

| # | Achado | Situação | Onde |
| --- | --- | --- | --- |
| 1 | Notificação continuava listada depois que o acesso ao laudo foi reduzido | **Corrigido.** A notificação só aparece enquanto o destinatário ainda abre o resultado ou a solicitação; vale para a lista, o total, as não lidas, a contagem de críticos do painel e a confirmação. Nada é apagado: se o acesso voltar, ela volta | #67, D-058 |
| 2 | Emenda de laudo não avisava quem já tinha recebido o resultado | **Corrigido.** A emenda avisa na hora o solicitante e todos que receberam qualquer versão anterior (incluindo plantonistas alcançados pelo escalonamento); a re-liberação chega como "Resultado retificado"; a anulação também avisa os destinatários anteriores | #68, D-055 |
| 3 | Escalonamento do crítico sem saída operacional | **Corrigido.** Quando a escada esgota sem ninguém clínico alcançável, os administradores recebem um alerta (sem dado do paciente) e a métrica/alerta `CvgCriticalUnreachable` dispara; plantonista de outro setor é a reserva quando o setor não tem plantão; a prontidão do crítico (política aprovada, canal redundante, plantão por setor) aparece no console e em `GET /critical-results/readiness` | #70, D-056 |
| 4 | Gargalo da linha única do snapshot; worker ocioso regravando o estado | **Corrigido e medido.** O worker ocioso não grava nem pega o lock; abrir um laudo não passa mais pela fila de escrita; a fila é medida em produção com alerta. Margem medida: **50× o pico D2 estimado** dentro das metas do PRD, saturação perto de 160× a taxa de escrita do pico. O snapshot fica aprovado tecnicamente para o volume da D2, com critérios objetivos para antecipar o PROD-111 | #69, benchmark, D-059, D-061, [relatório](RELATORIO_CARGA_HOSPITALAR_2026-10-10.md) |

Achados novos desta rodada, também corrigidos:

- **O worker de produção não subia desde o #63** (o carregador de segredos lia `OUTBOX_HEARTBEAT_FILE` como se fosse segredo): sem worker, nenhuma notificação seria entregue. Encontrado pelo ensaio completo de restore; corrigido com allowlist explícita e teste que sobe o worker de verdade (#72, D-057).
- **CVE-2026-78669 (HIGH)** em `golang.org/x/net` nas imagens do MinIO e do `mc`: dependência atualizada (#67).
- **Proveniência:** a instalação local roda imagens `20261003` sem commit. Agora toda imagem e todo processo dizem de que commit vieram, o `deploy.sh` confere os contêineres em execução e `deploy/release/installation-provenance.sh` audita uma instalação (#71, D-060). **A instalação local não foi alterada**: para ser comprovável, precisa ser reconstruída a partir do commit revisado.
- Teste instável de rotação de senha: não era instabilidade, era um PostgreSQL em rede host que confia em `127.0.0.1` (#69).

## 2. O que a auditoria pediu para comprovar e o que foi comprovado

| Pedido | Comprovado nesta máquina (laboratório) | Falta (hospital) |
| --- | --- | --- |
| Backup externo e recuperação completa de banco e anexos, com limites aprovados | `npm run restore:drill`: banco e bucket perdidos juntos e restaurados do destino externo cifrado; **RPO 8–10 s, RTO 21–26 s**, reconciliação banco × bucket sem faltantes nem órfãos, controles negativos detectados (#73, D-062). Limites aprovados na D2: RPO 15 min, RTO 4 h | Repetir no servidor do hospital com o destino externo real e o tempo de download real (PROD-514) |
| Staging separado | Projetos `cvg-hml` e `cvg-prod` sem nada em comum (PROD-301) | O servidor (D11) |
| Gestão de segredos | Segredos só em arquivo, rotação documentada, allowlist (PROD-302, #72) | Gerar e guardar os segredos no servidor |
| Storage e antivírus reais | MinIO com criptografia/versionamento e ClamAV real no modo on-prem, EICAR em quarentena (PROD-307/308) | Subir no servidor e nomear o responsável pela quarentena |
| Alertas com responsáveis e ensaios de indisponibilidade | `npm run outage:drill` com a pilha inteira e o Prometheus real: worker, ClamAV, MinIO, PostgreSQL e app parados, cada um detectado pela regra certa e recuperado (#73) | Nomes e roteamento dos alertas (PROD-516 → PROD-513) e ensaio em homologação (PROD-515) |
| Volume e concorrência do hospital | `npm run perf:hospital`: 12 meses de histórico, 42 profissionais, 30 SSE, jornadas completas; dentro das metas até 50× o pico estimado | O pico real de usuários simultâneos (D2) e a mesma medição no servidor |
| Teste prolongado de carga | Soak de 2 h a 5× o pico: 41.051 requisições sem erro, latência sem deriva (0,94–0,97), memória estável (+5 MB/h) | Repetir por 24 h em homologação |
| Recuperação após falhas | App e worker mortos com `SIGKILL` e PostgreSQL reiniciado sob carga: recuperação em 7 s, 18–23 s e 2 s; nenhuma escrita perdida ou duplicada, todo resultado entregue uma vez (duas rodadas) | — |

## 3. O que já roda sozinho a cada mudança

A CI (8 checks obrigatórios) passou a incluir, além do que já tinha: a jornada clínica com o app e o worker derrubados e o critério de integridade; o boot real do worker com a configuração de produção; o contrato de que toda regra de alerta usa métricas que o app expõe; a proveniência no release.

## 4. O que depende do hospital (ninguém do time técnico pode fazer por vocês)

| Item | Quem | Backlog |
| --- | --- | --- |
| Servidor de homologação e produção, domínio, rede, destino externo do backup | TI do hospital | PROD-301, 304, 309, 514 (D11) |
| Nomes e telefones da escala técnica, roteamento dos alertas, janela de manutenção | TI e gestão | PROD-516 → 513 → 515 |
| Lista de valores críticos por exame e ativação nominal da política | Direção clínica e laboratório | PROD-401 (D3) |
| Conta e templates aprovados do WhatsApp Business, ou aceite por escrito de "só no sistema" | Direção clínica | PROD-402 |
| Planilhas do catálogo preenchidas por setor | Cada setor | PROD-407 (D10) |
| Prazo legal de guarda para ligar o expurgo | Jurídico | PROD-501, 502 (D5) |
| Conferência diária do cadastro com o prontuário (nome do sistema, responsável) | Gestão clínica | PROD-408 |
| Modelo de impressora e leitor de etiquetas | TI e laboratório | PROD-405 |
| Pico de usuários simultâneos | Gestão | PROD-110 (D2) |
| Pentest externo, inspeção de acessibilidade, revisão independente | Empresa contratada | PROD-601…605 |
| UAT por jornada, treinamento, piloto de 6–8 semanas com contingência manual, go/no-go assinado | Setores e dono do produto | PROD-701…704, 801 |

## 5. Ordem recomendada

1. **Servidor de homologação** com a release (`deploy/release/deploy.sh`), conferida por `installation-provenance.sh`; rodar lá `restore:drill`, `outage:drill` e `perf:hospital`.
2. **Nomes da operação** para os alertas e ensaio de cada alerta em homologação.
3. **Conteúdo clínico:** lista de críticos, catálogo, WhatsApp (ou aceite), prazo legal.
4. **Pentest e revisão independente** sobre o código congelado.
5. **UAT e treinamento**, depois **piloto acompanhado** e **go/no-go assinado**.
