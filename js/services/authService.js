// js/services/authService.js — Servicio de autenticación
import { supabase } from '../supabaseClient.js';

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message);
  return data?.session ?? null;
}

/**
 * Registra un usuario.
 * @returns {{user, session, needsConfirmation: boolean}}
 */
export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: new URL('./login.html', window.location.href).href }
  });
  if (error) throw new Error(error.message);

  // Con confirmación de email activa, un correo ya registrado devuelve identities vacío (sin error)
  if (data?.user && (data.user.identities?.length ?? 1) === 0) {
    throw new Error('User already registered');
  }

  return {
    user: data?.user ?? null,
    session: data?.session ?? null,
    needsConfirmation: !data?.session
  };
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) {
    // Sin red o token inválido: al menos limpia la sesión local
    const { error: localError } = await supabase.auth.signOut({ scope: 'local' });
    if (localError) throw new Error(localError.message);
  }
}

/** Suscripción a cambios de sesión. Devuelve la función para cancelar. */
export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => callback(event, session));
  return () => data?.subscription?.unsubscribe();
}
