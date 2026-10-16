import { supabase } from '../services/supabaseClient.js';

/**
 * Guardian de Autenticación
 * Verifica si hay una sesión activa en Supabase.
 * Si no la hay, frena el código y redirige inmediatamente al login.
 */
export async function requireAuth() {
  const { data: { session }, error } = await supabase.auth.getSession();

  if (error || !session) {
    // Redirigir al inicio de sesión si no hay token o la sesión expiró
    window.location.href = 'index.html';
    return null;
  }

  return session.user;
}

/**
 * Cierra la sesión activa del usuario y limpia la memoria local.
 */
export async function logout() {
  await supabase.auth.signOut();
  window.location.href = 'index.html';
}