# Banheza Assist — integração com o Bling

Puxa **Ordens de Serviço**, **Clientes** e **Produtos/estoque** direto do
Bling pro Assist, com um botão. Cada empresa conecta a própria conta do
Bling (OAuth) — não precisa digitar chave nenhuma na tela.

⚠️ **O Client Secret NUNCA vai no chat comigo.** Ele entra só no painel
de Secrets do Supabase (passo 4). O Client ID pode ser compartilhado
(não é segredo), é ele que vai dentro do código do app.

---

## PASSO 1 — Banco de dados

SQL Editor do Supabase → cole **`supabase-bling.sql`** inteiro → Run.

Cria a tabela onde ficam os tokens de conexão (ninguém lê pela API, só
as funções que eu publico) e 4 colunas novas em `empresas` pra guardar
o status (conectado, última sincronização).

## PASSO 2 — Criar o aplicativo no Bling

1. Entre em **developer.bling.com.br** com a conta do Bling da Banheza.
2. **Meus Aplicativos → Novo aplicativo.**
3. Preencha:
   - **Nome:** Banheza Assist
   - **Redirect URI:** `https://cahfugahdvrdpymztyhz.supabase.co/functions/v1/bling-callback`
     (copie exatamente assim — precisa bater com o que a função espera)
   - **Escopos:** marque pelo menos leitura de **Ordens de Serviço**,
     **Contatos** e **Produtos/Estoque**.
4. Salve. O Bling mostra um **Client ID** e um **Client Secret**.
   - Me manda o **Client ID** aqui no chat (pode, não é segredo) que eu
     já deixo configurado no código.
   - O **Client Secret** você mesma cola direto no Supabase, no
     próximo passo — nunca aqui no chat.

## PASSO 3 — Publicar as duas funções

No Supabase → **Edge Functions** → **Deploy new function**:

1. **`bling-callback`** — cole o conteúdo de
   `supabase/functions/bling-callback/index.ts` → **desligue "Verify JWT"**
   (o Bling não manda login nosso quando chama essa função).
2. **`bling-sync`** — cole o conteúdo de
   `supabase/functions/bling-sync/index.ts` → deixe **"Verify JWT" ligado**
   (o padrão) — essa é chamada pelo próprio app, já logado.

## PASSO 4 — Secrets

**Edge Functions → Secrets → Add secret**, duas vezes:

- `BLING_CLIENT_ID` = o Client ID do passo 2
- `BLING_CLIENT_SECRET` = o Client Secret do passo 2 (só aqui, nunca no chat)

## PASSO 5 — Publicar o app

Assim que você me mandar o Client ID, eu troco no código
(`BLING_CLIENT_ID` no topo do `index.html`) e você roda:

```
cd "C:\Users\HP\Desktop\Empreendimento Banheza\app-manutencao-geradores"
git add -A
git commit -m "Bling: Client ID"
git push
```

## PASSO 6 — Conectar e testar

No app: **Configurações → Integração com o Bling → Conectar ao Bling**
→ faz login no Bling e autoriza → volta pro Assist já conectado →
clique **Sincronizar agora**.

---

## O que sincroniza (hoje)

| Do Bling | Vira no Assist |
|---|---|
| Ordens de Serviço | Ordens de Serviço (`OS-...`), ligadas ao cliente pelo nome |
| Contatos | Clientes (nome, CPF/CNPJ, telefone) |
| Produtos (tipo "Produto", ativos) | Peças & estoque (nome, código, saldo, custo) |

**Limitações da primeira versão:**
- O e-mail e o endereço do cliente não vêm na sincronização de contatos
  (a listagem do Bling não traz esses campos) — dá pra completar à mão
  no Assist, ou eu evoluo depois pra buscar o detalhe de cada contato.
- A sincronização é **por clique** ("Sincronizar agora"), não automática
  a cada minuto. Dá pra automatizar depois (ex.: 1x por hora) se você
  quiser.
- O status da OS no Bling (Em aberto, Em andamento, Concluída…) é
  traduzido pro status do Assist da forma mais parecida possível — vale
  a pena conferir se ficou do jeito que você espera depois do primeiro
  teste.

## Se der erro

- **"Sem permissão" ao conectar:** confira se o Redirect URI no Bling
  está **exatamente igual** ao do passo 2.
- **"Não foi possível sincronizar":** em Configurações, o próprio app
  mostra a última mensagem de erro. As causas mais comuns: Secret
  errado, ou a conexão expirou (peça pra reconectar).
- Token de acesso do Bling dura poucas horas, mas o app renova sozinho
  usando o refresh token (que dura 30 dias) — só precisa reconectar se
  passar 30 dias sem sincronizar nenhuma vez.
