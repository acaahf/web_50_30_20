-- =====================================================================
-- schema.sql — Calculadora de Presupuesto 50/30/20 (Supabase / PostgreSQL)
-- Ejecutar completo en: Supabase > SQL Editor (es idempotente: se puede repetir)
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

-- Categorías personalizadas por usuario (creadas y gestionadas 100% desde la web)
create table if not exists public.categories (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nombre           text not null check (char_length(btrim(nombre)) between 1 and 40),
  categoria_503020 text not null check (categoria_503020 in ('necesidades', 'deseos', 'ahorro')),
  created_at       timestamptz not null default now()
);

create table if not exists public.transactions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  concepto          text not null check (char_length(btrim(concepto)) > 0),
  monto             numeric(12,2) not null check (monto > 0),
  tipo              text not null check (tipo in ('ingreso', 'gasto')),
  categoria_503020  text not null check (categoria_503020 in ('necesidades', 'deseos', 'ahorro')),
  categoria_detalle text not null,  -- Nombre de la categoría (texto libre dinámico)
  metodo_pago       text not null default 'debito'
                      check (metodo_pago in ('efectivo', 'debito', 'credito', 'transferencia')),
  es_recurrente     boolean not null default false,
  fecha             date not null default current_date,
  created_at        timestamptz not null default now()
);

-- Migración desde la versión con categorías fijas: se elimina el CHECK con la lista cerrada
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

-- Nombre único por usuario (sin distinguir mayúsculas/minúsculas)
create unique index if not exists uq_categories_user_nombre
  on public.categories (user_id, lower(btrim(nombre)));

-- ---------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY (auth.uid() = user_id en todas las tablas)
-- ---------------------------------------------------------------------
alter table public.user_profiles enable row level security;
alter table public.categories    enable row level security;
alter table public.transactions  enable row level security;
alter table public.savings_goals enable row level security;

-- user_profiles
drop policy if exists "profiles_select_own" on public.user_profiles;
drop policy if exists "profiles_insert_own" on public.user_profiles;
drop policy if exists "profiles_update_own" on public.user_profiles;
drop policy if exists "profiles_delete_own" on public.user_profiles;
create policy "profiles_select_own" on public.user_profiles for select using (auth.uid() = user_id);
create policy "profiles_insert_own" on public.user_profiles for insert with check (auth.uid() = user_id);
create policy "profiles_update_own" on public.user_profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "profiles_delete_own" on public.user_profiles for delete using (auth.uid() = user_id);

-- categories
drop policy if exists "cat_select_own" on public.categories;
drop policy if exists "cat_insert_own" on public.categories;
drop policy if exists "cat_update_own" on public.categories;
drop policy if exists "cat_delete_own" on public.categories;
create policy "cat_select_own" on public.categories for select using (auth.uid() = user_id);
create policy "cat_insert_own" on public.categories for insert with check (auth.uid() = user_id);
create policy "cat_update_own" on public.categories for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "cat_delete_own" on public.categories for delete using (auth.uid() = user_id);

-- transactions
drop policy if exists "tx_select_own" on public.transactions;
drop policy if exists "tx_insert_own" on public.transactions;
drop policy if exists "tx_update_own" on public.transactions;
drop policy if exists "tx_delete_own" on public.transactions;
create policy "tx_select_own" on public.transactions for select using (auth.uid() = user_id);
create policy "tx_insert_own" on public.transactions for insert with check (auth.uid() = user_id);
create policy "tx_update_own" on public.transactions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "tx_delete_own" on public.transactions for delete using (auth.uid() = user_id);

-- savings_goals
drop policy if exists "goals_select_own" on public.savings_goals;
drop policy if exists "goals_insert_own" on public.savings_goals;
drop policy if exists "goals_update_own" on public.savings_goals;
drop policy if exists "goals_delete_own" on public.savings_goals;
create policy "goals_select_own" on public.savings_goals for select using (auth.uid() = user_id);
create policy "goals_insert_own" on public.savings_goals for insert with check (auth.uid() = user_id);
create policy "goals_update_own" on public.savings_goals for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "goals_delete_own" on public.savings_goals for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 4. TRIGGER AUTOMÁTICO on_auth_user_created (SOLO PERFIL DE USUARIO)
-- ---------------------------------------------------------------------
-- Remueve la función obsoleta si fue creada previamente
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

-- Actualiza updated_at automáticamente
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
-- 5. REALTIME (suscripciones desde el cliente)
-- ---------------------------------------------------------------------
do $$
begin
  begin alter publication supabase_realtime add table public.transactions;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.user_profiles; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.savings_goals; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.categories;    exception when duplicate_object then null; end;
end $$;

-- ---------------------------------------------------------------------
-- 6. USUARIOS EXISTENTES (creados antes de este script)
-- ---------------------------------------------------------------------
insert into public.user_profiles (user_id)
select id from auth.users
on conflict (user_id) do nothing;