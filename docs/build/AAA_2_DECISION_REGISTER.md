# Registro de decisões AAA-2 — histórico supersedido

> **Aviso (07/09/2026):** este registro preserva decisões, propostas e
> perguntas do ciclo AAA-2. Ele não substitui as decisões D-01–D-06 nem o
> registro de autoridade do programa AAA-3; nenhum “current” histórico aqui
> fecha um gate atual.

**Versão:** AAA-2 · **Atualizado:** 05/09/2026 · **Estado:** aberto e bloqueante para os gates indicados.

Este registro transforma as decisões D-01–D-06 do plano executivo em itens que podem ser aceitos. Uma linha `OPEN` não autoriza interpretar a política no código nem liberar uso hospitalar. O responsável abaixo é o papel que deve convocar a decisão; uma pessoa titular e uma substituta ainda precisam ser nomeadas pelo patrocinador.

| ID | Decisão a produzir | Alternativas a avaliar | Impacto se não decidida | Decisor obrigatório | Responsável de preparação | Substituto | Prazo de gate | Estado | Próxima ação verificável |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-01 | Identidade institucional, patient/owner, homônimos, referência externa, delegação, transferência e alta | IdP institucional como mestre; integração com mestre clínico; contingência manual temporária | Mistura de pacientes, ownership incorreto e revogação incompleta | Clínica + Segurança + Produto | Produto | A nomear | AAA2-014/021/022/036 | OPEN | Convocar workshop e anexar matriz assinada, casos de homônimo e procedimento de revogação |
| D-02 | Emenda, versão anterior, revisão, conclusão automática, falha de processamento e motivos de US | Política por setor; política única com exceções versionadas | Estado clínico ambíguo, sobrescrita e métricas incompatíveis | Clínica + Lab/RX/US | Lead clínico | A nomear | AAA2-023/025/026 | OPEN | Publicar tabela de estados com vigência, exemplos positivos/negativos e aprovadores |
| D-03 | Templates, unidades, faixas/populações, criticidade, plantão, fallback, acknowledgement e escalonamento | Catálogo institucional; catálogo por setor; fallback humano de plantão | Resultado sem interpretação autorizada ou crítico sem destinatário | Clínica + líderes dos setores | Lab | A nomear | AAA2-024/027/028 | OPEN | Definir campos obrigatórios e revisar política de crítico sem inserir thresholds por inferência |
| D-04 | SLA, início, pausas, calendário, prioridade, duplicidade, timezone e protocolo humano | Relógio por recebimento; por início operacional; calendário por setor | Atraso e prioridade calculados de forma inconsistente | Produto + Operação clínica | Produto | A nomear | AAA2-029/030/034 | OPEN | Aprovar exemplos de cálculo, feriados, pausas e janela de duplicidade |
| D-05 | Retenção, residência, exportação/eliminação, IdP, scanner, storage, segredos, RPO/RTO e SLO | Serviços hospitalares existentes; serviços gerenciados; operação híbrida | Impossibilidade de provar privacidade, recuperação e produção segura | Privacidade + Segurança + Infraestrutura | SRE | A nomear | AAA2-036/038/039/041/044/045 | OPEN | Inventariar serviços disponíveis, donos de conta, regiões, métricas e critérios de restore |
| D-06 | Escopo do piloto, participantes, treinamento, suporte, interrupção e autoridade de rollback | Piloto por setor; piloto transversal limitado; shadow mode | Não há autoridade ou critério seguro para uso hospitalar | Patrocinador + Hospital + SRE | Produto | A nomear | G5 / AAA2-059/060 | OPEN | Redigir termo de piloto com participantes, janela, suporte, stop criteria e assinaturas |

## Controle de aprovação

Cada decisão só pode mudar para `APPROVED` quando houver nome, cargo, data, versão da política, alternativa rejeitada, impacto aceito e anexo sanitizado. O executor pode preparar contratos, fixtures e testes sintéticos enquanto a decisão está `OPEN`; não pode converter esse trabalho em aceite clínico. Alteração posterior invalida as evidências dependentes e exige nova versão do registro.

**Bloqueios atuais:** nenhum decisor humano foi nomeado neste checkout; por isso D-01–D-06 permanecem `OPEN`. A ausência de resposta não é aprovação e não permite marcar AAA-21 ou AAA-22 como PASS.
