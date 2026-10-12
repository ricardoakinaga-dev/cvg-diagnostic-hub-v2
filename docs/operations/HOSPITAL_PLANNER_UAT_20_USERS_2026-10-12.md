# Homologação sintética com 20 usuários — 12/10/2026

Este registro apresenta o ensaio técnico executado. O solicitante escolheu esta VPS como ambiente de testes, confirmou um pico representativo de **20 usuários** e é responsável pela validação dos fluxos e pelo aceite. Não há aceite hospitalar, publicação ou autorização de entrada em produção registrada neste ensaio.

## Versão realmente executada

- Runtime: commit `9abb6b7e67d15a6793bc44d9ef3865effac4479e`.
- Fingerprint: `dd327ec62f513918e32d76018c71be93b200e2d31a755bf362c61a5bb73eb516`.
- Projeto isolado: `cvg-hpl-uat-9abb6-159a24d4b1`.
- URL de testes: `https://192.168.15.8:18444`.
- Dados, contas, armazenamento e segredos são próprios e sintéticos; credenciais não constam deste relatório.

A inicialização terminou com **27 verificações aprovadas**: serviços saudáveis, migrações e bootstrap nativos, backup lógico com inventário de restauração, acesso normal autorizado e negativas de escopo, além de guarda de primeiro acesso do SUPERADMIN. A prova registra identidade dos contêineres existentes preservada. Os limites de memória dos oito serviços persistentes somam **3.712 MiB**; isso é configuração, não consumo medido ou capacidade garantida.

Prova: `/home/rmakinaga/.local/share/cvg-hpl-uat-9abb6-159a24d4b1/proof.json`.
SHA-256: `c253352602d11c093f79e26aa3b098c4267fe49135599ac1778892a6d958042b`.

## Correção de segurança ainda distinta do runtime

O commit 9abb contém a corrida de reautenticação confirmada: duas chamadas concorrentes, após quatro erros, podem verificar duas senhas e atingir seis tentativas. A exploração exige sessão válida e CSRF; a classificação técnica registrada é MEDIUM.

A correção isolada passou **59 testes focados em memória e dois testes PostgreSQL reais**, com tipos e lint aprovados. Os cinco arquivos foram adotados no checkout e seus bytes foram conferidos contra os hashes testados. Isso não altera retroativamente as imagens 9abb em execução nem prova uma nova candidata completa.

A correção reserva atomicamente até cinco slots ocupados ou retidos por conta/janela, libera apenas o slot de confirmação correta na mesma geração e revoga no quinto erro confirmado. Slots liberados podem ser reutilizados; não é um limite de cinco verificações totais. Login, CSRF e validações de sessão permanecem separados.

Prova: `/tmp/cvg-hpl-reauth-atomic-budget-proof-20261012/final-reauth-atomic-budget-proof.json`.
SHA-256: `0de62e68611e2e6e8558313b525562f19b56e6d330244e6a27452a96a384a1b5`.
Pendência: vincular a correção à futura candidata, imagens e validação integrada; não apresentá-la como já instalada neste runtime.

## Gateway e validação pelo navegador

O acesso HTTPS por endereço IP exigiu correção de SNI padrão no gateway privado. A inicialização atual registra **HTTP 200 com TLS verificado pela CA própria**. O checkout também recebeu `default_sni localhost` em `deploy/local/Caddyfile`; a prova de inicialização não substitui uma validação de navegador de todas as rotas.

**Navegador: PASS em duas jornadas reais, com 28 verificações e zero erros de página.** A conta comum realizou o primeiro acesso e a troca obrigatória de senha, visualizou os menus operacionais, criou uma ultrassonografia, encontrou a linha na lista e manteve o registro após recarga. A tentativa duplicada retornou 409, exibiu o aviso e não acrescentou outro registro. O SUPERADMIN mostrou os menus operacionais e administrativos juntos; Acessos e Catálogos exibiram títulos, seções e formulários distintos.

Prova: `/tmp/cvg-hpl-uat-browser-execution-9abb6b7e-j_rrb4vk/browser-proof.json`.
SHA-256: `8df7723d7d9611e2aec1d217fe277f7c8ac6ca308eaffb898a8b15cbe06812c2`.
O container de navegador próprio foi removido; containers e redes anteriores ficaram iguais, sem OOM. O navegador usou a rede do host para alcançar o IP privado, sem mudar firewall ou confiança global de certificados; manteve 512 MiB, uma CPU, filesystem somente leitura e diretório temporário limitado.

As duas falhas anteriores foram preservadas: timeout de transporte antes de qualquer fluxo e encerramento do Chrome antes das jornadas por falta de HOME/XDG gravável para o Crashpad. A execução aprovada corrigiu esses problemas do executor, mantendo as mesmas asserções do programa.

As credenciais ficam em `access.json`, modo 0600, no diretório privado do UAT. A conta normal recebeu nova senha temporária nativa e deve trocá-la no próximo acesso; a conta SUPERADMIN mantém a senha própria atual definida durante a jornada e pode alterá-la em Minha conta. Nenhuma senha foi incluída na documentação ou no Git.

## Ensaio HTTP com 20 usuários distintos

**PASS no escopo limitado:** vinte contas normais distintas foram provisionadas pela API nativa, autenticadas e submetidas ao fluxo inicial de senha. A fase medida manteve vinte sessões ativas e liberou uma barreira de vinte jornadas, com até vinte requisições simultâneas.

Cada conta realizou **três leituras e uma escrita**. O conjunto medido contém **80 tentativas: 60 GET e 20 POST**, sem retries, erros ou descarte de amostras. Provisionamento, autenticação, negativas de autorização e encerramento das sessões ficam fora dessa fase; o executor registrou 211 requisições no total.

| Medida | Resultado | Limite aplicado |
| --- | ---: | ---: |
| p95 de leitura | 119,97769 ms | ≤ 500 ms |
| p95 de escrita | 228,06323 ms | ≤ 800 ms |
| Taxa de erro | 0% | ≤ 1% |

O percentil usa nearest rank, `ceil(0,95 × n)`, incluindo todas as tentativas medidas. Foram verificadas vinte tarefas PENDING distintas, versão 1, com vinte autores nativos distintos. A projeção diagnóstica ativa autorizada do paciente sintético permaneceu igual; isso não verifica toda a base ou arquivo clínico. As negativas de outro paciente e de administração técnica foram tratadas separadamente do orçamento de erros.

Prova V6: `/home/rmakinaga/.local/share/cvg-hpl-uat-9abb6-159a24d4b1/benchmark-20-users-30e1a83c081f/proof.json`.
SHA-256: `621e918ecdc5c2b48e4b9e184064430b2b7bde120f8ef5ef16ed3d490516753e`.

A execução anterior V5 permanece FAIL, com **zero requisições**, por recusa do volume PGDATA anônimo novo do backup na captura de recursos. A V6 aceitou somente o volume novo, criado após o início do UAT e montado exclusivamente pelo contêiner próprio de backup; os limites de desempenho foram mantidos.
Prova histórica: `benchmark-20-users-7a8a0e88d28a/proof.json`, no mesmo diretório UAT; SHA-256 `f0bea285e514e531d0c02eb0eef13287ad7749389f38e5bfc4dd8dc31c570e04`.

**Limite:** uma única onda sintética de 80 requisições, com apenas vinte amostras de escrita, não comprova capacidade sustentada, duração de plantão, crescimento de dados ou desempenho com prontuários e integrações reais. Contas e tarefas sintéticas foram preservadas para inspeção; as sessões foram encerradas.

## Antivírus real

**PASS dos três controles do adaptador ClamAV real**, engine `1.5.4`, assinatura `28151`: conteúdo inofensivo → CLEAN/200; arquivo padrão de teste EICAR → QUARANTINED/200; ausência de autorização do scanner → FAILED/401. TLS foi verificado e nenhum segredo foi registrado.

Prova: `/home/rmakinaga/.local/share/cvg-hpl-uat-9abb6-159a24d4b1/real-clamav-adapter-proof.json`.
SHA-256: `802dc97d73bba6e75289eea90a4503642d248537d01d25a0cc1dc5ab9b0f9f17`.
O resultado cobre o adaptador e seus controles; não comprova o pipeline completo de upload/finalização de anexos nem detecção universal de malware.

## Desempenho em volume maior e pendências externas

A CI 9abb `38240268593` terminou verde, mas o cenário sintético de **volume equivalente a 12 meses** excedeu quatro metas nominais propostas: catálogo 596,68 ms/500 ms; pedidos 560,39 ms/500 ms; dashboard 560,18 ms/500 ms; escrita 1.967,5 ms/800 ms. O gate da CI utilizou fator de teto 4. O teste não durou doze meses; o PASS da onda UAT menor não elimina essas quatro diferenças.
Prova: `/tmp/cvg-hpl-ci-9abb6b7e-38240268593-20261012-dcwqzqok/completed-evidence/perf-postgres-38240268593-1/perf-postgres-12m.json`; SHA-256 `32ad07291eadf6433c07464fb3a798bceadd4c2f1075da5e50e0befbaf28ed44`.

- Endpoint e fluxo hospitalar do HIS `cvg-his-v4`: homologação real pendente; instalação informada não comprova troca clínica validada.
- LIS/PACS: UNKNOWN; nenhuma adoção ou integração real confirmada.
- Duração, distribuição dos fluxos, crescimento, recuperação operacional e aceite nominal: pendentes de validação institucional.
- BLD-HPL-042 depende da homologação externa; BLD-HPL-051 permanece OPEN.
- Responsável pelo aceite: solicitante. O ensaio não autoriza mudanças em serviços existentes, publicação ou entrada em produção.
