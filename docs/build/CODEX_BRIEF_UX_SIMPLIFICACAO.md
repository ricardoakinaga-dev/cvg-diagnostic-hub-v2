# Brief para o Codex: simplificação de UX (uma página)

Objetivo: o sistema ficou burocrático. Deixar o uso diário rápido e intuitivo, no padrão do Plane
(https://github.com/ricardoakinaga-dev/plane), adaptado ao hospital.
Reimplementar o COMPORTAMENTO. **Não copiar código do Plane (AGPL-3.0).**

## Regras gerais
- Ler `node_modules/next/dist/docs/` antes de mexer em rotas (ver AGENTS.md).
- **Não criar runbook, relatório ou doc novo.** Só atualizar o que mudar de comportamento.
- Manter por baixo, sem pedir nada ao usuário: auditoria, CSRF, rate limit, autorização por perfil/setor.
- Não commitar. Não fazer deploy.
- Cada etapa termina com `typecheck`, `lint`, `vitest run` e os E2E afetados verdes.
- Entregar etapa por etapa, uma de cada vez, para auditoria.

## Decisão do dono
Senha de reautenticação, "motivo" e checkbox "confirmo" em administração **saem**.
Exceção única: **dar ou remover perfil ADMIN** continua pedindo reautenticação.
Motivo continua obrigatório só em: recoleta, cancelamento, rejeição e emenda de resultado (clínico).

## Etapa 1: Usuários
- Criar: **nome, e-mail, perfil**. Setor padrão = setor de quem cria. Fuso padrão do sistema.
- Senha inicial gerada pelo servidor, mostrada **uma vez** na tela (copiar), com troca obrigatória no primeiro login.
- Editar na própria linha (perfil, setor, ativo) com salvar. Desativar = 1 clique + desfazer.
- Remover os campos: motivo, senha do gestor, confirmo, fuso, setores gerenciados (vira opção avançada recolhida).
- Aceite: criar usuário em ≤ 4 interações; trocar o setor de alguém em ≤ 2; auditoria continua registrando autor e mudança.

## Etapa 2: Fila do setor como board
- Colunas = estados do fluxo. Arrastar o card muda o estado (via API existente, com `expectedVersion`).
- Quick add no fim da coluna: paciente + exame, Enter.
- Clicar no card abre painel lateral (peek) sem sair da fila.
- Mover para recoleta/cancelamento abre mini-diálogo com **motivo escolhido de lista**, nunca digitado.
- Aceite: liberar um exame = 1 arraste ou 1 clique; sem digitar código de motivo.

## Etapa 3: Catálogo e motivos
- Lista com edição inline, "duplicar", código gerado do nome, SLA com padrão.
- Remover da UI: "versão", "código protegido", banner de gate externo, "Administração sem atalhos".
- Aceite: criar exame novo com só o nome (resto com padrão).

## Etapa 4: Paciente e atalho global
- Cadastro de paciente: nome, espécie, tutor. O resto opcional (ala/leito só se internado).
- Atalho global (Ctrl+K): buscar paciente/exame, "novo exame", "novo paciente".

## Etapa 5: Separar o técnico
- Sessões, dead-letter e auditoria saem da Administração do dia a dia para uma aba **Sistema** (só ADMIN).
- Reprocessar dead-letter e revogar sessão: 1 clique + confirmação simples, sem senha.

## O que o auditor vai conferir em cada etapa
1. Nenhum controle de segurança foi removido do servidor (só da UI): autorização, CSRF, auditoria seguem testados.
2. Testes que exigiam senha/motivo foram ajustados, não apagados sem substituto.
3. Contagem de interações do aceite medida de fato (E2E).
4. Sem doc novo, sem exceção nova de cobertura, sem `any`/`skip` para passar teste.
