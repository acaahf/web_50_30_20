// js/services/categoryService.js — CRUD de categorías personalizadas (Supabase)
import { supabase } from '../supabaseClient.js';

export const PILLARS = ['necesidades', 'deseos', 'ahorro'];
export const MAX_NAME_LENGTH = 40;

/** Categorías iniciales por defecto. */
export const DEFAULT_CATEGORIES = [
  { nombre: 'Vivienda', categoria_503020: 'necesidades', limite_monto: null },
  { nombre: 'Alimentación', categoria_503020: 'necesidades', limite_monto: null },
  { nombre: 'Transporte', categoria_503020: 'necesidades', limite_monto: null },
  { nombre: 'Salud', categoria_503020: 'necesidades', limite_monto: null },
  { nombre: 'Ocio', categoria_503020: 'deseos', limite_monto: null },
  { nombre: 'Restaurantes', categoria_503020: 'deseos', limite_monto: null },
  { nombre: 'Inversión', categoria_503020: 'ahorro', limite_monto: null },
  { nombre: 'Fondo de Emergencia', categoria_503020: 'ahorro', limite_monto: null }
];

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function fail(error, fallback) {
  if (error?.code === '23505') throw new Error('Ya existe una categoría con ese nombre.');
  throw new Error(error?.message ?? fallback);
}

function clean({ nombre, categoria_503020, limite_monto }) {
  const name = String(nombre ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Escribe un nombre para la categoría.');
  if (name.length > MAX_NAME_LENGTH) throw new Error(`El nombre no puede superar ${MAX_NAME_LENGTH} caracteres.`);
  if (!PILLARS.includes(categoria_503020)) throw new Error('Selecciona un pilar válido (50/30/20).');

  let limit = null;
  if (limite_monto !== undefined && limite_monto !== null && String(limite_monto).trim() !== '') {
    const num = Number(limite_monto);
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error('El límite de gasto debe ser un número positivo mayor a 0.');
    }
    limit = Number(num.toFixed(2));
  }

  return { nombre: name, categoria_503020, limite_monto: limit };
}

export async function listCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('id, nombre, categoria_503020, limite_monto, created_at')
    .order('nombre', { ascending: true });
  if (error) fail(error, 'No se pudieron cargar las categorías');
  return data ?? [];
}

export async function createCategory(input) {
  const { data, error } = await supabase.from('categories').insert(clean(input)).select().single();
  if (error) fail(error, 'No se pudo crear la categoría');
  return data;
}

export async function updateCategory(id, input) {
  const next = clean(input);

  const current = await supabase.from('categories').select('nombre').eq('id', id).single();
  if (current.error) fail(current.error, 'No se encontró la categoría');
  const previousName = current.data?.nombre;

  const { data, error } = await supabase.from('categories').update(next).eq('id', id).select().single();
  if (error) fail(error, 'No se pudo actualizar la categoría');

  if (previousName && previousName !== next.nombre) {
    const renamed = await supabase
      .from('transactions')
      .update({ categoria_detalle: next.nombre })
      .eq('categoria_detalle', previousName);
    if (renamed.error) {
      throw new Error(`La categoría se actualizó, pero no se pudo renombrar en el historial: ${renamed.error.message}`);
    }
  }
  return data;
}

export async function deleteCategory(id) {
  const { error } = await supabase.from('categories').delete().eq('id', id);
  if (error) fail(error, 'No se pudo eliminar la categoría');
}

export async function seedDefaults() {
  const existing = await listCategories();
  const names = new Set(existing.map((c) => c.nombre.trim().toLowerCase()));
  const missing = DEFAULT_CATEGORIES.filter((c) => !names.has(c.nombre.toLowerCase()));
  if (!missing.length) return 0;

  const { error } = await supabase.from('categories').insert(missing);
  if (error) fail(error, 'No se pudieron restaurar las categorías');
  return missing.length;
}

export async function resetDefaults() {
  const removed = await supabase.from('categories').delete().neq('id', NIL_UUID);
  if (removed.error) fail(removed.error, 'No se pudieron limpiar las categorías');

  const { error } = await supabase.from('categories').insert(DEFAULT_CATEGORIES);
  if (error) fail(error, 'No se pudieron restablecer las categorías');
  return DEFAULT_CATEGORIES.length;
}