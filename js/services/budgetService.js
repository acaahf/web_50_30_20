// js/services/budgetService.js — Repositorio/Servicio de presupuesto (Supabase)
import { supabase } from '../supabaseClient.js';
import { toISODate, roundMoney } from '../utils/helpers.js';

const PAGE = 1000;

function fail(error, fallback) {
  throw new Error(error?.message ?? fallback);
}

const num = (v) => Number(v ?? 0);

const normalizeTx = (t) => ({ ...t, monto: num(t.monto) });
const normalizeGoal = (g) => ({ ...g, monto_objetivo: num(g.monto_objetivo), monto_actual: num(g.monto_actual) });
const normalizeDebt = (d) => ({ ...d, monto_total: num(d.monto_total), monto_pagado: num(d.monto_pagado) });

/* ------------------------------ Perfil ------------------------------ */

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('user_id, monthly_income, currency, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) fail(error, 'No se pudo cargar el perfil');

  if (data) return { ...data, monthly_income: num(data.monthly_income) };

  const created = await supabase
    .from('user_profiles')
    .upsert({ user_id: userId }, { onConflict: 'user_id' })
    .select('user_id, monthly_income, currency, updated_at')
    .single();
  if (created.error) fail(created.error, 'No se pudo crear el perfil');
  return { ...created.data, monthly_income: num(created.data.monthly_income) };
}

export async function updateProfile(userId, { monthly_income, currency }) {
  const { data, error } = await supabase
    .from('user_profiles')
    .upsert(
      { user_id: userId, monthly_income: roundMoney(monthly_income), currency, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    .select('user_id, monthly_income, currency, updated_at')
    .single();
  if (error) fail(error, 'No se pudo guardar el ingreso');
  return { ...data, monthly_income: num(data.monthly_income) };
}

/* --------------------------- Transacciones -------------------------- */

export async function listTransactions(fromDate) {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .gte('fecha', fromDate)
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) fail(error, 'No se pudieron cargar las transacciones');
    all.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) break;
  }
  return all.map(normalizeTx);
}

export async function createTransaction(payload) {
  const { data, error } = await supabase.from('transactions').insert(payload).select().single();
  if (error) fail(error, 'No se pudo guardar la transacción');
  return normalizeTx(data);
}

export async function updateTransaction(id, changes) {
  const { data, error } = await supabase.from('transactions').update(changes).eq('id', id).select().single();
  if (error) fail(error, 'No se pudo actualizar la transacción');
  return normalizeTx(data);
}

export async function deleteTransaction(id) {
  const { error } = await supabase.from('transactions').delete().eq('id', id);
  if (error) fail(error, 'No se pudo eliminar la transacción');
}

export async function getSavingsTotal() {
  let cents = 0;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('transactions')
      .select('monto')
      .eq('categoria_503020', 'ahorro')
      .eq('tipo', 'gasto')
      .range(offset, offset + PAGE - 1);
    if (error) fail(error, 'No se pudo calcular el ahorro acumulado');
    cents += (data ?? []).reduce((acc, r) => acc + Math.round(num(r.monto) * 100), 0);
    if ((data?.length ?? 0) < PAGE) break;
  }
  return cents / 100;
}

export async function cloneRecurringExpenses(ref = new Date()) {
  const y = ref.getFullYear();
  const m = ref.getMonth();
  const prevFrom = toISODate(new Date(y, m - 1, 1));
  const prevTo = toISODate(new Date(y, m, 0));
  const curFrom = toISODate(new Date(y, m, 1));
  const curTo = toISODate(new Date(y, m + 1, 0));
  const lastDay = new Date(y, m + 1, 0).getDate();

  const [prevRes, curRes] = await Promise.all([
    supabase
      .from('transactions')
      .select('concepto, monto, tipo, categoria_503020, categoria_detalle, metodo_pago, es_recurrente, fecha')
      .eq('es_recurrente', true)
      .eq('tipo', 'gasto')
      .gte('fecha', prevFrom)
      .lte('fecha', prevTo),
    supabase
      .from('transactions')
      .select('concepto, monto, categoria_503020, categoria_detalle')
      .gte('fecha', curFrom)
      .lte('fecha', curTo)
  ]);
  if (prevRes.error) fail(prevRes.error, 'No se pudieron leer los gastos recurrentes');
  if (curRes.error) fail(curRes.error, 'No se pudo revisar el mes actual');

  const keyOf = (t) =>
    `${String(t.concepto).trim().toLowerCase()}|${num(t.monto).toFixed(2)}|${t.categoria_503020}|${t.categoria_detalle}`;
  const existing = new Set((curRes.data ?? []).map(keyOf));

  const rows = [];
  for (const t of prevRes.data ?? []) {
    if (existing.has(keyOf(t))) continue;
    existing.add(keyOf(t));
    const day = Math.min(Number(t.fecha.slice(8, 10)) || 1, lastDay);
    rows.push({
      concepto: t.concepto,
      monto: num(t.monto),
      tipo: 'gasto',
      categoria_503020: t.categoria_503020,
      categoria_detalle: t.categoria_detalle,
      metodo_pago: t.metodo_pago,
      es_recurrente: true,
      fecha: toISODate(new Date(y, m, day))
    });
  }

  const total = prevRes.data?.length ?? 0;
  if (!rows.length) return { created: 0, skipped: total };

  const { error } = await supabase.from('transactions').insert(rows);
  if (error) fail(error, 'No se pudieron copiar los gastos recurrentes');
  return { created: rows.length, skipped: total - rows.length };
}

/* ------------------------------- Metas ------------------------------ */

export async function listGoals() {
  const { data, error } = await supabase.from('savings_goals').select('*').order('created_at', { ascending: true });
  if (error) fail(error, 'No se pudieron cargar las metas');
  return (data ?? []).map(normalizeGoal);
}

export async function createGoal({ nombre, monto_objetivo }) {
  const { data, error } = await supabase
    .from('savings_goals')
    .insert({ nombre: nombre.trim(), monto_objetivo: roundMoney(monto_objetivo) })
    .select()
    .single();
  if (error) fail(error, 'No se pudo crear la meta');
  return normalizeGoal(data);
}

export async function updateGoal(id, { nombre, monto_objetivo }) {
  const { data, error } = await supabase
    .from('savings_goals')
    .update({ nombre: nombre.trim(), monto_objetivo: roundMoney(monto_objetivo) })
    .eq('id', id)
    .select()
    .single();
  if (error) fail(error, 'No se pudo actualizar la meta');
  return normalizeGoal(data);
}

export async function updateGoalProgress(id, monto_actual) {
  const { error } = await supabase.from('savings_goals').update({ monto_actual: roundMoney(monto_actual) }).eq('id', id);
  if (error) fail(error, 'No se pudo sincronizar la meta');
}

export async function deleteGoal(id) {
  const { error } = await supabase.from('savings_goals').delete().eq('id', id);
  if (error) fail(error, 'No se pudo eliminar la meta');
}

/* ------------------------------- Deudas ------------------------------ */

export async function listDebts() {
  const { data, error } = await supabase.from('debts').select('*').order('created_at', { ascending: true });
  if (error) fail(error, 'No se pudieron cargar las deudas');
  return (data ?? []).map(normalizeDebt);
}

export async function createDebt({ nombre, monto_total, monto_pagado = 0 }) {
  const { data, error } = await supabase
    .from('debts')
    .insert({ nombre: nombre.trim(), monto_total: roundMoney(monto_total), monto_pagado: roundMoney(monto_pagado) })
    .select()
    .single();
  if (error) fail(error, 'No se pudo crear la deuda');
  return normalizeDebt(data);
}

export async function updateDebt(id, { nombre, monto_total, monto_pagado }) {
  const { data, error } = await supabase
    .from('debts')
    .update({ nombre: nombre.trim(), monto_total: roundMoney(monto_total), monto_pagado: roundMoney(monto_pagado) })
    .eq('id', id)
    .select()
    .single();
  if (error) fail(error, 'No se pudo actualizar la deuda');
  return normalizeDebt(data);
}

export async function deleteDebt(id) {
  const { error } = await supabase.from('debts').delete().eq('id', id);
  if (error) fail(error, 'No se pudo eliminar la deuda');
}

/* ----------------------------- Tiempo real --------------------------- */

export function subscribeToChanges(userId, onChange) {
  const channel = supabase.channel(`presupuesto-${userId}`);
  for (const table of ['transactions', 'savings_goals', 'user_profiles', 'categories', 'debts']) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` }, (payload) =>
      onChange?.(table, payload)
    );
  }
  channel.subscribe();
  return channel;
}

export async function unsubscribe(channel) {
  if (channel) await supabase.removeChannel(channel);
}