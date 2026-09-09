-- =====================================================================
--  Banheza Assist — Etapa 2: liberação automática do plano (Mercado Pago)
--  Rode no SQL Editor DEPOIS do supabase-saas.sql. Re-executável.
--
--  Esta função é chamada pela Edge Function "mp-webhook" quando o
--  Mercado Pago avisa que um pagamento de assinatura foi aprovado
--  (ou a assinatura foi cancelada). Ela acha a empresa pelo e-mail do
--  pagador e estende (ou não) o acesso Pro.
-- =====================================================================

create or replace function mp_atualizar_assinatura(
  p_email  text,
  p_status text,
  p_ref    text
) returns uuid
  language plpgsql security definer set search_path = public as $$
declare emp uuid;
begin
  -- empresa do usuário que tem esse e-mail (prioriza um admin)
  select p.empresa_id into emp
    from perfis p
    join auth.users u on u.id = p.id
   where lower(u.email) = lower(trim(coalesce(p_email,'')))
     and p.empresa_id is not null
   order by (p.papel = 'admin') desc
   limit 1;

  if emp is null then
    return null;  -- e-mail não bate com nenhuma empresa; a Banheza libera na mão
  end if;

  if lower(coalesce(p_status,'')) in ('authorized','active','approved','processed') then
    update empresas
       set plano = 'pro',
           assinatura_ate = now() + interval '35 days',   -- renova a cada pagamento
           mp_ref = coalesce(nullif(trim(p_ref),''), mp_ref)
     where id = emp;
  else
    -- cancelado/pausado: não estende. O acesso vale até assinatura_ate
    -- (quando vencer, o app volta sozinho para o plano free).
    update empresas
       set mp_ref = coalesce(nullif(trim(p_ref),''), mp_ref)
     where id = emp;
  end if;

  return emp;
end $$;

revoke all on function mp_atualizar_assinatura(text,text,text) from public, anon, authenticated;
-- (só a Edge Function, com a service_role, chama esta função)
