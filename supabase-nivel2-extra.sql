-- =====================================================================
--  GeraCampo — Nível 2 · reforço opcional
--  Rode DEPOIS do supabase-nivel2.sql e da migração.
--  Impede que um USUÁRIO comum (não-admin) marque uma OS ou um
--  equipamento como "excluído" (a exclusão só-admin já valia para
--  apagar de vez; isto fecha também a exclusão lógica).
-- =====================================================================

create or replace function bloqueia_exclusao_nao_admin() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- se o registro está passando a ter "excluido" e quem edita não é admin -> nega
  if (new.dados ? 'excluido')
     and coalesce(old.dados ? 'excluido', false) = false
     and not e_admin() then
    raise exception 'Somente o administrador pode excluir % (RLS).', tg_table_name
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_excl_ordens on ordens;
create trigger trg_excl_ordens before update on ordens
  for each row execute function bloqueia_exclusao_nao_admin();

drop trigger if exists trg_excl_equip on equipamentos;
create trigger trg_excl_equip before update on equipamentos
  for each row execute function bloqueia_exclusao_nao_admin();
