# GeraCampo

App técnico de manutenção de geradores de cloro, operação de campo, veículos e estoque.
Camada técnica/operacional — a Ordem de Serviço oficial continua no **Bling**.

É um **único arquivo** (`index.html`), sem build e sem dependências. Abre direto no navegador.

## Rodar

- **Local:** abra `index.html` no navegador (ou rode `python -m http.server` na pasta).
- **GitHub Pages:** publique este repositório e ative *Settings → Pages → Branch: main /(root)*.
  A URL fica `https://<seu-usuario>.github.io/<repositorio>/`.

## Armazenamento

| Onde roda | Dados |
|---|---|
| Arquivo local / GitHub Pages / qualquer host estático | `localStorage` do navegador — **um dispositivo por vez**, sem login |
| Publicado como Artifact no claude.ai | Base compartilhada em tempo real entre quem abre o link (contas Claude da mesma organização); fotos ficam no aparelho de quem tira |

Para dados compartilhados entre pessoas diferentes fora do claude.ai é preciso um backend
(ex.: Firebase/Supabase) — não incluso.

## Base de teste

Já vem com registros fictícios (NS `TESTE-001/002/003`, clientes, veículos, OS).
*Configurações → Restaurar base de teste* recria tudo.
Perfis: Técnico / Supervisor / Administrador (seletor no topo).

## Estrutura funcional

Painel · Jornada · Ordens de Serviço · Manutenções · Clientes · Equipamentos/NS ·
Veículos + preventivas · Peças & estoque · Abastecimento · Indicadores · Relatórios ·
Fluxo macro · Configurações · Auditoria.
