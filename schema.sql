-- =====================================================================
-- schema.sql — Calculadora de Presupuesto 50/30/20 (Supabase / PostgreSQL)
-- Ejecutar completo en: Supabase > SQL Editor (es idempotente)
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1. TABLAS
-- ---------------------------------------------------------------------
create table if not exists public.user_profiles (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  monthly_income numeric(12,2) not null default 0 check (monthly_income >= 0),
  currency       varchar(3)    not null default 'USD',
  updated_at     timestamptz   not null default now()
);

create table if not exists public.categories (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nombre           text not null check (char_length(btrim(nombre)) between 1 and 40),
  categoria_503020 text not null check (categoria_503020 in ('necesidades', 'deseos', 'ahorro')),
  limite_monto     numeric(12,2) null check (limite_monto is null or limite_monto > 0),
  created_at       timestamptz not null default now()
);

alter table public.categories 
  add column if not exists limite_monto numeric(12,2) null check (limite_monto is null or limite_monto > 0);

create table if not exists public.transactions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  concepto          text not null check (char_length(btrim(concepto)) > 0),
  monto             numeric(12,2) not null check (monto > 0),
  tipo              text not null check (tipo in ('ingreso', 'gasto')),
  categoria_503020  text not null check (categoria_503020 in ('necesidades', 'deseos', 'ahorro')),
  categoria_detalle text not null,
  metodo_pago       text not null default 'debito'
                      check (metodo_pago in ('efectivo', 'debito', 'credito', 'transferencia')),
  es_recurrente     boolean not null default false,
  fecha             date not null default current_date,
  created_at        timestamptz not null default now()
);

alter table public.transactions drop constraint if exists transactions_categoria_detalle_check;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_detalle_not_blank') then
    alter table public.transactions
      add constraint transactions_detalle_not_blank check (char_length(btrim(categoria_detalle)) > 0);
  end if;
end $$;

create table if not exists public.savings_goals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nombre         text not null check (char_length(btrim(nombre)) > 0),
  monto_objetivo numeric(12,2) not null check (monto_objetivo > 0),
  monto_actual   numeric(12,2) not null default 0 check (monto_actual >= 0),
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. ÍNDICES DE RENDIMIENTO
-- ---------------------------------------------------------------------
create index if not exists idx_transactions_user_id on public.transactions (user_id);
create index if not exists idx_transactions_fecha   on public.transactions (fecha);
create index if not exists idx_categories_user_id   on public.categories (user_id);
create index if not exists idx_savings_goals_user   on public.savings_goals (user_id);

create unique index if not exists uq_categories_user_nombre
  on public.categories (user_id, lower(btrim(nombre)));

-- ---------------------------------------------------------------------
-- 3. PERMISOS DE ESQUEMA (GRANT)
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant all on all routines in schema public to anon, authenticated;

alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant all on routines to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY (RLS)
-- ---------------------------------------------------------------------
alter table public.user_profiles enable row level security;
alter table public.categories    enable row level security;
alter table public.transactions  enable row level security;
alter table public.savings_goals enable row level security;

-- user_profiles
drop policy if exists "profiles_all_own" on public.user_profiles;
drop policy if exists "profiles_select_own" on public.user_profiles;
drop policy if exists "profiles_insert_own" on public.user_profiles;
drop policy if exists "profiles_update_own" on public.user_profiles;
drop policy if exists "profiles_delete_own" on public.user_profiles;
drop policy if exists "Acceso total para dueño de perfil" on public.user_profiles;

create policy "profiles_all_own" on public.user_profiles
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- categories
drop policy if exists "cat_all_own" on public.categories;
drop policy if exists "cat_select_own" on public.categories;
drop policy if exists "cat_insert_own" on public.categories;
drop policy if exists "cat_update_own" on public.categories;
drop policy if exists "cat_delete_own" on public.categories;
drop policy if exists "Acceso total para dueño de categorias" on public.categories;

create policy "cat_all_own" on public.categories
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- transactions
drop policy if exists "tx_all_own" on public.transactions;
drop policy if exists "tx_select_own" on public.transactions;
drop policy if exists "tx_insert_own" on public.transactions;
drop policy if exists "tx_update_own" on public.transactions;
drop policy if exists "tx_delete_own" on public.transactions;
drop policy if exists "Acceso total para dueño de transacciones" on public.transactions;

create policy "tx_all_own" on public.transactions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- savings_goals
drop policy if exists "goals_all_own" on public.savings_goals;
drop policy if exists "goals_select_own" on public.savings_goals;
drop policy if exists "goals_insert_own" on public.savings_goals;
drop policy if exists "goals_update_own" on public.savings_goals;
drop policy if exists "goals_delete_own" on public.savings_goals;
drop policy if exists "Acceso total para dueño de metas" on public.savings_goals;

create policy "goals_all_own" on public.savings_goals
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 5. TRIGGER AUTOMÁTICO (PERFIL DE USUARIO)
-- ---------------------------------------------------------------------
drop function if exists public.seed_default_categories(uuid);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_touch on public.user_profiles;
create trigger trg_profiles_touch
  before update on public.user_profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 6. REALTIME
-- ---------------------------------------------------------------------
do $$
begin
  begin alter publication supabase_realtime add table public.transactions;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.user_profiles; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.savings_goals; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.categories;    exception when duplicate_object then null; end;
end $$;

-- ---------------------------------------------------------------------
-- 7. USUARIOS EXISTENTES
-- ---------------------------------------------------------------------
insert into public.user_profiles (user_id)
select id from auth.users
on conflict (user_id) do nothing;