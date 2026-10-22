// Banheza Assist — sincronização com o Bling (API v3).
// Duas formas de chamar:
//   1) pelo app (botão "Sincronizar agora" em Configurações): confere o login do
//      usuário e só deixa o administrador sincronizar a própria empresa;
//   2) pelo agendamento automático do banco (pg_cron, a cada 30 min): sem login de
//      usuário, protegida pelo segredo CRON_SECRET no cabeçalho x-cron-secret.
// Como a própria função confere quem está chamando, "Verify JWT" fica DESLIGADO
// (o agendamento do banco não tem login de usuário para mandar).
//
// Puxa Ordens de Serviço, Contatos e Produtos do Bling e grava/atualiza
// nas tabelas do Banheza Assist (ordens, clientes, produtos), usando o
// id "bling-xxx-<id do Bling>" pra sempre atualizar o mesmo registro em
// vez de duplicar a cada sincronização.
//
// Deploy: Supabase -> Edge Functions -> bling-sync -> colar o código -> DESLIGAR "Verify JWT".
// Secrets: BLING_CLIENT_ID, BLING_CLIENT_SECRET (os mesmos do bling-callback)
//          e CRON_SECRET (texto que está em bling_cron_cfg, veja SETUP-BLING.md).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CLIENT_ID = Deno.env.get("BLING_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("BLING_CLIENT_SECRET") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? ""; // segredo do agendamento automático (ver supabase-bling-auto.sql)
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const API = "https://api.bling.com.br/Api/v3";

// CORS: o navegador chama essa função via fetch (supabase.functions.invoke),
// então precisa liberar explicitamente — sem isso o navegador bloqueia a
// resposta antes mesmo de chegar no app ("Failed to send a request...").
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...CORS } });
const fail = (msg: string, status = 401) =>
  new Response(msg, { status, headers: CORS });

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

async function blingList(path: string, headers: Record<string, string>, extra: Record<string, string>, maxPaginas = 20) {
  const out: any[] = [];
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
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

// Grava tudo de uma vez (upsert em lote) em vez de uma chamada por item —
// com muitos registros, uma chamada por item estourava o tempo máximo de
// execução da Edge Function ("shutdown / WallClockTime").
async function upsertLote(tabela: string, rows: any[]): Promise<number> {
  if (!rows.length) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const pedaco = rows.slice(i, i + 500);
    const { error } = await admin.from(tabela).upsert(pedaco);
    if (error) throw new Error(`gravar ${tabela}: ${error.message}`);
    n += pedaco.length;
  }
  return n;
}

// Compara dois objetos ignorando a ordem das chaves (o jsonb do banco reordena).
const estavel = (v: any): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x);
// Só grava o que realmente mudou: sincronizações automáticas frequentes não devem
// regravar centenas de registros iguais (isso dispararia atualização na tela de todo mundo).
const soMudadas = (rows: any[], existentes: Map<string, any>) =>
  rows.filter((r) => !existentes.has(r.id) || estavel(existentes.get(r.id)) !== estavel(r.dados));

// Registros que já vieram do Bling antes. A sincronização MESCLA em cima deles em vez
// de substituir, para não apagar o que a equipe completou dentro do Assist
// (e-mail/endereço do cliente, estoque mínimo, equipamento vinculado à OS, etc.).
async function carregarExistentes(tabela: string, empresaId: string, prefixo: string) {
  const mapa = new Map<string, any>();
  for (let de = 0; ; de += 1000) {
    const { data, error } = await admin.from(tabela).select("id,dados")
      .eq("empresa_id", empresaId).like("id", `${prefixo}%`).range(de, de + 999);
    if (error) { console.error(`existentes ${tabela}`, error); break; }
    for (const r of data || []) mapa.set(r.id, r.dados || {});
    if (!data || data.length < 1000) break;
  }
  return mapa;
}

// A listagem de OS do Bling não traz equipamento nem nº de série; só o detalhe (GET /ordens/servico/{id}).
async function blingDetalheOS(id: number, headers: Record<string, string>) {
  const r = await blingFetch(`${API}/ordens/servico/${id}`, headers);
  if (!r.ok) { console.error("detalhe OS", id, r.status); return null; }
  const b = await r.json().catch(() => null);
  return b?.data ?? null;
}

async function syncOrdens(empresaId: string, headers: Record<string, string>, contatos: Promise<{ ids: Set<string>; autoExcluidos: Map<string, any> }>) {
  const [itens, existentes] = await Promise.all([
    blingList("/ordens/servico", headers, {}),
    carregarExistentes("ordens", empresaId, "bling-os-"),
  ]);
  const agora = Date.now();
  // Detalhe só das OS ainda não finalizadas, mais recentes primeiro, no máximo 30 por
  // sincronização (e de novo só depois de 3 dias) — respeita o limite de chamadas do Bling.
  const precisaDetalhe = (os: any) => {
    if (os.situacao?.valor === 3) return false;
    const em = existentes.get(`bling-os-${os.id}`)?.detalheEm;
    return !em || agora - new Date(em).getTime() > 3 * 86400000;
  };
  const alvos = itens.filter(precisaDetalhe)
    .sort((a: any, b: any) => String(b.data || "").localeCompare(String(a.data || ""))).slice(0, 30);
  const detalhes = new Map<number, any>();
  for (const os of alvos) {
    const d = await blingDetalheOS(os.id, headers);
    if (d) detalhes.set(os.id, d);
    await new Promise((res) => setTimeout(res, 350));
  }
  let equip = 0;
  const rows = itens.map((os: any) => {
    const id = `bling-os-${os.id}`;
    const antigo = existentes.get(id) || null;
    const det = detalhes.get(os.id) || null;
    const base = os.observacoesInternas || `OS ${os.numero ?? os.id}`;
    const statusBling = mapSituacaoOS(os.situacao?.valor);
    const nome = String(det?.equipamento ?? "").trim();
    const ns = String(det?.numeroSerieEquipamento ?? "").trim();
    const equipBling = det ? (nome || ns ? { nome, ns } : null) : (antigo?.equipBling ?? null);
    if (equipBling?.ns) equip++;
    const problema = String(det?.descricaoProblema ?? "").trim();
    return {
      id,
      empresa_id: empresaId,
      dados: {
        ...(antigo || { equipamentoIds: [], tipoAtendimento: null }),
        numeroBling: String(os.numero ?? os.id),
        // meio-dia (UTC) para a data não "voltar um dia" ao converter para o horário do Brasil
        criadaEm: os.data ? `${os.data}T12:00:00.000Z` : (antigo?.criadaEm ?? new Date().toISOString()),
        clienteId: os.contato?.id ? `bling-cli-${os.contato.id}` : (antigo?.clienteId ?? null),
        // só troca a descrição se ninguém a editou no Assist
        descricao: (!antigo || !antigo.descricao || antigo.descricao === base) ? (problema || base) : antigo.descricao,
        // o andamento feito no Assist vale, exceto quando o Bling finaliza a OS
        status: statusBling === "encerrada" ? "encerrada"
          : (antigo?.status && antigo.status !== "aberta" ? antigo.status : statusBling),
        situacaoCobranca: antigo?.situacaoCobranca
          ?? (typeof os.total === "number" ? `R$ ${os.total.toFixed(2)}` : "Não se aplica"),
        equipBling,
        detalheEm: det ? new Date().toISOString() : (antigo?.detalheEm ?? null),
        origem: "bling",
      },
      atualizado_em: new Date().toISOString(),
    };
  });
  const mudadas = soMudadas(rows, existentes);
  await upsertLote("ordens", mudadas);

  // Toda OS precisa mostrar o nome do cliente. Se o contato da OS não veio na lista de contatos
  // (lista longa, contato de outro tipo etc.), cria o cliente na hora com o nome que a própria OS
  // traz. Espera a sincronização de contatos terminar antes, para nunca sobrescrever dados completos.
  const { ids, autoExcluidos } = await contatos;
  const novos = new Map<string, any>();
  for (const os of itens) {
    const cid = os.contato?.id;
    if (!cid) continue;
    const id = `bling-cli-${cid}`;
    // um contato ocultado por ser fornecedor mas que ganhou uma OS volta a aparecer (a OS precisa do nome)
    if (autoExcluidos.has(id) && !novos.has(id)) {
      const { excluido: _x, ...resto } = autoExcluidos.get(id);
      novos.set(id, { id, empresa_id: empresaId, dados: resto, atualizado_em: new Date().toISOString() });
      continue;
    }
    if (ids.has(id) || novos.has(id)) continue;
    const nome = String(os.contato?.nome ?? "").trim() || `Contato ${cid}`;
    novos.set(id, {
      id,
      empresa_id: empresaId,
      dados: {
        razao: nome, fantasia: nome, doc: "", tel: "", email: "", cep: "", endereco: "", cidade: "",
        contatos: "", relacao: "assistencia", blingId: String(cid), origem: "bling", doBling: true,
      },
      atualizado_em: new Date().toISOString(),
    });
  }
  await upsertLote("clientes", [...novos.values()]);
  return { n: rows.length, equip, alterados: mudadas.length + novos.size };
}

const MAX_PAG_CONTATOS = 60; // 60 páginas x 100 = até 6.000 contatos por sincronização

// Fornecedores NÃO são clientes. No Bling um contato pode ter vários tipos (Cliente, Fornecedor...):
// só tratamos como fornecedor quem é "Fornecedor" e NÃO é também "Cliente". Se qualquer passo falhar
// (tipo não encontrado, erro de rede, limite de chamadas), devolve null e nada é filtrado nessa rodada.
async function listaEstrita(path: string, headers: Record<string, string>, extra: Record<string, string>, why: string[]) {
  const out: any[] = [];
  for (let pagina = 1; pagina <= MAX_PAG_CONTATOS; pagina++) {
    const qs = new URLSearchParams({ pagina: String(pagina), limite: "100", ...extra });
    const r = await blingFetch(`${API}${path}?${qs}`, headers);
    if (!r.ok) { console.error("lista estrita erro", path, r.status); why.push(`consulta de contatos por tipo falhou (erro ${r.status})`); return null; }
    const page = (await r.json().catch(() => ({ data: [] }))).data || [];
    out.push(...page);
    if (page.length < 100) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  return out;
}
const semAcento = (s: unknown) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

async function fornecedoresPuros(headers: Record<string, string>, why: string[]): Promise<Set<string> | null> {
  const rt = await blingFetch(`${API}/contatos/tipos`, headers);
  if (!rt.ok) { console.error("tipos de contato erro", rt.status); why.push(`consulta de tipos de contato falhou (erro ${rt.status})`); return null; }
  const tipos: any[] = (await rt.json().catch(() => ({ data: [] }))).data || [];
  const forn = tipos.find((t) => semAcento(t.descricao).startsWith("fornecedor"));
  const cli = tipos.find((t) => semAcento(t.descricao) === "cliente");
  if (!forn || !cli) { why.push("tipos do Bling: " + tipos.map((t) => t.descricao).join(", ") + " (não achei Fornecedor e Cliente)"); return null; }
  const fs = await listaEstrita("/contatos", headers, { criterio: "1", idTipoContato: String(forn.id) }, why);
  if (!fs || !fs.length) { if (fs) why.push("o Bling não devolveu nenhum contato do tipo Fornecedor"); return null; }
  const cs = await listaEstrita("/contatos", headers, { criterio: "1", idTipoContato: String(cli.id) }, why);
  if (!cs || !cs.length) { if (cs) why.push("o Bling não devolveu nenhum contato do tipo Cliente"); return null; } // sem a lista de clientes não dá para separar os que são os dois
  const clientes = new Set(cs.map((x: any) => String(x.id)));
  return new Set(fs.map((x: any) => String(x.id)).filter((id: string) => !clientes.has(id)));
}

// Clientes que já têm OS ou equipamento no Assist nunca são ocultados (null = não deu para conferir).
async function clientesEmUso(empresaId: string, why: string[]): Promise<Set<string> | null> {
  const s = new Set<string>();
  for (const tabela of ["ordens", "equipamentos"]) {
    for (let de = 0; ; de += 1000) {
      const { data, error } = await admin.from(tabela).select("cid:dados->>clienteId")
        .eq("empresa_id", empresaId).order("id").range(de, de + 999);
      if (error) { console.error("em uso", tabela, error); why.push(`não consegui conferir OS/equipamentos (${error.message})`); return null; }
      for (const r of (data || []) as any[]) if (r.cid) s.add(String(r.cid));
      if (!data || data.length < 1000) break;
    }
  }
  return s;
}

async function syncContatos(empresaId: string, headers: Record<string, string>) {
  const why: string[] = [];
  const [itens, existentes, forn, emUso] = await Promise.all([
    blingList("/contatos", headers, { criterio: "1" }, MAX_PAG_CONTATOS),
    carregarExistentes("clientes", empresaId, "bling-cli-"),
    fornecedoresPuros(headers, why),
    clientesEmUso(empresaId, why),
  ]);
  const filtrar = !!forn && !!emUso;
  let ocultos = 0;
  const rows: any[] = [];
  const autoExcluidos = new Map<string, any>(); // ocultados por serem fornecedores (a OS pode trazê-los de volta)
  for (const c of itens.filter((c: any) => c.situacao !== "E")) {
    const id = `bling-cli-${c.id}`;
    const antigo = existentes.get(id) || null;
    const ehFornecedor = filtrar && forn!.has(String(c.id));
    // fornecedor novo: nem entra. Fornecedor que já está em uso (OS/equipamento) fica como cliente.
    if (ehFornecedor && !antigo && !emUso!.has(id)) { ocultos++; continue; }
    const dados: any = {
      ...(antigo || {
        fantasia: c.nome || "(sem nome)", email: "", cep: "", endereco: "", cidade: "",
        contatos: "", relacao: "assistencia",
      }),
      razao: c.nome || antigo?.razao || "(sem nome)",
      doc: c.numeroDocumento || antigo?.doc || "",
      tel: c.telefone || c.celular || antigo?.tel || "",
      blingId: c.codigo || String(c.id),
      origem: "bling",
    };
    // fornecedor que já era "cliente": exclui (lógica, dá para restaurar) uma única vez. Se alguém
    // restaurar à mão depois, fornecedorAuto já está marcado e a sincronização não oculta de novo.
    if (ehFornecedor && antigo && !emUso!.has(id) && !antigo.fornecedorAuto && !antigo.excluido) {
      dados.excluido = { ts: new Date().toISOString(), usuario: "Sincronização Bling", motivo: "Contato do tipo Fornecedor no Bling (não é cliente)" };
      dados.fornecedorAuto = true;
      ocultos++;
    }
    if (dados.excluido && dados.fornecedorAuto) autoExcluidos.set(id, dados);
    rows.push({ id, empresa_id: empresaId, dados, atualizado_em: new Date().toISOString() });
  }
  const mudadas = soMudadas(rows, existentes);
  await upsertLote("clientes", mudadas);
  // ids de todos os clientes que já existem (antes + agora): syncOrdens usa para saber quem falta
  const ids = new Set<string>([...existentes.keys(), ...rows.map((r: any) => r.id)]);
  return {
    n: rows.length, alterados: mudadas.length, ids, autoExcluidos, ocultos, filtrou: filtrar, motivoSemFiltro: why.join("; "),
    truncado: itens.length >= MAX_PAG_CONTATOS * 100,
  };
}

async function syncProdutos(empresaId: string, headers: Record<string, string>) {
  const [itens, existentes] = await Promise.all([
    blingList("/produtos", headers, { criterio: "2", tipo: "P" }),
    carregarExistentes("produtos", empresaId, "bling-prod-"),
  ]);
  const rows = itens.map((p: any) => {
    const id = `bling-prod-${p.id}`;
    const antigo = existentes.get(id) || null;
    return {
      id,
      empresa_id: empresaId,
      dados: {
        ...(antigo || { barras: "", minimo: 0 }),
        descricao: p.nome || antigo?.descricao || "(sem nome)",
        codigo: p.codigo || antigo?.codigo || "",
        referencia: antigo?.referencia ?? (p.codigo || ""),
        estoque: Math.round(p.estoque?.saldoVirtualTotal ?? 0),
        custo: Number(p.precoCusto ?? p.preco ?? 0),
        fonte: "Bling",
      },
      atualizado_em: new Date().toISOString(),
    };
  });
  const mudadas = soMudadas(rows, existentes);
  await upsertLote("produtos", mudadas);
  return { n: rows.length, alterados: mudadas.length };
}

// Qual conta do Bling está conectada? (nome e CNPJ). Serve para o usuário perceber se conectou a conta errada.
// Se o Bling não liberar essa informação (permissão do aplicativo), simplesmente não grava nada.
async function identificarConta(empresaId: string, headers: Record<string, string>) {
  try {
    const r = await blingFetch(`${API}/empresas/me/dados-basicos`, headers);
    if (!r.ok) { console.error("dados-basicos", r.status); return; }
    const d = (await r.json().catch(() => null))?.data;
    if (!d) return;
    await admin.from("empresas").update({ bling_conta_nome: d.nome ?? null, bling_conta_cnpj: d.cnpj ?? null }).eq("id", empresaId);
  } catch (e) { console.error("identificarConta", e); }
}

// Sincroniza UMA empresa (usada pelo botão do app e pelo agendamento automático).
async function sincronizarEmpresa(empresaId: string) {
  const { data: conn } = await admin.from("bling_conexoes").select("*").eq("empresa_id", empresaId).maybeSingle();
  if (!conn) return { ok: false, msg: "Bling não conectado" };
  try {
    let accessToken = conn.access_token as string;
    if (!conn.expira_em || new Date(conn.expira_em).getTime() < Date.now() + 60000) {
      const refreshed = await refreshToken(conn.refresh_token);
      if (!refreshed) {
        await marcarErro(empresaId, "Não foi possível renovar a conexão — reconecte o Bling.");
        return { ok: false, msg: "conexão expirada — reconecte o Bling" };
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
    await identificarConta(empresaId, headers);   // guarda o nome da conta do Bling conectada (aparece em Configurações)
    // os 3 recursos em paralelo — sequencial estourava o tempo máximo de execução
    const pContatos = syncContatos(empresaId, headers);
    const [ordens, clientes, produtos] = await Promise.all([
      syncOrdens(empresaId, headers, pContatos),
      pContatos,
      syncProdutos(empresaId, headers),
    ]);
    await admin.from("empresas").update({
      bling_ultima_sync: new Date().toISOString(),
      bling_ultimo_erro: clientes.truncado
        ? `Aviso: o Bling tem mais de ${MAX_PAG_CONTATOS * 100} contatos; só os primeiros foram importados (clientes das OS são criados mesmo assim).`
        : (clientes.filtrou ? null : `Aviso: fornecedores não filtrados nesta rodada — ${clientes.motivoSemFiltro || "motivo desconhecido"}.`),
    }).eq("id", empresaId);
    return {
      ok: true, os: ordens.n, clientes: clientes.n, produtos: produtos.n, equipamentos: ordens.equip,
      fornecedores_ocultos: clientes.ocultos, filtro_fornecedor: clientes.filtrou,
      alterados: ordens.alterados + clientes.alterados + produtos.alterados,
    };
  } catch (e) {
    // deixa o motivo visível em Configurações (a sincronização automática não tem tela para mostrar erro)
    await marcarErro(empresaId, "Falha ao sincronizar: " + (e as Error).message);
    throw e;
  }
}

// Teste de homologação do Bling: 5 chamadas em sequência à API "/homologacao/produtos" (GET, POST, PUT, PATCH, DELETE),
// passando adiante o hash do cabeçalho x-bling-homologacao de uma resposta para a próxima. Em uma das etapas o Bling
// invalida o access token de propósito: ao receber 401 renovamos com o refresh token e repetimos a mesma chamada.
// Limites do Bling: no máximo 10 s no total e 2 s entre chamadas — por isso nada de pausas aqui.
async function homologar(empresaId: string) {
  const { data: conn } = await admin.from("bling_conexoes").select("*").eq("empresa_id", empresaId).maybeSingle();
  if (!conn) return { ok: false, msg: "Bling não conectado" };
  let access = conn.access_token as string;
  let refresh = conn.refresh_token as string;
  const renovar = async () => {
    const t = await refreshToken(refresh);
    if (!t) throw new Error("não consegui renovar o token — reconecte o Bling");
    access = t.access_token; refresh = t.refresh_token || refresh;
    await admin.from("bling_conexoes").update({
      access_token: access, refresh_token: refresh,
      expira_em: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
      atualizado_em: new Date().toISOString(),
    }).eq("empresa_id", empresaId);
  };
  const passos: { passo: string; status: number; renovouToken: boolean; ms: number }[] = [];
  let hash = "";
  const t0 = Date.now();
  let ultima = 0; // o Bling aceita no máximo 3 chamadas por segundo: espaça as chamadas (cabe folgado nos 10 s do teste)
  let renovou = false;
  const chamar = async (passo: string, metodo: string, caminho: string, corpo?: unknown) => {
    for (let tentativa = 0; tentativa < 5; tentativa++) {
      const espera = 450 - (Date.now() - ultima);
      if (espera > 0) await new Promise((res) => setTimeout(res, espera));
      ultima = Date.now();
      const h: Record<string, string> = { Authorization: `Bearer ${access}`, Accept: "application/json" };
      if (corpo !== undefined) h["Content-Type"] = "application/json";
      if (hash) h["x-bling-homologacao"] = hash;
      const ini = Date.now();
      const r = await fetch(`${API}${caminho}`, { method: metodo, headers: h, body: corpo !== undefined ? JSON.stringify(corpo) : undefined });
      if (r.status === 429) { await r.text().catch(() => ""); await new Promise((res) => setTimeout(res, 800)); continue; }
      if (r.status === 401 && !renovou) { await r.text().catch(() => ""); renovou = true; await renovar(); continue; }
      const novo = r.headers.get("x-bling-homologacao");
      if (novo) hash = novo;
      const txt = await r.text();
      passos.push({ passo, status: r.status, renovouToken: renovou, ms: Date.now() - ini });
      if (!r.ok) throw new Error(`${passo}: erro ${r.status} ${txt.slice(0, 300)}`);
      try { return JSON.parse(txt); } catch { return null; }
    }
    return null;
  };
  try {
    if (!conn.expira_em || new Date(conn.expira_em).getTime() < Date.now() + 60000) await renovar();
    const g = await chamar("1 GET produto", "GET", "/homologacao/produtos");
    const dados = g?.data;
    if (!dados) throw new Error("1 GET produto: resposta sem dados");
    const c = await chamar("2 POST produto", "POST", "/homologacao/produtos", { nome: dados.nome, preco: dados.preco, codigo: dados.codigo });
    const id = c?.data?.id;
    if (!id) throw new Error("2 POST produto: resposta sem id");
    await chamar("3 PUT produto", "PUT", `/homologacao/produtos/${id}`, { nome: "Copo", preco: dados.preco, codigo: dados.codigo });
    await chamar("4 PATCH situação", "PATCH", `/homologacao/produtos/${id}/situacoes`, { situacao: "I" });
    await chamar("5 DELETE produto", "DELETE", `/homologacao/produtos/${id}`);
    return { ok: true, total_ms: Date.now() - t0, passos };
  } catch (e) {
    return { ok: false, msg: (e as Error).message, total_ms: Date.now() - t0, passos };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) return ok({ ok: false, msg: "app do Bling não configurado (secrets ausentes)" });

    // 1) Chamada agendada pelo banco (pg_cron): sem login de usuário, protegida por segredo.
    const segredo = req.headers.get("x-cron-secret");
    if (segredo !== null) {
      if (!CRON_SECRET || segredo !== CRON_SECRET) return fail("segredo inválido");
      const b = await req.json().catch(() => ({}));
      const empresaId = String(b?.empresa_id || "");
      if (!empresaId) return ok({ ok: false, msg: "empresa_id ausente" });
      return ok(await sincronizarEmpresa(empresaId));
    }

    // 2) Chamada do app (botão "Sincronizar agora"): precisa de login de administrador.
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return fail("sem sessão");
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return fail("sessão inválida");

    const { data: perfil } = await admin.from("perfis").select("empresa_id,papel,ativo").eq("id", userData.user.id).maybeSingle();
    if (!perfil || !perfil.ativo || !perfil.empresa_id) return ok({ ok: false, msg: "perfil inválido" });
    if (perfil.papel !== "admin") return ok({ ok: false, msg: "só o administrador sincroniza com o Bling" });
    const corpo = await req.json().catch(() => ({}));
    if (corpo?.acao === "homologacao") return ok(await homologar(perfil.empresa_id as string));
    return ok(await sincronizarEmpresa(perfil.empresa_id as string));
  } catch (e) {
    console.error("bling-sync falhou:", e);
    return new Response("erro: " + (e as Error).message, { status: 500, headers: CORS });
  }
});
