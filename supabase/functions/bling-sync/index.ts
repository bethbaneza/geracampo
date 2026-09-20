// Banheza Assist — sincronização com o Bling (API v3).
// Chamada pelo próprio app (botão "Sincronizar agora" em Configurações),
// já autenticada com o login do usuário — por isso "Verify JWT" fica LIGADO
// aqui (diferente do bling-callback, que o Bling chama sem token nosso).
//
// Puxa Ordens de Serviço, Contatos e Produtos do Bling e grava/atualiza
// nas tabelas do Banheza Assist (ordens, clientes, produtos), usando o
// id "bling-xxx-<id do Bling>" pra sempre atualizar o mesmo registro em
// vez de duplicar a cada sincronização.
//
// Deploy: Supabase -> Edge Functions -> Deploy new function -> nome "bling-sync"
//   -> Verify JWT continua LIGADO (padrão).
// Secrets: os mesmos BLING_CLIENT_ID / BLING_CLIENT_SECRET do bling-callback.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CLIENT_ID = Deno.env.get("BLING_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("BLING_CLIENT_SECRET") ?? "";
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const API = "https://api.bling.com.br/Api/v3";
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

async function marcarErro(empresaId: string, msg: string) {
  await admin.from("empresas").update({ bling_ultimo_erro: msg }).eq("id", empresaId);
}

async function blingFetch(url: string, headers: Record<string, string>): Promise<Response> {
  for (let t = 0; t < 3; t++) {
    const r = await fetch(url, { headers });
    if (r.status !== 429) return r;
    await new Promise((res) => setTimeout(res, 1000 * (t + 1)));
  }
  return fetch(url, { headers });
}

async function blingList(path: string, headers: Record<string, string>, extra: Record<string, string>) {
  const out: any[] = [];
  for (let pagina = 1; pagina <= 20; pagina++) {
    const qs = new URLSearchParams({ pagina: String(pagina), limite: "100", ...extra });
    const r = await blingFetch(`${API}${path}?${qs}`, headers);
    if (!r.ok) { console.error("bling list erro", path, r.status, await r.text().catch(() => "")); break; }
    const body = await r.json().catch(() => ({ data: [] }));
    const page = body.data || [];
    out.push(...page);
    if (page.length < 100) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  return out;
}

async function refreshToken(refreshTokenAtual: string) {
  const basic = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  const r = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshTokenAtual }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.access_token) { console.error("refresh token erro:", r.status, tok); return null; }
  return tok;
}

function mapSituacaoOS(valor: number | undefined): string {
  switch (valor) {
    case 6: return "em_atendimento";
    case 2: return "aguardando_retorno";
    case 3: return "encerrada";
    default: return "aberta"; // 0 em aberto, 1 orçada, 4 não aprovada, 5 aprovada
  }
}

async function syncOrdens(empresaId: string, headers: Record<string, string>) {
  const itens = await blingList("/ordens/servico", headers, {});
  let n = 0;
  for (const os of itens) {
    const row = {
      id: `bling-os-${os.id}`,
      empresa_id: empresaId,
      dados: {
        numeroBling: String(os.numero ?? os.id),
        criadaEm: os.data ? `${os.data}T00:00:00.000Z` : new Date().toISOString(),
        clienteId: os.contato?.id ? `bling-cli-${os.contato.id}` : null,
        descricao: os.observacoesInternas || `OS ${os.numero ?? os.id}`,
        status: mapSituacaoOS(os.situacao?.valor),
        equipamentoId: null,
        tipoAtendimento: null,
        situacaoCobranca: typeof os.total === "number" ? `R$ ${os.total.toFixed(2)}` : "Não se aplica",
        origem: "bling",
      },
      atualizado_em: new Date().toISOString(),
    };
    const { error } = await admin.from("ordens").upsert(row);
    if (error) console.error("upsert ordem", os.id, error); else n++;
  }
  return n;
}

async function syncContatos(empresaId: string, headers: Record<string, string>) {
  const itens = await blingList("/contatos", headers, { criterio: "1" });
  let n = 0;
  for (const c of itens) {
    if (c.situacao === "E") continue; // excluído no Bling — não traz
    const row = {
      id: `bling-cli-${c.id}`,
      empresa_id: empresaId,
      dados: {
        razao: c.nome || "(sem nome)",
        fantasia: c.nome || "(sem nome)",
        doc: c.numeroDocumento || "",
        tel: c.telefone || c.celular || "",
        email: "",
        endereco: "",
        cidade: "",
        contatos: "",
        blingId: c.codigo || String(c.id),
        relacao: "assistencia",
        origem: "bling",
      },
      atualizado_em: new Date().toISOString(),
    };
    const { error } = await admin.from("clientes").upsert(row);
    if (error) console.error("upsert cliente", c.id, error); else n++;
  }
  return n;
}

async function syncProdutos(empresaId: string, headers: Record<string, string>) {
  const itens = await blingList("/produtos", headers, { criterio: "2", tipo: "P" });
  let n = 0;
  for (const p of itens) {
    const row = {
      id: `bling-prod-${p.id}`,
      empresa_id: empresaId,
      dados: {
        descricao: p.nome || "(sem nome)",
        codigo: p.codigo || "",
        referencia: p.codigo || "",
        barras: "",
        estoque: Math.round(p.estoque?.saldoVirtualTotal ?? 0),
        minimo: 0,
        custo: Number(p.precoCusto ?? p.preco ?? 0),
        fonte: "Bling",
      },
      atualizado_em: new Date().toISOString(),
    };
    const { error } = await admin.from("produtos").upsert(row);
    if (error) console.error("upsert produto", p.id, error); else n++;
  }
  return n;
}

Deno.serve(async (req: Request) => {
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) return ok({ ok: false, msg: "app do Bling não configurado (secrets ausentes)" });

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return new Response("sem sessão", { status: 401 });
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return new Response("sessão inválida", { status: 401 });

    const { data: perfil } = await admin.from("perfis").select("empresa_id,papel,ativo").eq("id", userData.user.id).maybeSingle();
    if (!perfil || !perfil.ativo || !perfil.empresa_id) return ok({ ok: false, msg: "perfil inválido" });
    if (perfil.papel !== "admin") return ok({ ok: false, msg: "só o administrador sincroniza com o Bling" });
    const empresaId = perfil.empresa_id as string;

    const { data: conn } = await admin.from("bling_conexoes").select("*").eq("empresa_id", empresaId).maybeSingle();
    if (!conn) return ok({ ok: false, msg: "Bling não conectado" });

    let accessToken = conn.access_token as string;
    if (!conn.expira_em || new Date(conn.expira_em).getTime() < Date.now() + 60000) {
      const refreshed = await refreshToken(conn.refresh_token);
      if (!refreshed) {
        await marcarErro(empresaId, "Não foi possível renovar a conexão — reconecte o Bling.");
        return ok({ ok: false, msg: "conexão expirada — reconecte o Bling" });
      }
      accessToken = refreshed.access_token;
      await admin.from("bling_conexoes").update({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || conn.refresh_token,
        expira_em: new Date(Date.now() + (Number(refreshed.expires_in) || 3600) * 1000).toISOString(),
        atualizado_em: new Date().toISOString(),
      }).eq("empresa_id", empresaId);
    }

    const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
    const os = await syncOrdens(empresaId, headers);
    const clientes = await syncContatos(empresaId, headers);
    const produtos = await syncProdutos(empresaId, headers);

    await admin.from("empresas").update({ bling_ultima_sync: new Date().toISOString(), bling_ultimo_erro: null }).eq("id", empresaId);
    return ok({ ok: true, os, clientes, produtos });
  } catch (e) {
    console.error("bling-sync falhou:", e);
    return new Response("erro: " + (e as Error).message, { status: 500 });
  }
});
