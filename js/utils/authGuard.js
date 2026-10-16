// js/utils/authGuard.js — Guardián de Autenticación
import { supabase } from '../supabaseClient.js';

/**
 * Guardián de Autenticación
 * Verifica si hay una sesión activa en Supabase.
 * Si no la hay, frena el código y redirige inmediatamente al login.
 */
export async function requireAuth() {
  const { data: { session }, error } = await supabase.auth.getSession();

  if (error || !session) {
    // Redirigir al inicio si no hay token o la sesión expiró
    window.location.replace('./index.html');
    return null;
  }

  return session.user;
}

/**
 * Cierra la sesión activa del usuario y limpia la memoria local.
 */
export async function logout() {
  await supabase.auth.signOut();
  window.location.replace('./index.html');
}