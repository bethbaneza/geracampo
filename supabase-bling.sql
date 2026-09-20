-- =====================================================================
--  Banheza Assist — integração com o Bling (API v3, OAuth2)
--
--  Guarda o access_token/refresh_token de cada empresa numa tabela que
--  NINGUÉM lê pela API (nem o próprio usuário logado) — só as Edge
--  Functions (com a chave service_role) tocam nela. O app só enxerga
--  o status (conectado / última sincronização) via a tabela `empresas`.
--
--  Re-executável: pode rodar de novo sem quebrar nada.
-- =====================================================================

-- ---------- 1. tokens (privado — sem policy = ninguém acessa pela API) ----------
create table if not exists bling_conexoes (
  empresa_id uuid primary key references empresas(id),
  access_token text,
  refresh_token text,
  expira_em timestamptz,
  conectado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);
alter table bling_conexoes enable row level security;
revoke all on bling_conexoes from anon, authenticated;

-- ---------- 2. status (público para a própria empresa, sem token) ----------
alter table empresas add column if not exists bling_conectado boolean not null default false;
alter table empresas add column if not exists bling_conectado_em timestamptz;
alter table empresas add column if not exists bling_ultima_sync timestamptz;
alter table empresas add column if not exists bling_ultimo_erro text;

-- ---------- 3. desconectar (o próprio admin pode chamar) ----------
create or replace function bling_desconectar() returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not e_admin() then
    raise exception 'Só o administrador pode desconectar o Bling.';
  end if;
  delete from bling_conexoes where empresa_id = minha_empresa();
  update empresas set bling_conectado = false, bling_ultimo_erro = null where id = minha_empresa();
end $$;
revoke all on function bling_desconectar() from public, anon;
grant execute on function bling_desconectar() to authenticated;
