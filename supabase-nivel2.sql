-- =====================================================================
--  GeraCampo — NÍVEL 2 de segurança
--  Supabase Auth + tabelas reais + RLS + auditoria + backup
--
--  ORDEM (veja SETUP-NIVEL2.md):
--   PASSO A) Rode este arquivo inteiro no SQL Editor.
--   PASSO B) Crie o 1º usuário em Authentication -> Users (vira admin).
--   PASSO C) Rode SÓ o bloco "MIGRAÇÃO" no fim (copia os dados atuais).
--
--  Re-executável: pode rodar de novo sem quebrar nada.
-- =====================================================================

-- ---------- 1. EMPRESAS E PERFIS -------------------------------------
create table if not exists empresas (
  id uuid primary key default gen_random_uuid(),
  nome text not null default 'Minha Empresa',
  criado_em timestamptz default now()
);

create table if not exists perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  empresa_id uuid not null references empresas(id),
  nome text not null,
  papel text not null default 'tecnico' check (papel in ('admin','tecnico')),
  ativo boolean not null default true,
  criado_em timestamptz default now()
);

-- ---------- 2. FUNÇÕES AUXILIARES -----------------------------------
create or replace function minha_empresa() returns uuid
  language sql stable security definer set search_path = public as $$
  select empresa_id from perfis where id = auth.uid() and ativo
$$;

create or replace function e_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select papel = 'admin' from perfis where id = auth.uid() and ativo), false)
$$;

-- ---------- 3. AO CRIAR USUÁRIO NO AUTH, CRIA O PERFIL --------------
create or replace function on_auth_user_created() returns trigger
  language plpgsql security definer set search_path = public as $$
declare emp uuid; primeiro boolean;
begin
  select id into emp from empresas limit 1;
  if emp is null then
    insert into empresas(nome) values ('Minha Empresa') returning id into emp;
  end if;
  select count(*) = 0 into primeiro from perfis;
  insert into perfis(id, empresa_id, nome, papel)
  values (new.id, emp,
          coalesce(new.raw_user_meta_data->>'nome', split_part(new.email,'@',1)),
          case when primeiro then 'admin' else 'tecnico' end)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created after insert on auth.users
  for each row execute function on_auth_user_created();

-- ---------- 4. TABELAS DE DADOS (mesma forma p/ todas) -------------
do $$
declare t text;
begin
  foreach t in array array[
    'clientes','equipamentos','veiculos','preventivas','produtos',
    'ordens','manutencoes','solicitacoes_peca','jornadas','despesas','campos_tecnicos'
  ] loop
    execute format($f$
      create table if not exists %1$I (
        id text primary key,
        empresa_id uuid not null default minha_empresa() references empresas(id),
        dados jsonb not null default '{}'::jsonb,
        criado_em timestamptz default now(),
        criado_por uuid default auth.uid(),
        atualizado_em timestamptz default now()
      )$f$, t);
    execute format('alter table %1$I enable row level security', t);
    execute format('create index if not exists %1$I on %2$I (empresa_id)', t||'_emp_idx', t);
  end loop;
end $$;

create table if not exists config_empresa (
  empresa_id uuid primary key references empresas(id),
  dados jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz default now()
);
alter table config_empresa enable row level security;

create table if not exists auditoria (
  id bigint generated always as identity primary key,
  empresa_id uuid not null default minha_empresa(),
  usuario_id uuid default auth.uid(),
  usuario_nome text,
  acao text, entidade text, entidade_id text, detalhe text,
  ts timestamptz default now()
);
alter table auditoria enable row level security;
create index if not exists auditoria_emp_idx on auditoria (empresa_id, ts desc);

create table if not exists backup_diario (
  feito_em timestamptz primary key default now(),
  dados jsonb not null
);
alter table backup_diario enable row level security;   -- sem policy = ninguém acessa pela API

-- ---------- 5. RLS -------------------------------------------------
-- perfis
drop policy if exists perfis_sel on perfis;
drop policy if exists perfis_ins on perfis;
drop policy if exists perfis_upd on perfis;
drop policy if exists perfis_del on perfis;
create policy perfis_sel on perfis for select using (empresa_id = minha_empresa());
create policy perfis_ins on perfis for insert with check (e_admin() and empresa_id = minha_empresa());
create policy perfis_upd on perfis for update using (e_admin() and empresa_id = minha_empresa()) with check (empresa_id = minha_empresa());
create policy perfis_del on perfis for delete using (e_admin() and empresa_id = minha_empresa() and id <> auth.uid());

-- tabelas de dados
do $$
declare t text;
begin
  foreach t in array array[
    'clientes','equipamentos','veiculos','preventivas','produtos',
    'ordens','manutencoes','solicitacoes_peca','jornadas','despesas','campos_tecnicos'
  ] loop
    execute format('drop policy if exists %I on %I', t||'_sel', t);
    execute format('drop policy if exists %I on %I', t||'_ins', t);
    execute format('drop policy if exists %I on %I', t||'_upd', t);
    execute format('drop policy if exists %I on %I', t||'_del', t);
    execute format('create policy %I on %I for select using (empresa_id = minha_empresa())', t||'_sel', t);
    execute format('create policy %I on %I for insert with check (empresa_id = minha_empresa())', t||'_ins', t);
    execute format('create policy %I on %I for update using (empresa_id = minha_empresa()) with check (empresa_id = minha_empresa())', t||'_upd', t);
    execute format('create policy %I on %I for delete using (empresa_id = minha_empresa())', t||'_del', t);
  end loop;
end $$;

-- apagar ORDEM DE SERVIÇO e EQUIPAMENTO/NS: só administrador
drop policy if exists ordens_del on ordens;
create policy ordens_del on ordens for delete using (empresa_id = minha_empresa() and e_admin());
drop policy if exists equipamentos_del on equipamentos;
create policy equipamentos_del on equipamentos for delete using (empresa_id = minha_empresa() and e_admin());

-- config da empresa: todos leem; só admin grava
drop policy if exists cfg_sel on config_empresa;
drop policy if exists cfg_ins on config_empresa;
drop policy if exists cfg_upd on config_empresa;
create policy cfg_sel on config_empresa for select using (empresa_id = minha_empresa());
create policy cfg_ins on config_empresa for insert with check (e_admin() and empresa_id = minha_empresa());
create policy cfg_upd on config_empresa for update using (e_admin() and empresa_id = minha_empresa());

-- auditoria: adiciona (só o próprio usuário); NUNCA edita/apaga (sem policy = bloqueado)
drop policy if exists aud_sel on auditoria;
drop policy if exists aud_ins on auditoria;
create policy aud_sel on auditoria for select using (empresa_id = minha_empresa());
create policy aud_ins on auditoria for insert with check (empresa_id = minha_empresa() and usuario_id = auth.uid());

-- empresas: cada um lê a própria
drop policy if exists emp_sel on empresas;
create policy emp_sel on empresas for select using (id = minha_empresa());
alter table empresas enable row level security;

-- ---------- 6. GRANTS (RLS só é avaliado se houver grant) ----------
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  clientes, equipamentos, veiculos, preventivas, produtos, ordens, manutencoes,
  solicitacoes_peca, jornadas, despesas, campos_tecnicos, config_empresa, perfis
  to authenticated;
grant select, insert on auditoria to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select on empresas to authenticated;
-- anon (chave pública) não acessa NADA das tabelas novas
-- (NÃO mexe em geracampo_estado — o app antigo continua funcionando até você trocar)
revoke all on
  clientes, equipamentos, veiculos, preventivas, produtos, ordens, manutencoes,
  solicitacoes_peca, jornadas, despesas, campos_tecnicos, config_empresa,
  auditoria, perfis, empresas, backup_diario
  from anon;

-- ---------- 7. REALTIME ------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'clientes','equipamentos','veiculos','preventivas','produtos','ordens','manutencoes',
    'solicitacoes_peca','jornadas','despesas','campos_tecnicos','config_empresa','auditoria','perfis'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------- 8. BACKUP DIÁRIO AUTOMÁTICO (grátis) ------------------
-- OBS: se ESTA parte der erro ("pg_cron"), TODO O RESTO ACIMA JÁ FUNCIONOU.
--      Vá em Database -> Extensions, ative "pg_cron", e rode SÓ da linha
--      abaixo até o "PARE AQUI". Não precisa rodar o arquivo todo de novo.
-- (a tabela backup_diario já foi criada no passo 4)
create extension if not exists pg_cron;
do $$ begin perform cron.unschedule('backup-geracampo'); exception when others then null; end $$;
select cron.schedule('backup-geracampo', '0 5 * * *', $CRON$
  insert into backup_diario(feito_em, dados) values (now(), (
    select jsonb_build_object(
      'empresas',      (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from empresas x),
      'perfis',        (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from perfis x),
      'config_empresa',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from config_empresa x),
      'clientes',      (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from clientes x),
      'equipamentos',  (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from equipamentos x),
      'veiculos',      (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from veiculos x),
      'preventivas',   (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from preventivas x),
      'produtos',      (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from produtos x),
      'ordens',        (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from ordens x),
      'manutencoes',   (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from manutencoes x),
      'solicitacoes_peca',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from solicitacoes_peca x),
      'jornadas',      (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from jornadas x),
      'despesas',      (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from despesas x),
      'campos_tecnicos',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from campos_tecnicos x),
      'auditoria',     (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from auditoria x)
    )));
  delete from backup_diario where feito_em < now() - interval '30 days';
$CRON$);

-- =====================================================================
--  >>> PARE AQUI. Vá para o PASSO B (criar o 1º usuário).  <<<
-- =====================================================================


-- =====================================================================
--  MIGRAÇÃO  —  rode SÓ este bloco, depois de criar o 1º usuário.
--  Copia os dados de geracampo_estado para as tabelas novas.
--  (usuários antigos e auditoria antiga NÃO são copiados — recomeçam)
-- =====================================================================
do $$
declare
  emp uuid;
  par record;   -- par (chave_antiga -> tabela_nova)
  linha record; -- cada registro do array
  arr jsonb;
  pares text[][] := array[
    ['clientes','clientes'],['equipamentos','equipamentos'],['veiculos','veiculos'],
    ['preventivas','preventivas'],['produtos','produtos'],['ordens','ordens'],
    ['manutencoes','manutencoes'],['solicitacoesPeca','solicitacoes_peca'],
    ['jornadas','jornadas'],['abastecimentos','despesas'],['camposTecnicos','campos_tecnicos']];
  i int;
begin
  select id into emp from empresas limit 1;
  if emp is null then raise exception 'Crie o 1º usuário em Authentication antes de migrar.'; end if;
  if to_regclass('public.geracampo_estado') is null then
    raise notice 'geracampo_estado não existe — nada a migrar.'; return;
  end if;

  for i in 1 .. array_length(pares,1) loop
    select items into arr from geracampo_estado where col = pares[i][1];
    if arr is null or jsonb_typeof(arr) <> 'array' then continue; end if;
    for linha in select value as v from jsonb_array_elements(arr) loop
      execute format('insert into %I (id, empresa_id, dados) values ($1,$2,$3) on conflict (id) do nothing', pares[i][2])
        using coalesce(nullif(linha.v->>'id',''), gen_random_uuid()::text), emp, linha.v;
    end loop;
  end loop;

  insert into config_empresa(empresa_id, dados)
  select emp, coalesce((select items->0 from geracampo_estado where col='configs'), '{}'::jsonb)
  on conflict (empresa_id) do update set dados = excluded.dados;

  raise notice 'Migração concluída para a empresa %', emp;
end $$;
