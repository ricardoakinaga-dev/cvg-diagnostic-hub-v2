# Relatório de direção e auditoria frontend

## CVG Diagnostic Hub — direção visual State of Art

**Data:** 07/09/2026  
**Escopo:** somente frontend, UX, UI, motion, responsividade, acessibilidade visual/interativa, performance percebida e viabilidade de implementação.  
**Tipo:** relatório de direção + auditoria frontend em modo audit-only.  
**Veredito da direção proposta:** **CONDITIONAL PASS / REVIEW REQUIRED**.  
**Veredito da implementação frontend atual:** **REJECT para AAA / State of Art**.  
**Leitura principal:** a base atual é funcional e possui contratos de produto muito bons, mas ainda não sustenta a promessa visual “AAA / State of Art”. Este documento define a direção necessária para chegar lá sem sacrificar segurança contextual, legibilidade ou verdade operacional.

> “AAA” aqui é um bar de execução, não um estilo visual. A surpresa deve vir da clareza, do ritmo, da materialidade e da forma como o sistema torna frescor, ownership, prioridade e próxima ação imediatamente compreensíveis — não de efeitos que competem com o diagnóstico.

## 1. Resumo executivo

O CVG Diagnostic Hub tem uma oportunidade rara: transformar uma central diagnóstica operacional em um instrumento digital clínico, calmo e vivo. O produto não precisa parecer um dashboard genérico de SaaS, um prontuário inchado ou uma interface “cyber” de laboratório. Ele deve parecer uma superfície de decisão confiável: cada item tem origem, estado, idade, responsável e próxima ação; cada mudança tem lineage; cada incerteza é assumida de forma legível.

A direção recomendada é **Instrumento clínico vivo**:

- canvas mineral claro, com profundidade baixa e controlada;
- trilho de navegação azul-petróleo com microtextura técnica muito discreta;
- acento teal para ação, coral para criticidade e âmbar para atenção, sempre acompanhados de texto e ícone;
- tipografia sans-serif técnica, legível em português, com numerais tabulares e uma mono apenas para protocolo, accession, timestamps e identificadores;
- hierarquia baseada em atenção e contexto, não em uma sequência de cards de métricas;
- timeline como espinha de auditoria e linhagem, não como decoração;
- movimento curto, compositado e sem surpresa, usado para explicar transição, frescor, foco e recuperação;
- navegação mobile que libera espaço de conteúdo, em vez de comprimir permanentemente a tela em um trilho estreito;
- componentes que tratam loading, vazio, erro, parcial, stale, offline, negado, conflito, anexo em quarentena e estado desconhecido como estados de produto.

O redesign deve preservar estes contratos:

1. paciente + atendimento/encounter permanecem inequívocos;
2. uma solicitação pode conter itens independentes;
3. solicitado, processando, resultado liberado, visualizado, revisado, confirmado e concluído não são sinônimos;
4. o browser não inventa criticidade, SLA, ownership, permissionamento, deadline ou flag laboratorial;
5. realtime invalida e atualiza; ele não é, sozinho, uma confirmação clínica;
6. nenhuma ação sensível mostra sucesso final antes da confirmação do servidor;
7. um snapshot stale é melhor que uma tela vazia, desde que a idade e a limitação estejam visíveis;
8. dados ausentes, negados ou fora do escopo não podem ser mascarados como zero, sucesso ou “sem resultados”.

## 2. Escopo, autorização e método

### Incluído

- leitura da documentação em docs, incluindo descoberta, PRD, IA, especificações de tela, jornadas, arquitetura frontend, workspace do paciente, estados, notificações, realtime, permissões, modelo de erro, qualidade, testes e readiness;
- inspeção do frontend atual em src/app, src/components, src/features e packages/ui;
- leitura da documentação local da versão instalada do Next.js antes de formular qualquer recomendação de implementação;
- inspeção de evidência visual local existente;
- três leituras independentes de documentação/contratos;
- dois briefs de crítica visual/UX independentes, com barra congelada;
- análise de riscos de acessibilidade, responsividade, motion, evidência e migração;
- produção deste relatório.

### Não incluído

- alteração de código, CSS, rotas, componentes, dados, contratos ou infraestrutura;
- decisão de política clínica, criticidade, SLA, ownership, retenção, fallback ou break-glass;
- aprovação de produção, homologação clínica ou prontidão operacional;
- redesign de backend, banco, APIs ou segurança de servidor, exceto quando a interface depende explicitamente desses contratos;
- afirmação de que o produto atual já é AAA.

### Integridade do workspace

O repositório já estava muito modificado antes da auditoria. Essas alterações foram preservadas. Nenhum arquivo de implementação foi alterado para produzir este relatório.

Durante a janela da auditoria, o fingerprint de repositório também detectou mudanças em artefatos gerados — caches do Next/Turbopack, relatórios do Playwright e arquivos de upload temporários — enquanto os arquivos-fonte frontend usados como base permaneceram sem mudança de conteúdo. Por isso, a evidência temporal anterior não é tratada como baseline atual: ela é marcada como histórica ou stale e deverá ser recapturada antes de qualquer aprovação visual.

## 3. Convenção de evidência

Este documento diferencia fato observado de direção proposta. Essa distinção é obrigatória porque parte dos números e dos renders disponíveis é local, sintética ou anterior ao estado atual do source.

| Marca | Uso neste relatório | Tratamento |
|---|---|---|
| **OBSERVED** | Está explícito na documentação ou foi observado no source atual. | Pode orientar a análise, sem extrapolar para produção. |
| **INFERRED** | Conclusão derivada de mais de uma evidência. | Deve ser validada contra produto/usuários antes de virar contrato. |
| **PROPOSED** | Direção visual, token, componente, motion ou critério recomendado. | É o material de trabalho do próximo ciclo. |
| **STALE** | Render, packet, hash ou métrica anterior ao source corrente. | Não serve como aprovação atual; serve apenas como sinal histórico. |
| **NOT RUN** | Não houve evidência nesta auditoria. | Não pode ser apresentado como aprovado. |
| **OPEN QUESTION** | A documentação deixa a decisão em aberto. | Não criar UI definitiva ao redor dessa decisão. |
| **BLOCKED** | A validação depende de política, dados, usuários, device ou ambiente ainda ausente. | Registrar e encaminhar ao gate humano correspondente. |

### Fontes centrais

- [README de documentação](README.md): ordem normativa, vocabulário de evidência e snapshot de qualidade.
- [Discovery](discovery/DISCOVERY.md): problema, escopo, north star, personas e perguntas abertas.
- [PRD](prd/PRD.md): capacidades, NFRs, fluxos e contratos de interação.
- [Design System](ux/DESIGN_SYSTEM.md): intenção visual, componentes-base e princípios de acessibilidade.
- [Information Architecture](ux/INFORMATION_ARCHITECTURE.md): navegação, hierarquia e comportamento responsivo.
- [Screen Specifications](ux/SCREEN_SPECIFICATIONS.md): estados e intenção de cada superfície.
- [User Flows](ux/USER_FLOWS.md): fluxos implementáveis e limites da evidência local.
- [Patient Workspace](v2/PATIENT_WORKSPACE.md): snapshot, autorização, freshness, parcialidade e matriz responsiva.
- [Quality Bar v2](v2/QUALITY_BAR.md): critérios atenção-first e same-truth.
- [Realtime](spec/REALTIME.md), [Notifications](spec/NOTIFICATIONS.md), [Permissions](spec/PERMISSIONS.md) e [Error Model](spec/ERROR_MODEL.md): estados que a UI não pode simplificar.
- [Architecture](architecture/ARCHITECTURE.md) e [Components](architecture/COMPONENTS.md): limites de frontend e API.

## 4. Diagnóstico do frontend atual

### 4.1 O que já é forte — OBSERVED

1. **A intenção de produto é correta.** A documentação trata o hub como central operacional de diagnóstico veterinário, não como prontuário, ERP, PACS ou portal de tutor.
2. **A hierarquia de domínio está explicitada.** Patient → Encounter/Admission → DiagnosticRequest → DiagnosticRequestItem → Sample/Procedure → Result/ResultVersion → Review/Acknowledgement → Timeline/Audit.
3. **O foco é atenção operacional.** A documentação prioriza resultados novos, críticos, recoletas, atrasos, minha fila e próxima ação.
4. **Os estados difíceis foram considerados.** Loading, vazio, erro, parcial, stale, offline/degraded, conflito, permissão, anexo em quarentena e estado desconhecido aparecem como contratos, não apenas como exceções.
5. **A implementação atual já tem fluxos reais.** Queue, Command Center, Patient Workspace, resultado/revisão e notificações não são apenas placeholders.
6. **Há disciplina de acessibilidade básica.** O shell define foco, existem testes automatizados, diálogos têm tratamento de foco e o source já possui media query de reduced motion.
7. **A direção cromática existente é coerente.** Azul-petróleo, canvas claro, teal operacional, coral/âmbar e superfícies brancas já formam uma base reconhecível.
8. **As ações clínicas não são apenas visuais.** Os componentes atuais usam confirmação server-side e diferenciam estados pending, success, failure e unknown em vários caminhos.

### 4.2 Onde a experiência ainda não chega ao bar State of Art

| ID | Severidade | Achado | Evidência | Impacto frontend |
|---|---:|---|---|---|
| F-01 | Alta | A evidência visual disponível é anterior ao estado atual do source. | Os manifests v8/v9 e packets em .orchestrate carregam timestamps de 06/09/2026 e hashes que não coincidem integralmente com o source observado em 07/09/2026. | Não existe baseline visual corrente para aprovar acabamento, regressão ou AAA. |
| F-02 | Alta | O visual atual é limpo, mas ainda próximo de um SaaS operacional baseado em cards. | Render histórico do Patient Workspace; [globals.css](../src/app/globals.css#L1-L31) concentra canvas, superfícies, sombras e raios sem uma linguagem material mais específica. | Falta uma assinatura visual própria para o domínio diagnóstico. |
| F-03 | Alta | A navegação mobile preserva um trilho estreito em vez de liberar o conteúdo. | [globals.css](../src/app/globals.css#L773-L826) reduz a sidebar, e o render histórico mostra rail de aproximadamente 92px em 375px. | Identidade, status e próxima ação disputam largura; labels ficam pequenos e o produto parece desktop comprimido. |
| F-04 | Alta | O sistema de tokens existe, mas ainda é pouco estratificado. | Há variáveis úteis no topo de [globals.css](../src/app/globals.css#L1-L31), porém muitos valores são usados diretamente no stylesheet global. | Alterar densidade, tema, estado ou superfície de forma consistente fica caro e arriscado. |
| F-05 | Alta | O pacote de UI compartilhado ainda expõe somente Surface. | [packages/ui/src/index.tsx](../packages/ui/src/index.tsx) exporta um primitive de superfície, sem Button, Status, Field, Dialog, Icon, Timeline ou FeedbackBanner canônicos. | Cada feature pode resolver estado, foco e aparência de maneira ligeiramente diferente. |
| F-06 | Alta | Tipografia não está formalizada como asset ou contrato. | [layout.tsx](../src/app/layout.tsx#L1-L15) não usa next/font; o CSS declara Inter e Georgia como fallback. | Métrica, quebra de linha, numerais, diacríticos e estabilidade visual não têm baseline controlada. |
| F-07 | Média | Motion atual é pontual, não um sistema. | [globals.css](../src/app/globals.css#L116-L205) usa transições curtas, shimmer, spin e hover translate; há reduced motion, mas não há gramática por intenção. | O produto pode parecer “parado” em mudanças de estado e “decorado” em interações sem prioridade. |
| F-08 | Média | Badges/pills carregam muita responsabilidade semântica. | O CSS usa radius 999px em diversos estados; a documentação exige texto/ícone além de cor. | Criticidade, overdue, stale, review e resultado correm o risco de virar um mesmo padrão visual. |
| F-09 | Média | A arquitetura de navegação tem divergência documental. | A IA descreve entradas principais e Administração separada; S-11 adiciona Centro de gestão; o shell atual tem links de gestão/admin conforme role. | O redesign não deve congelar um menu final antes de resolver ownership, role e escopo. |
| F-10 | Crítica | Permissão não pode ser resolvida no visual. | [PERMISSIONS.md](spec/PERMISSIONS.md#L13) e [COMPONENTS.md](architecture/COMPONENTS.md#L21) condicionam ator, ação, recurso, escopo, estado e versão de política. | Esconder/desabilitar CTA é affordance; não é autorização. A UI precisa comunicar o motivo sem vazar recurso. |
| F-11 | Crítica | Identidade de paciente é o maior risco de compreensão. | [RISKS.md](discovery/RISKS.md#L7), [DESIGN_SYSTEM.md](ux/DESIGN_SYSTEM.md#L23) e [DOMAIN_MODEL.md](spec/DOMAIN_MODEL.md#L33) exigem contexto contra homônimos e troca de leito. | O Patient Identity precisa ser um componente de segurança, não apenas um cabeçalho bonito. |
| F-12 | Crítica | Estado “pendente” é amplo demais para orientar ação. | [STATE_MACHINES.md](spec/STATE_MACHINES.md#L9) separa REQUESTED, SCHEDULED, RECEIVED, IN_PROGRESS, AWAITING_REPORT e exceções. | O sistema visual precisa mostrar estágio real, idade e next action, não só um badge “Pendente”. |
| F-13 | Crítica | Resultado crítico não pode ser apenas um badge vermelho. | [NOTIFICATIONS.md](spec/NOTIFICATIONS.md#L34-L45) diferencia PENDING, DELIVERED, SEEN, ACKNOWLEDGED, FAILED, ESCALATED e SUPERSEDED. | Inbox, banner e drawer precisam mostrar acknowledgement e lineage, sem prometer comunicação clínica por SSE. |
| F-14 | Alta | Os números de qualidade em docs são divergentes. | Há registros 619/619 e 614/614 em documentos diferentes, conforme [TEST_PLAN.md](testing/TEST_PLAN.md#L13) e [PRODUCTION_READINESS.md](operations/PRODUCTION_READINESS.md#L12). | O packet visual deve sempre fixar commit, escopo, timestamp e comando; não usar números soltos no hero. |
| F-15 | Alta | Existem controles abaixo de 44px e popovers/tabs com semântica incompleta. | A leitura do source encontrou workflow buttons de 32px, context button de aproximadamente 26×30px, toggle de aproximadamente 31×18px, popover sem foco/Escape completo e tabs sem painel/roving tabindex. | A base atual não fecha WCAG 2.2 AA manualmente; os primitives precisam ser centralizados antes do polish. |
| F-16 | Alta | O checkpoint tablet de 834px não coincide com a mudança principal em 820px. | [globals.css](../src/app/globals.css#L724-L826) e a crítica UX independente apontam grid/rail que mudam abruptamente; há risco de overflow em tabelas e laboratório. | 834px precisa ser uma composição de primeira classe, não apenas um desktop comprimido. |
| F-17 | Alta | Alguns caminhos mostram códigos crus ou preservam números após falha de refresh. | A crítica UX encontrou enums/códigos crus em management, indicadores, request detail e histórico; notifications/management/result possuem autoridade de stale/erro desigual. | A UI pode parecer operacionalmente certa enquanto comunica linguagem ou frescor errado. |
| F-18 | Média | A busca anuncia “⌘ K” sem implementar o contrato completo de command/search. | A leitura do source identificou debounce de input, mas não handler equivalente, combobox/listbox ou anúncio de resultados. | Atalho e affordance precisam deixar de prometer uma interação inexistente. |

### 4.3 Leitura visual da evidência histórica — STALE

Os renders em [.orchestrate/evidence/visual-patient-workspace-20260906-v8](../.orchestrate/evidence/visual-patient-workspace-20260906-v8) mostram:

- canvas claro e calmo, com sidebar azul-petróleo, cards brancos e acento teal;
- boa separação entre contexto do paciente, ações e timeline;
- densidade operacional razoável em desktop;
- tablet funcional, porém com forte dependência do rail reduzido;
- mobile legível, mas com rail persistente ocupando largura e uma timeline muito longa;
- identidade e hierarquia reconhecíveis, porém repetição de painéis arredondados e uso de Georgia/Inter pouco distintivos;
- uma aparência de produto “bem feito” que ainda não comunica materialidade diagnóstica proprietária.

O critic report histórico de v8 foi REJECT e registrou problemas de deadlines, stale/degraded, parcialidade, targets menores que 44px e conflito de cópia. Como a captura é anterior ao source corrente, esses itens são tratados como **sinais de regressão a retestar**, não como afirmações sobre a tela atual.

## 5. Verdade de produto que o redesign deve preservar

### 5.1 Contexto e segurança

Cada superfície operacional deve tornar visível, na primeira leitura:

- paciente permitido, espécie e identificadores seguros;
- encounter/admission ou contexto de atendimento;
- serviço/exame e item específico;
- prioridade textual e icônica;
- estágio operacional real;
- idade/frescor e SLA apenas quando policy estiver aprovada;
- responsável/ownership apenas quando vier do snapshot autorizado;
- próxima ação derivada, com CTA compatível com a permissão vigente.

O cabeçalho do paciente deve funcionar como um **context lock**: não deve ser um hero decorativo substituível por uma fotografia ou uma ilustração. Em telas estreitas, ele pode colapsar, mas não pode desaparecer quando o usuário está prestes a liberar, revisar, cancelar ou reconhecer algo.

### 5.2 Semântica de resultados

O sistema visual deve distinguir de maneira persistente:

| Semântica | Visual recomendado |
|---|---|
| Draft | estado privado, autor, versão, autosave/conflito; sem aparência de resultado final |
| Resultado liberado | versão corrente, autor, timestamp de release, linhagem |
| Visualizado | evento de leitura, sem alterar review |
| Revisado | ação separada, com ator e timestamp |
| Crítico acknowledged | acknowledgement explícito por versão; nunca inferido de abertura |
| Emenda | nova versão, aviso de revisão necessária, versão anterior preservada |
| Void | invalidade inequívoca e motivo; nunca verde/sucesso |
| Anexo em quarentena | indisponível até scan/checksum/authorization; não renderizar preview clínico |

### 5.3 Estado e frescor

O padrão visual recomendado é:

1. **Snapshot atual**: dados confirmados e horário de atualização.
2. **Leitura parcial**: snapshot preservado, campos indisponíveis nomeados, sem zeros fabricados.
3. **Snapshot anterior preservado**: banner de stale/degraded, último refresh e ação segura para atualizar.
4. **Estado desconhecido**: comando não confirmado; impedir repetição cega e oferecer recuperação segura.

Esse padrão deve ser o mesmo no Command Center, Queue, Drawer, Patient Workspace, Result View e Inbox. Uma tela vazia durante uma queda de realtime comunica ausência de dados quando o que existe é ausência de atualização; isso é um erro de produto.

## 6. Direção criativa: Instrumento clínico vivo

### 6.1 Ideia central

O hub deve lembrar uma **mesa de instrumentação clínica**: uma superfície clara onde sinais, lineage, amostras, versões e decisões podem ser lidos em sequência. A sensação premium vem de precisão, ritmo e controle; a sensação viva vem de mudanças observáveis e explicáveis.

Três camadas de atenção:

1. **Agora** — itens que exigem ação, novos resultados, críticos, recoletas e atrasos;
2. **Contexto** — paciente, encounter, serviço, versão, ownership e timeline;
3. **Instrumentação** — frescor, fonte, política, anexo, auditoria e recuperação.

### 6.2 Território a evitar

- gradientes neon ou glassmorphism como linguagem primária;
- dashboard cheio de mini KPI antes da fila de atenção;
- blobs, partículas, parallax e 3D sem significado operacional;
- badges coloridos que não dizem qual é a ação;
- cards idênticos em série formando uma “grade de caixas”;
- tipografia futurista de baixa legibilidade;
- motion contínuo em dados clínicos;
- textura de ruído aplicada em cima de texto;
- ícones Unicode ou glyphs de fonte como substitutos de um icon system;
- imagens de pacientes, laboratório ou equipamentos como decoração em superfícies que precisam de foco;
- texto clínico rasterizado em imagem ou arte que não seja traduzível, redimensionável e auditável.

### 6.3 Como surpreender

A assinatura visual deve aparecer em detalhes de sistema:

- uma linha de frescor que mostra o momento da última confirmação;
- uma timeline que usa conectores e marcas de evento para explicar lineage;
- um rail cuja textura lembra grade de instrumento, mas que não compete com o conteúdo;
- um drawer que entra como uma folha de contexto, preservando a fila sob ele;
- botões com uma borda/indicação de ação e um ícone de direção consistente, em vez de uma pílula genérica;
- mudança de estado que ilumina o item uma vez, depois se aquieta;
- números operacionais com ritmo tabular e alinhamento de instrumentação;
- status escrito em linguagem humana: “Aguardando laudo”, “Recoleta necessária”, “Atualização não confirmada”.

## 7. Sistema visual proposto

### 7.1 Arquitetura de tokens

Os valores abaixo são **PROPOSED**: ponto de partida para protótipo e teste de contraste, não contrato final.

| Token semântico | Valor inicial | Uso |
|---|---|---|
| color.canvas | #F3F5F2 | fundo global mineral |
| color.surface | #FFFEFC | superfície de leitura |
| color.surface-raised | #FFFFFF | drawer, modal e superfície elevada |
| color.ink | #17262D | texto principal |
| color.ink-muted | #5C6B73 | metadata e apoio |
| color.ink-faint | #829097 | texto secundário com uso restrito |
| color.rail | #123E4F | navegação e contexto |
| color.rail-deep | #0C2F3D | hover/active/contraste do rail |
| color.action | #087269 | ação primária |
| color.action-strong | #065E58 | hover/pressed |
| color.critical | #B94738 | criticidade e falha, com texto |
| color.critical-surface | #FFF0ED | fundo de alerta |
| color.watch | #986015 | atenção/overdue policy-gated |
| color.watch-surface | #FFF7E8 | fundo de atenção |
| color.info | #2C628A | contexto informativo |
| color.success | #286A55 | confirmação não crítica |
| color.border | #D8E0DE | separação neutra |
| color.border-strong | #B9C8C4 | foco estrutural |
| shadow-focus | 0 0 0 3px rgba(8,114,105,.24) | foco visível |
| radius-control | 10px | botão, input, select |
| radius-panel | 16px | painel de trabalho |
| radius-overlay | 20px | drawer/modal |

Regras:

- todo estado semântico combina cor + texto + ícone ou estrutura;
- critical, stale, denied e unknown têm texto explícito;
- cor de ação não deve ser usada para representar status clínico;
- nenhum valor de overdue, normalidade ou criticidade é calculado no browser;
- contrastes precisam ser medidos após tipografia e estados finais, não apenas pelos hexadecimais;
- tokens de componente nunca devem apontar diretamente para uma cor raw quando a intenção é semântica.

### 7.2 Tipografia

**PROPOSED:** adotar uma família sans-serif local variável com suporte completo a português, pesos 400–700 e numerais tabulares; usar uma mono local apenas em accession, protocolo, timestamp e identificadores técnicos.

Direção preferencial para avaliação:

- UI e leitura: IBM Plex Sans ou família equivalente aprovada por licença;
- instrumentação: IBM Plex Mono ou equivalente;
- serif/editorial: opcional, limitado a uma frase de identidade da Visão geral; nunca em CTA, status, tabela ou campo clínico.

Regras tipográficas:

- carregar fontes via next/font/local após os arquivos e licenças serem decididos;
- evitar depender de Inter/Georgia de sistema como baseline;
- body principal de 14–16px com line-height confortável;
- metadata compacta de 12–13px apenas quando não carregar ação essencial;
- heading de tela entre 28–36px no desktop e 24–28px no mobile;
- numerais tabulares para idade, SLA, contagens e timestamps;
- status e ação usam sentence case em português, sem caps-lock ornamental;
- permitir que textos longos quebrem; não truncar identidade ou estado crítico sem expansão acessível.

### 7.3 Superfícies e profundidade

O produto deve operar com três planos, no máximo:

1. **Canvas:** espaço de navegação e respiro;
2. **Workbench:** superfície onde filas, identidade e resultado são lidos;
3. **Focus layer:** drawer/modal/confirmation que toma foco e preserva o contexto atrás.

Não usar sombra para cada card. Preferir:

- bordas suaves para separar grupos;
- mudança de plano para contexto importante;
- uma única sombra baixa para focus layer;
- uma borda semântica controlada para critical/stale/unknown;
- raio maior em workbench, raio menor em controls;
- espaço negativo como elemento de hierarquia.

### 7.4 Texturas e materialidade

Textura é **PROPOSED** e deve ser code-native primeiro, usando CSS/SVG leve e revisável. Não há necessidade de gerar bitmap para a primeira versão.

Aplicações aprovadas:

- **Rail micro-grid:** linhas finas ou pontos em 2–3% de opacidade, apenas no fundo do rail;
- **Patient context field:** contorno/waveform muito discreto atrás do header de contexto, nunca atrás do nome/status;
- **Timeline trace:** uma linha e nós com pequena variação de textura para indicar evento, versão e lineage.

Guardrails:

- opacidade inicial de 2–4%, com teste em low-vision;
- textura não pode reduzir contraste nem simular informação;
- nunca aplicar ruído sobre texto, formulário, tabela ou status crítico;
- nenhuma animação contínua de textura;
- em reduced motion, manter textura estática;
- se um padrão parecer um valor ou um gráfico, removê-lo;
- texturas não substituem labels, legends ou estado.

### 7.5 Iconografia

O shell atual usa glyphs de texto como ⌂, ▤, ⌁, ! e outros. Isso deve ser substituído por um icon system consistente, com SVG/React icons locais, nomes acessíveis e viewBox estável.

Requisitos:

- um ícone por significado, não um ícone por rota arbitrária;
- stroke e optical size consistentes;
- icon-only só para ações familiares e com accessible name;
- tooltip não é substituto de label em ação crítica;
- prioridade, critical, stale, erro e próximo passo sempre possuem texto;
- os mesmos ícones devem funcionar em table row, card, drawer e timeline.

## 8. Componentes e estados

### 8.1 Fundação compartilhada

Expandir progressivamente [packages/ui/src/index.tsx](../packages/ui/src/index.tsx), sem reescrever tudo de uma vez:

- AppShell e NavigationRail/BottomNav;
- ActionButton, IconButton e SplitAction;
- Field, Select, SearchField e FilterChip;
- DiagnosticStatus;
- PriorityBadge;
- SlaIndicator;
- DataFreshness;
- PatientIdentity;
- AttentionRow;
- QueueTable e QueueCard;
- ContextDrawer;
- Timeline/AuditSpine;
- ResultVersionBanner;
- NotificationRow;
- FeedbackBanner;
- EmptyState, ErrorState, DeniedState, PartialState, StaleState;
- Skeleton com geometria estável;
- ConfirmationDialog e UnknownOutcomeDialog.

Os componentes devem expor contratos de estado, não apenas classes visuais. Uma fila, um drawer e o Command Center não devem ter três versões independentes de “stale”.

### 8.2 ActionButton customizado

Direção visual:

- forma retangular com raio de 10px, não pill;
- altura mínima de 44px em ação primária e critical;
- ícone de direção ou ação à esquerda/direita de forma consistente;
- borda ativa sutil que funciona como “instrument edge”;
- primary com teal profundo; quiet com superfície transparente e borda;
- danger/critical com surface claro e borda coral antes de preencher toda a área;
- pressed com redução de elevação, não com salto;
- pending com label contextual, spinner discreto e ação bloqueada;
- success/confirmed só após resposta do servidor;
- unknown mostra “Verificar estado” ou equivalente, nunca “Concluído”.

Estados obrigatórios:

| Estado | Mensagem/affordance |
|---|---|
| idle | ação clara, ícone e foco |
| hover | contraste e microelevação, sem deslocar layout |
| focus-visible | ring de alto contraste |
| pressed | feedback de pressão |
| pending | progresso e prevenção de duplo comando |
| confirmed | confirmação server-side e timestamp quando relevante |
| failed | erro seguro, motivo acionável e retry adequado |
| unknown | comando não confirmado; refresh seguro, sem retry cego |
| disabled | motivo explicável, sem parecer permissão silenciosamente quebrada |
| denied | ação não oferecida ou feedback seguro sem revelar recurso |

### 8.3 Componentes de atenção

O padrão de attention-first deve ser um row ou cluster de decisão, não uma coleção de números:

1. identidade/contexto;
2. status e idade;
3. motivo da atenção;
4. próxima ação;
5. responsável/escopo;
6. link para o contexto completo.

O CTA principal deve dizer o que acontece: “Abrir contexto”, “Receber amostra”, “Solicitar recoleta”, “Revisar resultado”, “Confirmar recebimento”. Evitar “Ver” quando a ação tem consequência diferente de apenas abrir.

### 8.4 Timeline como Audit Spine

A timeline deve explicar:

- qual objeto mudou;
- qual versão estava vigente;
- quem/qual serviço executou;
- horário e timezone;
- se o evento foi confirmado ou apenas sinalizado;
- vínculo com amostra, resultado, anexo, review ou notification.

Não usar a timeline como uma lista ornamental de pontos. Em mobile, oferecer agrupamento por dia e expansão por evento, mantendo a linhagem visível.

## 9. Arquitetura de navegação e layout

### 9.1 Shell

**Desktop 1280–1440px**

- rail de 232–248px, com label, ícone e role/contexto;
- topbar curta para busca, notificações, sessão e frescor;
- canvas com grid de 12 colunas;
- conteúdo principal limitado por legibilidade, não esticado até a borda;
- drawer de contexto entre 400–480px, preservando fila atrás;
- atenção e próxima ação na primeira dobra.

**Tablet 768–834px**

- rail compacto de 80–92px somente se seus labels acessíveis continuarem disponíveis;
- labels visuais podem colapsar, mas tooltip/accessible name não podem desaparecer;
- conteúdo em uma coluna principal + drawer/side sheet;
- filtros agrupados em uma barra de overflow controlado;
- evitar tabela desktop comprimida.

**Mobile 375–390px**

- remover rail persistente como padrão;
- usar topbar curta + bottom navigation com 3–5 destinos prioritários ou menu sheet;
- manter contexto do paciente em header compacto sticky;
- transformar row de fila em card com a mesma ordem semântica;
- usar action tray sticky apenas para a ação da tela, nunca para todas as ações;
- timeline agrupada e expansível;
- sem scroll horizontal na ação principal;
- nunca renderizar simultaneamente uma árvore desktop e outra mobile com o mesmo conteúdo.

### 9.2 Navegação a resolver antes do lock visual

A documentação da IA e a especificação de gestão não estão totalmente alinhadas. Antes de congelar o shell:

- fechar o conjunto canônico de entradas principais;
- definir diferença entre Visão geral, Central de Exames, Meus Pacientes, Laboratório, Imagem e Indicadores;
- decidir se Centro de gestão é uma seção ou uma superfície separada;
- validar role, departamento, escopo e ownership;
- não criar rotas extras só porque uma tela aparece em um nome de documento;
- manter Administration/technical control separado de ação clínica.

Essa é uma **OPEN QUESTION**, não um detalhe de CSS.

## 10. Direção por rota

| Superfície | Art direction | Ordem de leitura | Movimento/estado principal |
|---|---|---|---|
| / — Visão geral | cockpit calmo de atenção, com textura de instrumentação apenas no shell | Agora → por que importa → próxima ação → contexto | entrada de attention rows; atualização destaca uma vez e aquieta |
| /queues | bancada operacional densa, sem excesso de cards | filtros → fila → drawer contextual | drawer preserva posição e foco; atualização não reordena sem aviso |
| /patients | diretório de pacientes com identity lock | nome/espécie/contexto → pendência → ação | busca e filtros sem salto; vazio instrutivo |
| /patients/[id]/diagnostics | Patient Workspace como superfície de contexto | identidade → requests/items → atenção → resultado → timeline | expandir item revela contexto; stale mantém snapshot |
| /requests/[id] | lineage da solicitação | request → itens → amostra/procedimento → ações | item parcial aparece como independente |
| /results/[id] | leitura de resultado/versioning | versão atual → interpretação disponível → anexos → review | nova versão entra como evento, não substitui silenciosamente |
| /notifications | inbox operacional com critical persistente | ação necessária → novas → todas | acknowledge mostra versão/ator/timestamp |
| /indicators | painel de intervenção, não BI ornamental | definição → atraso/recoleta/crítico → ação | filtros preservam denominador e timezone |
| /management | command center com escopo explícito | backlog/attention → ownership → gestão | estados stale/partial têm banner, não zero |
| /admin | controle técnico separado da clínica | catálogo → roles → políticas → auditoria | confirmação forte e versão; sem visual de “ação rápida” |
| /account | identidade, escopo e sessão | quem sou → onde posso agir → sessão | troca de role/contexto invalida e comunica |
| /login | entrada segura e humana | identidade → recuperação → erro | sem efeitos decorativos; foco imediato |

### Prioridade de implementação

1. Shell + sistema de estados + ActionButton;
2. Visão geral + Queue + Drawer;
3. Patient Workspace;
4. Result View + review + attachments;
5. Notifications + critical acknowledgement;
6. Patients, indicators, management e admin;
7. polish, texturas, motion, performance e cobertura de extremos.

## 11. Motion system

### 11.1 Princípios

- movimento explica uma mudança, não chama atenção para si;
- feedback crítico também existe em texto e estrutura estática;
- usar opacity e transform sempre que possível;
- evitar animar width/height/top/left em listas densas;
- não alterar layout silenciosamente durante a leitura;
- permitir interrupção e reversão;
- respeitar prefers-reduced-motion;
- nenhum loop contínuo exceto um indicador vivo mínimo, que também precisa de estado textual;
- motion deve preservar foco, ordem de leitura e posição do usuário.

### 11.2 Tokens de motion

| Token | Duração | Uso |
|---|---:|---|
| motion.micro | 100–120ms | hover, pressed, focus, icon |
| motion.base | 160–220ms | button, banner, chip, filter |
| motion.overlay | 240–320ms | drawer, modal, menu sheet |
| motion.route | 280–420ms | troca de superfície ou view transition |
| motion.attention | 500–700ms, uma vez | highlight de dado recém-confirmado |
| easing.in | cubic-bezier(.4,0,1,1) | saída |
| easing.out | cubic-bezier(0,0,.2,1) | entrada |
| easing.standard | cubic-bezier(.2,.8,.2,1) | interação normal |

### 11.3 Choreografia por interação

- **Shell:** indicador ativo desliza poucos pixels; o conteúdo não “voa” entre rotas.
- **Queue → Drawer:** scrim 160ms, drawer 240ms; focus vai para o heading; Escape fecha e restaura origem.
- **Live update:** marca de freshness muda de forma suave; row recebe um highlight de uma vez; não pular a lista sem confirmação do usuário.
- **Stale/degraded:** banner entra sem deslocar o contexto de forma abrupta; a idade aparece imediatamente.
- **Result version:** a nova versão entra como uma faixa de lineage; não substituir silenciosamente a versão anterior.
- **Command pending:** CTA fica em estado de espera e a superfície preserva o contexto; não mostrar check verde antes do commit.
- **Critical:** usar persistência e contraste estrutural; não piscar vermelho.
- **Skeleton:** shimmer muito discreto apenas onde o tempo de espera justificar; reduced motion vira pulso estático ou nenhum movimento.

### 11.4 React/Next guardrail

React 19.2 e Next 16 expõem mecanismos modernos de view transition, mas a adoção deve ser incremental e testada em browsers-alvo. O primeiro ciclo deve funcionar sem depender de view transition: se o browser não suportar, a hierarquia, foco e estados permanecem corretos.

## 12. Responsividade e conteúdo extremo

| Viewport de aceitação | Estrutura | O que não pode acontecer |
|---:|---|---|
| 375–390px | topbar + bottom nav/menu sheet; cards; action tray; contexto sticky | rail dominar a tela, overflow horizontal, CTA invisível, timeline ilegível |
| 768–834px | rail compacto ou menu contextual; coluna principal + drawer | desktop table espremida, labels sem nome acessível |
| 1024–1280px | duas áreas quando necessário; filtros mantêm leitura | painel e drawer competirem por 50/50 sem contexto |
| 1440px | 12 colunas; fila + contexto; attention-first | métricas decorativas precederem urgência |
| 200% zoom | reflow sem perda de ação | foco cortado, texto truncado, ação somente por hover |

Testar explicitamente:

- nome de paciente muito longo;
- homônimos;
- tutor/identificador permitido extenso;
- serviço com label longa;
- vários itens de uma request;
- timeline com dezenas de eventos;
- versão amended/void;
- notificação critical com copy de fallback;
- status stale/degraded;
- tabela sem linhas;
- números grandes e timezone;
- idioma português com diacríticos;
- viewport 320px apenas como fallback, sem transformar a experiência principal em desktop miniaturizado.

## 13. Acessibilidade como bar de comportamento

O redesign deve manter WCAG 2.2 AA como base e acrescentar validação manual. Os 6/6 automatizados documentados são evidência local útil, mas não provam leitor de tela, touch, zoom ou aceitação humana.

Checklist obrigatório:

- landmarks semânticos: header, nav, main, aside, footer quando aplicável;
- um h1 de tela e hierarquia lógica;
- tabela semântica no desktop e cards com equivalência de informação no mobile;
- foco visível de alto contraste em todo controle;
- ordem de foco igual à ordem visual e de decisão;
- foco entra no dialog/drawer e retorna ao trigger;
- Escape fecha superfícies temporárias sem perder contexto;
- live region apenas para mudanças que merecem anúncio; não anunciar a fila inteira;
- critical, overdue, stale e error com texto e iconografia, não apenas cor;
- targets de toque de pelo menos 44 × 44px nas ações;
- zoom de 200% e reflow;
- textos longos quebram sem destruir identidade/status;
- reduced motion não remove feedback essencial;
- contrastes de foco, disabled, placeholder, borders e estado ativo medidos;
- accessible name não depende de glyph Unicode;
- mensagens de erro explicam recuperação sem vazar recurso negado;
- deep links e refresh preservam contexto sem assumir autorização;
- nenhuma ação clínica importante é disponível apenas em hover.

## 14. Next.js 16 e viabilidade de implementação

As recomendações respeitam a estrutura App Router da versão instalada e a instrução do repositório:

- páginas, layouts, loading e error devem continuar nas convenções de app;
- manter o máximo possível no Server Component; Client Components somente onde há interação, realtime, focus, motion ou estado local;
- usar next/font/local para a tipografia aprovada;
- manter a superfície de CSS global concentrada em reset, tokens, primitives e media foundations;
- mover estilos de feature para módulos/arquivos de feature, reduzindo o risco do stylesheet global monolítico;
- introduzir componentes compartilhados em packages/ui sem quebrar contratos de teste de cada feature;
- não adicionar biblioteca grande de animação antes de provar necessidade;
- preferir CSS transitions e Web Animations simples; view transitions como enhancement;
- não usar imagem ou textura raster se CSS/SVG code-native resolve;
- se ativos forem adicionados, estabelecer licença, alt/role, tamanho, cache e comportamento de reduced motion;
- não derivar estado de negócio no client para “embelezar” o dado;
- realtime continua sendo invalidação; refresh e read model seguem a fonte autorizada;
- cada ação sensível mantém pending/confirmed/failed/unknown;
- loading/error do App Router deve preservar a geometria da superfície.

### Estratégia de CSS

1. consolidar tokens semânticos;
2. criar primitives e estados;
3. manter aliases temporários para classes atuais;
4. migrar uma superfície por vez;
5. remover raw values apenas após a superfície ter captura visual e testes;
6. não fazer big-bang rewrite do globals.css.

## 15. Plano de execução incremental

### Fase 0 — fechar contratos e baseline

**Objetivo:** não polir uma decisão aberta.

- resolver nav canônica, role, ownership, critical policy, SLA e copy de estados;
- fixar commit e packet visual atual;
- recapturar 375/834/1440 com fonte atual, source hash e console/network;
- escolher browsers, devices, assistive tech e dados sintéticos representativos.

**Aceite:** não existe divergência de navegação ou número de evidência no packet do redesign.

### Fase 1 — fundação visual

- tokens semânticos;
- fonte local aprovada;
- icon system;
- ActionButton, status, freshness, feedback, skeleton, dialog/drawer;
- focus, reduced motion, contrast baseline.

**Aceite:** story/fixture de cada componente em todos os estados; keyboard e screenshot em 375/834/1440.

### Fase 2 — shell e atenção

- AppShell;
- NavigationRail/BottomNav;
- Visão geral;
- Queue e ContextDrawer;
- Command Center.

**Aceite:** atenção antes de decoração, mesma verdade entre lista/drawer/dashboard, nenhuma atualização reordena silenciosamente.

### Fase 3 — identidade e workspace

- PatientIdentity;
- Patient Workspace;
- requests/items;
- timeline/audit spine;
- estados parcial/stale/denied.

**Aceite:** homônimo, request multi-item, troca de contexto, campos indisponíveis e timeline densa validados.

### Fase 4 — resultado e comunicação

- result version banner;
- draft/release/amend/void;
- review/view/ack;
- attachments/quarantine;
- notifications/critical.

**Aceite:** versões não se sobrescrevem; acknowledgement por versão; nenhum sucesso sem confirmação.

### Fase 5 — management e admin

- indicators com definição/denominador/timezone;
- management;
- admin/catalog/policies/audit;
- account/session.

**Aceite:** as telas não inventam métrica, role, SLA ou política.

### Fase 6 — polimento controlado

- texturas aprovadas;
- motion system;
- visual regression;
- performance;
- content stress;
- manual accessibility;
- golden flows com stakeholders.

**Aceite:** todos os gates da seção 16 passados com packet fresco.

## 16. Quality bar frontend e Gauntlet

A barra congelada para este relatório foi:

| ID | Critério | Classificação | Situação na auditoria |
|---|---|---|---|
| FB-01 | hierarquia preserva verdade clínica e próxima ação | required / high | OBSERVED na documentação; PROPOSED no redesign |
| FB-02 | sistema visual tem identidade, tokens, type, semantic color, texture e states | required / high | PARTIAL; base existe, sistema ainda não está completo |
| FB-03 | loading/empty/error/partial/stale/denied/offline/conflict/review aparecem | required / critical | OBSERVED nos contratos; NOT RUN como matriz visual corrente |
| FB-04 | responsividade 375/834/1440 sem squeeze/overflow | required / high | STALE nos renders; requer recaptura |
| FB-05 | WCAG AA + keyboard/focus/reader/touch/zoom/reduced motion | required / critical | automatizado local; manual NOT RUN |
| FB-06 | motion intencional, compositado, interrompível e reduced motion | required / high | base parcial; sistema novo NOT RUN |
| FB-07 | implementação viável em Next 16/App Router/React 19 | required / high | OBSERVED; proposta incremental compatível |
| FB-08 | evidência honesta, com hash, viewport, estado e limitações | required / critical | PASS neste relatório; baseline visual anterior marcado STALE |

### 16.1 Crítica independente atual

Dois críticos receberam briefs selados, sem acesso ao resultado do outro, sem execução de browser e sem autorização para alterar arquivos. Ambos inspecionaram source atual, documentação e o packet visual v9; ambos marcaram o packet como stale por divergência de hashes. O resultado é sobre a implementação atual, não sobre a direção proposta neste relatório.

#### I1-20260907-CVG-VISUAL-01 — REJECT

Maior lacuna: **FB-04 + FB-02**, alta severidade.

- em 375px, o rail fixo de aproximadamente 92px deixa cerca de 283px para o conteúdo;
- labels de navegação chegam a aproximadamente 8px e metadata a 9–10px no render histórico;
- isso é desktop comprimido, não uma composição mobile dedicada;
- o visual continua card-heavy, pill-heavy e genérico, com Inter/system, Georgia e iconografia Unicode;
- não há materialidade/texture/font asset atual comprovada;
- skeleton shimmer, timings espalhados e ausência de evidência de performance deixam FB-06 como FAIL;
- FB-03 e FB-05 permanecem BLOCKED por falta de matriz visual atual e validação manual.

Fontes inspecionadas pelo critic: [globals.css](../src/app/globals.css#L785-L904), render [mobile-ready.png](../.orchestrate/evidence/visual-patient-workspace-20260906-v9/mobile-ready.png), [patient-diagnostics.tsx](../src/components/patient-diagnostics.tsx), [manifest v9](../.orchestrate/evidence/visual-patient-workspace-20260906-v9/manifest.json).

#### I1-CLINICAL-UX-20260907-01 — REJECT

Maior lacuna: **FB-03 + FB-04 + FB-05**, crítica/alta.

- state authority é inconsistente: notifications preserva conteúdo após falha sem cue stale, management preserva métricas após refresh failure e result pode descartar o último resultado confirmado;
- management, indicators, request detail e histórico de result ainda expõem códigos/enums crus;
- a mudança de responsive ocorre em torno de 820px e não trata 834px como composição de referência;
- tabs não completam relação tab/tabpanel e navegação por teclado;
- toggle customizado tem risco de foco invisível/seleção programática incompleta;
- queue/laboratory/result mantêm riscos de overflow e tabela de largura mínima;
- a evidência de Axe é parcial e não inclui o conjunto de validações manuais de contraste, leitor de tela, touch, zoom/reflow e reduced motion.

Fontes inspecionadas pelo critic: [notifications-view.tsx](../src/components/notifications-view.tsx#L61-L92), [management-dashboard.tsx](../src/components/management-dashboard.tsx#L45-L80), [result-view.tsx](../src/components/result-view.tsx#L130-L340), [accessibility.spec.ts](../tests/e2e/accessibility.spec.ts#L9-L15).

#### Convergência dos críticos

| Ponto | Decisão |
|---|---|
| Mobile 375px | não aprovar; decidir bottom nav/menu sheet e recapturar |
| Tablet 834px | não aprovar sem breakpoint/composição explícitos |
| Estados | não aprovar até toda rota preserva snapshot, stale, erro, parcial e desconhecido com autoridade única |
| Acessibilidade | não aprovar com Axe parcial; exigir keyboard, focus, tab, toggle, reader, zoom, touch e reduced motion |
| Visual identity | não aprovar generic card/pill/Unicode; consolidar tokens, font e material |
| Evidência | v9 é histórica/stale; gerar packet match com source atual |

O veredito consolidado da auditoria é **REJECT para a implementação atual**. Não há aprovação AAA, production-ready ou clinical approval. A direção descrita neste documento permanece válida como proposta de execução, mas precisa ser reavaliada após as correções e um novo packet.

### Veredito Gauntlet

- **Round 0 — documentação/scout:** concluído, sem mutação intencional.
- **Round 1 — source/evidence:** concluído; source atual inspecionado e evidência visual histórica classificada como STALE.
- **Round 2 — critic visual independente:** REJECT; FB-02/FB-04 falham e FB-03/FB-05 ficam bloqueados por falta de evidência corrente.
- **Round 2 — critic UX independente:** REJECT; FB-03/FB-04/FB-05 falham por state authority, responsive composition e semântica interativa inconsistente.
- **Mutation sentinel:** detectou apenas artefatos gerados durante a janela; nenhum arquivo-fonte frontend do escopo foi alterado para produzir o relatório.
- **Aprovação:** não emitida para AAA, produção ou aceitação clínica; a implementação corrente está rejeitada.

Este relatório é, portanto, uma **direção frontend pronta para execução**, não uma declaração de que a implementação atual já passou no bar.

## 17. Packet de validação que deve acompanhar o próximo ciclo

Para cada rota crítica, gerar um ledger com:

- commit/source fingerprint;
- data e timezone;
- rota;
- role e escopo sintéticos;
- estado operacional;
- viewport e DPR;
- browser/OS;
- comando de captura;
- screenshot nativa e, quando necessário, vídeo curto;
- console/network;
- resultado de keyboard/focus;
- resultado de screen reader manual;
- touch real ou emulação documentada;
- reduced motion;
- zoom/reflow;
- contraste;
- LCP/CLS e tamanho de assets;
- limitações;
- critic independente;
- decisão PASS/CONDITIONAL/REJECT.

Matriz mínima:

| Rota | 375 | 834 | 1440 | Loading | Empty | Error | Partial | Stale | Denied | Conflict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Visão geral | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Queues | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Patient Workspace | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Request detail | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Result/review | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Notifications | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Indicators/management | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Admin/account/login | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

O símbolo ✓ nesta tabela é uma exigência de cobertura, não evidência já executada.

## 18. Perguntas que precisam de decisão humana

Estas perguntas alteram a UI e não devem ser resolvidas pelo designer sozinho:

- quem solicita, libera, amenda, revisa e confirma por serviço?
- qual a diferença definitiva entre revisado, confirmado e concluído?
- quem assume uma pendência após troca de turno, alta ou transferência?
- quais thresholds, destinatários, fallback, escalonamento e canais existem para crítico?
- quando começa o SLA, quais calendários, timezones e pausas valem?
- qual é o sistema mestre para identidade, accession e dados de paciente?
- como distinguir homônimos e quais identificadores podem aparecer na tela?
- qual é o papel de Viewer e o acesso permitido a anexos?
- qual navegação é canônica para cada role e departamento?
- quais são os browsers, dispositivos e tecnologias assistivas do aceite real?
- qual packet resolve a divergência 614/614 versus 619/619?
- quais métricas, denominadores e freshness estão aprovados para indicadores?

## 19. Checklist de aceite do redesign

### Produto e UX

- [ ] atenção e próxima ação aparecem antes de métricas decorativas;
- [ ] patient + encounter continuam inequívocos;
- [ ] request multi-item não esconde itens ativos;
- [ ] view/review/ack/completed permanecem distintos;
- [ ] stale/partial/degraded preservam contexto e não fabricam zeros;
- [ ] não há CTA cuja disponibilidade pareça autorização definitiva;
- [ ] mensagem de ação desconhecida evita retry cego;
- [ ] critical tem persistência, versão e acknowledgement explícito;
- [ ] anexo quarentenado não parece disponível.

### Visual

- [ ] tokens semânticos são a única fonte de cor de estado;
- [ ] typography está localmente carregada e cobre português;
- [ ] icon system substituiu glyphs Unicode;
- [ ] cards têm hierarquia e não são uma grade repetitiva;
- [ ] textura é discreta, code-native e semântica;
- [ ] motion tem intenção, duração e fallback;
- [ ] custom buttons possuem estados completos;
- [ ] composição mantém foco no trabalho em 1440, 834 e 375px.

### Acessibilidade e performance

- [ ] keyboard, focus restoration e dialog foram testados manualmente;
- [ ] screen reader percorre identidade, status e ação na ordem correta;
- [ ] touch targets críticos têm no mínimo 44 × 44px;
- [ ] 200% zoom/reflow não esconde ações;
- [ ] reduced motion remove deslocamentos e loops, mas preserva feedback;
- [ ] listas não reflowam de maneira instável durante refresh;
- [ ] LCP/CLS e tamanho de fonte/asset estão medidos em build representativo;
- [ ] console e network estão limpos nas capturas.

### Evidência

- [ ] packet tem commit e source fingerprint;
- [ ] cada render tem rota, role, estado, viewport e timestamp;
- [ ] evidência histórica não é apresentada como atual;
- [ ] critic independente revisou a mesma matriz;
- [ ] limitações e OPEN QUESTION estão visíveis;
- [ ] nenhum texto diz “AAA”, “production-ready” ou “clinical approved” sem gate correspondente.

## 20. Conclusão

O frontend atual possui uma fundação valiosa: contratos de produto claros, atenção operacional, componentes de fluxo real e uma linguagem cromática coerente. Ainda assim, os dois críticos independentes rejeitaram a implementação corrente para o bar AAA por causa de mobile comprimido, estado/stale inconsistente, gaps de semântica interativa, motion sem sistema e evidência visual stale.

O salto para um produto realmente moderno, fluido e surpreendente não exige uma troca indiscriminada de stack. Exige intenção visual própria, uma arquitetura de estados compartilhada, uma tipografia controlada, um shell responsivo de verdade, motion com função, texturas que expressem materialidade e um processo de evidência atual.

A recomendação é aprovar este documento como **briefing de execução frontend**, iniciar pela Fase 0 e bloquear a palavra “AAA” até existir uma baseline visual fresca, revisão crítica independente e validação manual de acessibilidade/responsividade. A melhor versão do CVG não deve parecer mais barulhenta; deve parecer mais inevitável: ao abrir uma tela, o usuário entende quem é o paciente, o que mudou, quem precisa agir e qual é a próxima ação segura.
