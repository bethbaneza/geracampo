# Banheza Assist — modo comercial (SaaS)

Cada empresa cria a própria conta, configura identidade/logo e convida a
equipe pelo app. Teste grátis de 30 dias com tudo liberado; depois trava
no essencial (Jornada, Manutenções, Clientes, Equipamentos) até assinar o
plano Pro.

---

## PASSO 1 — Banco de dados

SQL Editor do Supabase → cole **`supabase-saas.sql`** inteiro → Run.
(É re-executável. Roda depois do `supabase-nivel2.sql`.)

O que ele faz:
- `empresas` ganha `plano` / `trial_ate` / `assinatura_ate`
- **promove a sua empresa atual para `pro`** (você não perde acesso)
- cria a tabela `convites`
- o cadastro passa a criar empresa nova (sem código) ou entrar na empresa
  do código de convite

## PASSO 2 — Confirmação de e-mail

Authentication → **Providers → Email** → decida:

- **Mais simples (recomendado para começar):** desligue **"Confirm email"**.
  Quem se cadastra entra na hora, sem receber e‑mail.
- **Com confirmação:** deixe ligado, mas configure um **SMTP** em
  Authentication → Emails (o Resend tem plano grátis). Sem SMTP, o e‑mail
  de confirmação não chega e a pessoa fica travada.

## PASSO 3 — Publicar o app

```
cd "C:\Users\HP\Desktop\Empreendimento Banheza\app-manutencao-geradores"
git push
```

O `index.html` já tem 3 campos comerciais no topo do `<script>` para você
preencher quando tiver:

```js
const PRECO_PRO="[SEU PREÇO]";                 // ex.: "149"
const LINK_ASSINATURA="[LINK MERCADO PAGO]";   // link da assinatura recorrente
const CONTATO_BANHEZA="[seu-email@banheza.com.br]";
```

Enquanto `LINK_ASSINATURA` não estiver preenchido, a tela "Assinar" mostra
"fale com a Banheza" em vez do botão de pagamento.

---

## Como funciona para o cliente

1. Abre `https://app.banheza.com.br/` → **Criar uma conta** →
   "Criar empresa" → e‑mail + senha.
2. Cai no **onboarding**: nome da empresa, logo, como chama o equipamento.
3. 30 dias de teste com tudo liberado.
4. **Configurações → Equipe → Convidar**: gera um código (`BZ-XXXXXX`) e um
   link. O técnico abre o link (ou usa "Tenho convite" no cadastro),
   informa e‑mail + senha + código, e entra já no nível definido.
5. Técnico **não** exclui OS nem equipamento/NS (continua valendo).

## Liberar o plano Pro na mão (enquanto o pagamento automático não existe)

SQL Editor → troque o e‑mail e rode:

```sql
update empresas set plano='pro',
       assinatura_ate = now() + interval '1 year'
 where id = (select p.empresa_id from perfis p
             join auth.users u on u.id = p.id
             where u.email = 'CLIENTE@EXEMPLO.COM' limit 1);
```

Ver todas as empresas e planos:

```sql
select e.nome, e.plano, e.trial_ate::date, e.assinatura_ate::date,
       (select count(*) from perfis p where p.empresa_id = e.id) usuarios
  from empresas e order by e.criado_em desc;
```

## ETAPA 2 (próxima) — pagamento automático (Mercado Pago)

- Você cria a conta e o **plano de assinatura** no Mercado Pago e me passa
  o link.
- Publico uma **Edge Function** (`supabase functions deploy`) que recebe o
  webhook "pagamento aprovado / assinatura cancelada" e atualiza
  `empresas.plano` + `assinatura_ate` sozinha.
