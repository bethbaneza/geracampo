-- =====================================================================
-- Assist — mostrar QUAL conta do Bling está conectada (nome e CNPJ)
-- Rode no SQL Editor do Supabase, UMA vez. É seguro rodar de novo.
--
-- Acrescenta duas colunas em "empresas" (preenchidas pela sincronização e pela conexão com o Bling)
-- e faz o botão Desconectar limpar essas informações também.
-- NÃO apaga nem altera nenhum dado existente.
-- =====================================================================

alter table empresas add column if not exists bling_conta_nome text;
alter table empresas add column if not exists bling_conta_cnpj text;

create or replace function bling_desconectar() returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not e_admin() then
    raise exception 'Só o administrador pode desconectar o Bling.';
  end if;
  delete from bling_conexoes where empresa_id = minha_empresa();
  update empresas set bling_conectado = false, bling_ultimo_erro = null,
         bling_conta_nome = null, bling_conta_cnpj = null
   where id = minha_empresa();
end $$;
revoke all on function bling_desconectar() from public, anon;
grant execute on function bling_desconectar() to authenticated;

select 'colunas da conta do Bling' as item,
       case when (select count(*) from information_schema.columns
                  where table_name = 'empresas' and column_name in ('bling_conta_nome','bling_conta_cnpj')) = 2
            then 'ok' else 'FALTOU' end as situacao;
