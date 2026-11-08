# Publicar uma entrada estável na Render

A Ponte local continua executando as ferramentas no seu computador. A Render
hospeda somente um relay de transporte, com endereço fixo e sem painel admin.

O novo módulo é **Ponte Cloud Relay 0.1.0**, complementar à Ponte MCP 0.10.0.
O código foi preparado em branch própria; isso não significa que o serviço
já esteja implantado ou que o PC tenha sido pareado.

## Roteiro

1. [Publique o Blueprint e confira o plano Free](../relay/README.md#publicar).
2. [Configure a origem e pareie o PC](../relay/README.md#conectar-o-pc-uma-vez).
3. Faça OAuth pelo novo endereço e uma chamada real de `bridge_status`.
4. Reinicie somente o agente; confirme que a mesma conexão continua funcionando.
5. Desligue o agente: novas ferramentas devem falhar como indisponíveis, não
   executar em outro computador nem se repetir ao reconectar.
6. Confira um watcher pelo mesmo ID após interromper a comunicação.

A primeira troca de ngrok para Render muda o emissor OAuth e exige reconexão.
Depois disso, mantenha domínio, segredo e estado local. A validade normal dos
tokens e as permissões continuam sendo responsabilidade do núcleo da Ponte.

## Evidência desta preparação — 8 de novembro de 2026

A suíte complementar foi executada em Node 22.16.0/Linux, sem rede externa,
com sockets HTTP reais e uma API local controlada. Não alterou arquivos do
núcleo da Ponte, configuração do usuário, tokens ou serviços em produção.

O relatório em [relay/VALIDACAO.md](../relay/VALIDACAO.md) registra quantidade de
testes, limites e as etapas que ainda precisam de validação no ambiente real.

Instalação completa, segurança, limitações e rollback estão em
[relay/README.md](../relay/README.md).
