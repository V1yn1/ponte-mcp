# Identidade visual da Ponte — 0.9.0

[Índice da documentação](README.md) · [Histórico de versões](../CHANGELOG.md)

A identidade introduzida na versão 0.5.0 e mantida na 0.9.0 usa uma ponte com dois pilares e um arco como símbolo da conexão entre assistentes e ferramentas. O painel aplica azul cobalto nos controles, grafite na navegação e fundos claros nas áreas de leitura. A cor verde deixou de ser a base da interface.

## Logotipo

O arquivo de produção é [ponte-mark.png](../public/assets/ponte-mark.png), com fundo transparente. Ele aparece no login, na navegação lateral, na visão geral e no consentimento OAuth. A palavra **Ponte** permanece como texto da interface, para conservar legibilidade e acessibilidade em tamanhos pequenos. A imagem é decorativa quando está junto desse nome.

Preserve a proporção e a transparência do PNG. Não incline o símbolo nem os cards que apresentam nomes de ferramentas. Use o espaço interno do componente para separar o símbolo do texto; o arquivo inclui uma margem transparente.

## Paleta e leitura

| Papel | Cor de referência |
|---|---|
| Ação principal | Azul cobalto `#3863F4` |
| Navegação e texto forte | Grafite `#171C2A` |
| Fundo principal | Branco suave `#F7F8FC` |
| Acento secundário do símbolo | Azul pervinca `#91A8FF` |

Os estados de atenção e erro usam cores próprias acompanhadas de texto e ícones. O arquivo [public/styles.css](../public/styles.css) define os valores efetivos dos componentes, incluindo contrastes de hover, foco e estados desativados; [public/consent.css](../public/consent.css) usa a mesma direção visual na autorização.

## Aplicação na versão atual

A seção **Acompanhamentos**, acrescentada na 0.6.0, segue os mesmos tokens de cor e componentes. O número de monitores ativos e o número de chamadas em espera são informações diferentes e têm rótulos próprios. Estados usam texto além da cor; resultados de executor são apresentados como conteúdo, sem se tornarem comandos da interface.

As prévias de cadastro e reconexão de MCPs, acrescentadas na 0.7.0, apresentam motivo, servidor e configuração revisável em **Execuções**, seguindo a mesma identidade.

Os cards **Chat** e **Ferramentas** permanecem alinhados, sem rotação. Para avaliar mudanças visuais, confira login, navegação, consentimento, estados vazios e acompanhamentos em desktop e celular. O registro em [Validação](VALIDACAO.md) distingue auditoria estática de inspeção visual efetivamente executada.

## Criação do arquivo

O símbolo foi criado com a ferramenta de geração de imagens integrada e copiado para o projeto sem remover seu canal alfa. Prompt de criação:

> Use case: logo-brand. Asset type: production application logo symbol for 'Ponte MCP', a developer tool connecting AI assistants to a user's computer. Create ONE exceptionally clean, distinctive geometric bridge emblem on a genuinely transparent background. No text. The bridge is a bold, compact continuous ribbon: two upright pillars connected by an elegant rounded arch and a strong horizontal lower deck, with generous clear negative space beneath the arch; it should also subtly suggest two linked code brackets. Flat vector-like design, perfectly level, symmetrical balance, crisp smooth edges, strong legibility at 32 pixels. Primary color electric cobalt #3863F4; a restrained secondary segment in pale periwinkle #91A8FF can suggest connection. Avoid green. No gradients, no shadows, no 3D, no mockup, no surrounding square or circle, no background or checkerboard baked into pixels, no lettering, no extra icons, no fine suspension cables. Center the single mark in a square canvas, filling about 84% of its width, with even transparent margins. This is the final logo asset to be integrated directly in the app.
