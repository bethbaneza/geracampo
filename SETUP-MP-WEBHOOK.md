# Etapa 2 — Liberação automática do plano Pro (Mercado Pago)

Quando o cliente paga a assinatura, o Mercado Pago avisa o Supabase, que
libera o plano Pro sozinho. Você não roda mais o comando SQL na mão.

Tudo é feito pelo **painel** (Supabase e Mercado Pago). Sem linha de comando.

---

## 1. SQL

Supabase → **SQL Editor** → New query → cole **`supabase-mp.sql`** → Run.
(Cria a função `mp_atualizar_assinatura`.)

## 2. Criar a Edge Function no Supabase

1. Supabase → menu lateral **Edge Functions** → **Deploy a new function** (ou "Create function").
2. Nome: **`mp-webhook`**
3. **Verify JWT**: **DESLIGADO** (o Mercado Pago não manda token de login).
4. No editor, apague o exemplo e cole **todo** o conteúdo de
   `supabase/functions/mp-webhook/index.ts` (na pasta do app).
5. **Deploy**.
6. Copie a URL que aparece — é assim:
   `https://cahfugahdvrdpymztyhz.supabase.co/functions/v1/mp-webhook`

## 3. Segredo (Access Token do Mercado Pago)

1. Mercado Pago → **Seu negócio → Configurações → Credenciais** (ou
   "Suas integrações" → sua aplicação → **Credenciais de produção**).
2. Copie o **Access Token** de **produção** (começa com `APP_USR-...`).
3. Supabase → **Edge Functions → Secrets** (ou **Project Settings → Edge Functions → Secrets**)
   → **Add secret**:
   - Nome: `MP_ACCESS_TOKEN`
   - Valor: cole o Access Token
   → Salvar. (Não precisa fazer deploy de novo.)

> `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já existem — não mexa neles.

## 4. Apontar o webhook no Mercado Pago

1. Mercado Pago → **Suas integrações** → sua aplicação → **Webhooks** (ou
   **Notificações**).
2. **URL de produção**: cole a URL da Edge Function (passo 2.6).
3. **Eventos** a marcar:
   - **Assinaturas / Planos de assinatura** (`subscription_preapproval`)
   - **Pagamento de assinatura autorizado** (`subscription_authorized_payment`)
   - (se aparecer só "Pagamentos", marque também)
4. Salvar.

## 5. Testar

- No próprio painel de Webhooks do Mercado Pago tem um botão
  **"Simular"** / **"Testar"** — dispara um evento de teste.
- Ou faça uma assinatura de verdade com um cartão de teste do Mercado Pago.
- Confira em: Supabase → SQL Editor:
  ```sql
  select nome, plano, assinatura_ate, mp_ref from empresas order by criado_em desc;
  ```
  A empresa do e-mail que pagou deve ficar `plano = pro` com
  `assinatura_ate` ~35 dias no futuro.
- Se der errado, veja o log em Supabase → **Edge Functions → mp-webhook → Logs**.

---

## Como funciona

- **Pagou** (mensal): `empresas.plano = 'pro'`, `assinatura_ate = hoje + 35 dias`.
  Todo mês que o Mercado Pago cobra, o webhook renova por mais 35 dias.
- **Cancelou / falhou o pagamento**: o webhook não renova. Quando
  `assinatura_ate` vence, o app volta sozinho para o plano free (jornada +
  manutenções liberadas, o resto travado).
- **E-mail do pagador diferente do e-mail de login**: o webhook não acha a
  empresa e não faz nada — aí você libera na mão pelo `SETUP-SAAS.md`.
  Peça para o cliente pagar com o mesmo e-mail que ele usa para entrar no app.

## Segurança

A função nunca confia no aviso do Mercado Pago: para cada evento ela
**consulta a API do Mercado Pago** com o seu Access Token para confirmar o
status real antes de liberar qualquer coisa.
