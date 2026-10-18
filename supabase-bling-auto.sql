-- =====================================================================
--  Banheza Assist — atualização AUTOMÁTICA do Bling (a cada 30 minutos)
--
--  O próprio banco (pg_cron) chama a função bling-sync de cada empresa
--  conectada ao Bling, mesmo com o app fechado. A chamada é protegida por
--  um segredo que fica numa tabela que ninguém lê pela API.
--
--  Rode este arquivo inteiro no SQL Editor. O ÚLTIMO resultado mostra o
--  segredo: copie esse texto e cadastre em Edge Functions -> Secrets com o
--  nome CRON_SECRET (passo a passo no SETUP-BLING.md).
--
--  Re-executável: pode rodar de novo sem quebrar nada (o segredo não muda).
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------- 1. configuração privada do agendamento ----------
create table if not exists bling_cron_cfg (
  chave text primary key,
  valor text not null
);
alter table bling_cron_cfg enable row level security;
revoke all on bling_cron_cfg from anon, authenticated;   -- sem policy = só o banco acessa

-- segredo gerado automaticamente (só cria se ainda não existir)
insert into bling_cron_cfg (chave, valor)
  values ('segredo', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (chave) do nothing;
-- endereço da função bling-sync
insert into bling_cron_cfg (chave, valor)
  values ('url', 'https://cahfugahdvrdpymztyhz.supabase.co/functions/v1/bling-sync')
  on conflict (chave) do update set valor = excluded.valor;

-- ---------- 2. liga/desliga por empresa (botão em Configurações) ----------
alter table empresas add column if not exists bling_auto boolean not null default true;

create or replace function bling_definir_auto(p_auto boolean) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not e_admin() then
    raise exception 'Só o administrador pode mudar a atualização automática.';
  end if;
  update empresas set bling_auto = p_auto where id = minha_empresa();
end $$;
revoke all on function bling_definir_auto(boolean) from public, anon;
grant execute on function bling_definir_auto(boolean) to authenticated;

-- ---------- 3. o que o agendamento executa ----------
-- Dispara uma chamada por empresa conectada (cada uma roda separada, sem esperar as outras).
create or replace function bling_sync_todas() returns integer
  language plpgsql security definer set search_path = public as $$
declare
  r record; v_seg text; v_url text; n integer := 0;
begin
  select valor into v_seg from bling_cron_cfg where chave = 'segredo';
  select valor into v_url from bling_cron_cfg where chave = 'url';
  if v_seg is null or v_url is null then return 0; end if;
  for r in select id from empresas where bling_conectado and bling_auto loop
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_seg),
      body := jsonb_build_object('empresa_id', r.id),
      timeout_milliseconds := 120000
    );
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function bling_sync_todas() from public, anon, authenticated;

-- ---------- 4. agenda: a cada 30 minutos ----------
select cron.schedule('bling-sync-auto', '*/30 * * * *', $cron$select public.bling_sync_todas()$cron$);

-- ---------- 5. COPIE ESTE TEXTO -> Edge Functions > Secrets > CRON_SECRET ----------
select valor as copie_este_texto from bling_cron_cfg where chave = 'segredo';
