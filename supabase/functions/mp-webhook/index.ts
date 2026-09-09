// Banheza Assist — webhook do Mercado Pago (assinatura Pro).
// Recebe o aviso do Mercado Pago, confere direto na API do MP e libera
// o plano Pro da empresa (pelo e-mail do pagador) chamando a função
// SQL mp_atualizar_assinatura.
//
// Deploy: Supabase -> Edge Functions -> Deploy new function -> nome "mp-webhook"
//   -> DESLIGUE "Verify JWT" (o Mercado Pago não manda token).
// Secrets (Edge Functions -> Secrets): MP_ACCESS_TOKEN = seu Access Token de PRODUÇÃO.
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já vêm preenchidos pelo Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MP_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function mpGet(path: string): Promise<any | null> {
  const r = await fetch("https://api.mercadopago.com" + path, {
    headers: { Authorization: `Bearer ${MP_TOKEN}` },
  });
  if (r.status === 404) return null; // recurso nao existe (ex.: id "123456" da simulacao do MP)
  if (!r.ok) throw new Error(`MP ${path} -> ${r.status}`);
  return r.json();
}
const ok = (msg: string) =>
  new Response(JSON.stringify({ ok: true, msg }), {
    status: 200, headers: { "content-type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  try {
    if (!MP_TOKEN) return new Response("MP_ACCESS_TOKEN nao configurado", { status: 500 });

    const url = new URL(req.url);
    let type = url.searchParams.get("type") || url.searchParams.get("topic") || "";
    let id = url.searchParams.get("data.id") || url.searchParams.get("id") || "";
    if ((req.headers.get("content-type") || "").includes("json")) {
      const b = await req.json().catch(() => ({}));
      type = b.type || b.topic || type;
      id = (b.data && b.data.id) || b.id || id;
    }
    type = String(type).toLowerCase();
    if (!id) return ok("sem id");

    let email = "", status = "", ref = String(id);

    if (type.includes("authorized_payment")) {
      const ap = await mpGet(`/authorized_payments/${id}`);
      if (!ap) return ok("authorized_payment inexistente (teste?)");
      ref = ap.preapproval_id || id;
      status = ap.status === "processed" ? "authorized" : (ap.status || "");
      if (ap.preapproval_id) {
        const pa = await mpGet(`/preapproval/${ap.preapproval_id}`);
        email = pa?.payer_email || "";
      }
    } else if (type.includes("preapproval") || type.includes("subscription")) {
      const pa = await mpGet(`/preapproval/${id}`);
      if (!pa) return ok("preapproval inexistente (teste?)");
      email = pa.payer_email || "";
      status = pa.status || "";
      ref = pa.id || id;
    } else if (type === "payment") {
      const pay = await mpGet(`/v1/payments/${id}`);
      if (!pay) return ok("pagamento inexistente (teste?)");
      email = pay?.payer?.email || "";
      status = pay.status === "approved" ? "authorized" : (pay.status || "");
      ref = pay.metadata?.preapproval_id || String(id);
    } else {
      return ok("evento ignorado: " + type);
    }

    if (!email) return ok("sem e-mail do pagador");

    const { data, error } = await admin.rpc("mp_atualizar_assinatura", {
      p_email: email, p_status: status, p_ref: ref,
    });
    if (error) { console.error("rpc erro:", error); return new Response("erro rpc", { status: 500 }); }

    console.log("mp-webhook:", { type, status, email, empresa: data });
    return ok(data ? `empresa ${data} atualizada (${status})` : `e-mail ${email} sem empresa`);
  } catch (e) {
    console.error("mp-webhook falhou:", e);
    // 500 -> o Mercado Pago tenta de novo mais tarde
    return new Response("erro: " + (e as Error).message, { status: 500 });
  }
});
