# GeraCampo — Nível 2 de segurança · passo a passo

O que muda: login vira **Supabase Auth** (senhas reais, gerenciadas pelo Supabase),
os dados saem do "blob único" para **tabelas de verdade**, cada linha com `empresa_id`,
e **RLS** garante que ninguém vê os dados de outra empresa nem apaga OS/equipamento
sem ser admin. Tudo no **plano grátis**.

Durante a transição o app antigo continua funcionando (ele usa `geracampo_estado`,
que não é tocado). Você só troca de app quando eu te entregar o `index.html` novo.

---

## PASSO A — criar a estrutura (você faz agora)

1. Supabase → projeto **geracampo** → menu lateral **SQL Editor** → **New query**.
2. Abra o arquivo **`supabase-nivel2.sql`**, copie **tudo até a linha "PARE AQUI"**.
3. Cole no editor → **Run**.
4. Deve terminar com "Success". Se aparecer erro sobre **`pg_cron`**:
   - Database → **Extensions** → procure `pg_cron` → ative → rode o SQL de novo.
5. Confira em **Database → Tables**: devem existir `empresas`, `perfis`, `clientes`,
   `equipamentos`, `ordens`, `manutencoes`, `veiculos`, `despesas`, `preventivas`,
   `produtos`, `solicitacoes_peca`, `jornadas`, `campos_tecnicos`, `config_empresa`,
   `auditoria`, `backup_diario` — todas com o selo **RLS enabled**.

## PASSO B — criar o 1º usuário (= administrador)

6. Menu lateral **Authentication → Users → Add user → Create new user**.
7. Preencha:
   - **Email**: o seu e-mail (ex.: `bandamunicipalplis@gmail.com`)
   - **Password**: uma senha forte
   - **Auto Confirm User**: **LIGADO** ✅ (assim não precisa de e-mail de confirmação)
8. **Create user**.
9. O primeiro usuário criado vira **admin** automaticamente e cria a "empresa".
   Confira: SQL Editor → `select * from perfis;` → deve ter 1 linha, papel `admin`.

## PASSO C — copiar os dados atuais

10. SQL Editor → **New query** → cole **o bloco final** do arquivo
    (a parte marcada **"MIGRAÇÃO"**, depois da linha "PARE AQUI").
11. **Run**. Deve dizer "Migração concluída para a empresa ...".
12. Confira: `select count(*) from clientes;` (e outras tabelas) — devem ter os
    registros que estavam no app.

## PASSO D — me avise

13. Responda **"Nível 2 pronto"** e me diga o **e-mail do admin** que você criou.
    Eu te devolvo o `index.html` novo (Supabase Auth + tabelas). Aí você faz
    `git push` e o site passa a usar o modelo seguro.

## PASSO E — depois que o app novo estiver no ar (não faça agora)

- Criar os demais usuários: **Authentication → Add user** (Auto Confirm ligado).
  No app, o admin ajusta nome e nível (técnico/admin) de cada um.
- Quando tudo estiver ok, pode apagar a tabela velha:
  `drop table geracampo_estado;`
- Rodar de novo **Advisors → Security Advisor** — o aviso "RLS Always True" deve sumir.

---

## Perguntas rápidas

**Precisa de e-mail configurado?** Não, se o admin criar cada usuário com
"Auto Confirm User" ligado. Só precisaria para "esqueci minha senha" — e aí é
plugar um SMTP grátis depois.

**Restaurar um backup:**
```sql
-- vê os backups disponíveis
select feito_em from backup_diario order by feito_em desc;
-- restaura uma tabela (ex.: clientes) da cópia mais recente
truncate clientes;
insert into clientes select * from jsonb_populate_recordset(null::clientes,
  (select dados->'clientes' from backup_diario order by feito_em desc limit 1));
```

**A chave anon agora pode ficar no código/GitHub?** Sim. Com RLS ativo, a chave
sozinha não dá acesso a nada — é preciso um login válido. Esse é o padrão do Supabase.
