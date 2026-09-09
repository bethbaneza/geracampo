-- =====================================================================
--  Banheza Assist — MODO SAAS (multi-empresa, trial 30 dias, convites)
--
--  Rode este arquivo INTEIRO no SQL Editor do Supabase, DEPOIS do
--  supabase-nivel2.sql. É re-executável (pode rodar de novo sem quebrar).
--
--  O que faz:
--   - empresas ganha plano / trial_ate / assinatura_ate
--   - promove a(s) empresa(s) que já existem para "pro" (você não perde acesso)
--   - cria a tabela de convites (código para o técnico se cadastrar)
--   - o cadastro (signUp) passa a: criar empresa nova (sem código) OU
--     entrar na empresa do código (com papel definido pelo convite)
--   - função plano_efetivo(): 'pro' | 'trial' | 'free'
-- =====================================================================

-- ---------- 1. COLUNAS DE PLANO NA EMPRESA --------------------------
alter table empresas add column if not exists plano text not null default 'trial';
alter table empresas add column if not exists trial_ate timestamptz;
alter table empresas add column if not exists assinatura_ate timestamptz;
alter table empresas add column if not exists mp_ref text;          -- referência da assinatura no Mercado Pago (etapa 2)

-- perfil pode ficar "sem empresa" enquanto o convite não é aceito
alter table perfis alter column empresa_id drop not null;

-- ---------- 2. PROMOVE AS EMPRESAS ATUAIS PARA PRO ------------------
-- (qualquer empresa que já tem gente dentro e ainda não tem assinatura)
update empresas e
   set plano = 'pro',
       assinatura_ate = coalesce(e.assinatura_ate, now() + interval '20 years')
 where e.assinatura_ate is null
   and exists (select 1 from perfis p where p.empresa_id = e.id);

-- ---------- 3. TABELA DE CONVITES ---------------------------------
create table if not exists convites (
  codigo      text primary key,
  empresa_id  uuid not null references empresas(id) on delete cascade,
  papel       text not null default 'tecnico' check (papel in ('admin','tecnico')),
  criado_por  uuid default auth.uid(),
  criado_em   timestamptz default now(),
  expira_em   timestamptz,
  usos_max    int not null default 1,
  usos        int not null default 0,
  ativo       boolean not null default true
);
alter table convites enable row level security;
create index if not exists convites_emp_idx on convites (empresa_id);

drop policy if exists convites_sel on convites;
drop policy if exists convites_ins on convites;
drop policy if exists convites_upd on convites;
drop policy if exists convites_del on convites;
create policy convites_sel on convites for select using (empresa_id = minha_empresa());
create policy convites_ins on convites for insert with check (e_admin() and empresa_id = minha_empresa());
create policy convites_upd on convites for update using (e_admin() and empresa_id = minha_empresa());
create policy convites_del on convites for delete using (e_admin() and empresa_id = minha_empresa());

grant select, insert, update, delete on convites to authenticated;
revoke all on convites from anon;

do $$ begin
  begin execute 'alter publication supabase_realtime add table convites'; exception when duplicate_object then null; end;
end $$;

-- ---------- 4. PLANO EFETIVO -------------------------------------
create or replace function plano_efetivo() returns text
  language sql stable security definer set search_path = public as $$
  select case
    when e.assinatura_ate is not null and e.assinatura_ate >= now() then 'pro'
    when e.trial_ate     is not null and e.trial_ate     >= now() then 'trial'
    else 'free'
  end
  from empresas e where e.id = minha_empresa()
$$;
grant execute on function plano_efetivo() to authenticated;

-- ---------- 5. CADASTRO: EMPRESA NOVA OU CONVITE ------------------
create or replace function on_auth_user_created() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  cod  text := upper(nullif(trim(new.raw_user_meta_data->>'codigo'), ''));
  nom  text := coalesce(nullif(trim(new.raw_user_meta_data->>'nome'), ''), split_part(new.email,'@',1));
  conv convites%rowtype;
  emp  uuid;
begin
  -- já tem perfil? não faz nada
  if exists (select 1 from perfis where id = new.id) then
    return new;
  end if;

  if cod is not null then
    select * into conv from convites
      where codigo = cod and ativo
        and usos < usos_max
        and (expira_em is null or expira_em > now())
      limit 1;
    if found then
      insert into perfis(id, empresa_id, nome, papel, ativo)
        values (new.id, conv.empresa_id, nom, conv.papel, true);
      update convites set usos = usos + 1,
             ativo = (usos + 1 < usos_max)
        where codigo = conv.codigo;
    else
      -- código inválido / vencido -> perfil sem empresa (app mostra "acesso pendente")
      insert into perfis(id, empresa_id, nome, papel, ativo)
        values (new.id, null, nom, 'tecnico', false);
    end if;
  else
    -- sem código -> cria uma empresa nova, este usuário é o admin, trial de 30 dias
    insert into empresas(nome, plano, trial_ate)
      values ('Minha Empresa', 'trial', now() + interval '30 days')
      returning id into emp;
    insert into perfis(id, empresa_id, nome, papel, ativo)
      values (new.id, emp, nom, 'admin', true);
  end if;

  return new;
end $$;

drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created after insert on auth.users
  for each row execute function on_auth_user_created();

-- ---------- 6. EMPRESAS: admin ajusta só o nome -------------------
create or replace function definir_nome_empresa(p_nome text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not e_admin() then raise exception 'Somente o administrador.' using errcode = '42501'; end if;
  update empresas set nome = coalesce(nullif(trim(p_nome),''), nome) where id = minha_empresa();
end $$;
grant execute on function definir_nome_empresa(text) to authenticated;

-- =====================================================================
--  LIBERAR O PLANO PRO NA MÃO (enquanto o pagamento automático não existe)
--  Troque o e-mail e rode a linha abaixo:
--
--  update empresas set plano='pro',
--         assinatura_ate = now() + interval '1 year'
--   where id = (select p.empresa_id from perfis p
--               join auth.users u on u.id = p.id
--               where u.email = 'CLIENTE@EXEMPLO.COM' limit 1);
--
--  Ver as empresas e seus planos:
--  select e.nome, e.plano, e.trial_ate, e.assinatura_ate,
--         (select count(*) from perfis p where p.empresa_id=e.id) usuarios
--    from empresas e order by e.criado_em desc;
-- =====================================================================
