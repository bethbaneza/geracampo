// Banheza Assist — callback do OAuth2 do Bling.
// O Bling redireciona o navegador pra cá depois que o admin autoriza o
// aplicativo, trazendo ?code=...&state=<empresa_id>. Aqui a gente troca
// o code por um access_token + refresh_token e guarda em bling_conexoes.
//
// Deploy: Supabase -> Edge Functions -> Deploy new function -> nome "bling-callback"
//   -> DESLIGUE "Verify JWT" (o Bling não manda token nosso).
// Secrets (Edge Functions -> Secrets):
//   BLING_CLIENT_ID     = Client ID do aplicativo criado no Bling
//   BLING_CLIENT_SECRET = Client Secret do aplicativo criado no Bling
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já vêm preenchidos pelo Supabase.
//
// No painel do Bling, o "Redirect URI" do aplicativo tem que ser
// exatamente a URL desta função (https://SEU-PROJETO.supabase.co/functions/v1/bling-callback).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CLIENT_ID = Deno.env.get("BLING_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("BLING_CLIENT_SECRET") ?? "";
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// pra onde o navegador volta depois (tela de Configurações do app).
// O ?parâmetro precisa vir ANTES do #/rota (senão o navegador trata
// tudo depois do # como fragmento, e location.search fica vazio).
const APP_ORIGEM = "https://app.banheza.com.br";

function redirect(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return new Response(null, { status: 302, headers: { Location: `${APP_ORIGEM}/?${qs}#/config` } });
}

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const empresaId = url.searchParams.get("state");
    const erroBling = url.searchParams.get("error");

    if (erroBling) return redirect({ bling: "erro", msg: "autorização recusada" });
    if (!code || !empresaId) return redirect({ bling: "erro", msg: "resposta incompleta do Bling" });
    if (!CLIENT_ID || !CLIENT_SECRET) return redirect({ bling: "erro", msg: "app não configurado" });

    const basic = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
    const tokenRes = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code }),
    });
    const tok = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tok.access_token) {
      console.error("bling token erro:", tokenRes.status, tok);
      await admin.from("empresas").update({
        bling_ultimo_erro: `token: ${tokenRes.status} ${JSON.stringify(tok).slice(0, 300)}`,
      }).eq("id", empresaId);
      return redirect({ bling: "erro", msg: "falha ao obter token" });
    }

    const expiraEm = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString();
    const { error } = await admin.from("bling_conexoes").upsert({
      empresa_id: empresaId,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expira_em: expiraEm,
      atualizado_em: new Date().toISOString(),
    }, { onConflict: "empresa_id" });
    if (error) { console.error("upsert bling_conexoes:", error); return redirect({ bling: "erro", msg: "falha ao salvar conexão" }); }

    await admin.from("empresas").update({
      bling_conectado: true,
      bling_conectado_em: new Date().toISOString(),
      bling_ultimo_erro: null,
    }).eq("id", empresaId);

    return redirect({ bling: "conectado" });
  } catch (e) {
    console.error("bling-callback falhou:", e);
    return redirect({ bling: "erro", msg: "erro interno" });
  }
});
