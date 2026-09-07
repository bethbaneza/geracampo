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

### Supabase (dados compartilhados em qualquer host)

Em *Configurações → Conexão com Supabase*, informe a URL do projeto e a chave
publishable/anon. SQL de criação (rode uma vez no SQL Editor):

```sql
create table geracampo_estado (
  col text primary key,
  items jsonb not null default '[]',
  updated_at timestamptz default now(),
  updated_by text
);
alter table geracampo_estado enable row level security;
create policy "acesso de teste" on geracampo_estado
  for all using (true) with check (true);
grant all on table geracampo_estado to anon, authenticated;
alter publication supabase_realtime add table geracampo_estado;
```

A chave publishable é pública (vai no navegador). A policy acima libera geral —
adequada só para testes fechados.

## Login e acesso

Tela de login por usuário/senha. Dois níveis:

- **Administrador** — acesso total (inclui excluir OS e equipamento/NS).
- **Usuário (técnico)** — cadastra, altera e exclui itens, **exceto** excluir
  Ordem de Serviço e equipamento/NS.

Primeiro acesso: `admin` / `admin` (troque em Configurações → Usuários).
Usuários, campos técnicos, campos de medição e a **identidade da empresa**
(nome, como chamar o "equipamento", rótulo de setor) são configuráveis —
o app serve qualquer segmento, não só geradores de cloro.

## Base de teste

Já vem com registros fictícios (NS `TESTE-001/002/003`, clientes, veículos, OS)
e usuários: `admin`/`admin`, `rafael`/`1234`, `diego`/`1234`, `marina`/`1234`.
*Configurações → Restaurar base de teste* recria tudo.

## Estrutura funcional

Painel · Jornada · Ordens de Serviço · Manutenções · Clientes · Equipamentos/NS ·
Veículos + preventivas · Peças & estoque · Abastecimento · Indicadores · Relatórios ·
Fluxo macro · Configurações · Auditoria.
