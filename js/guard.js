// js/guard.js
import { supabase } from './supabaseClient.js';

async function currentSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message);
  return data?.session ?? null;
}

/** Protege dashboard.html: sin sesión → login.html */
export async function requireSession() {
  let session = null;
  try {
    session = await currentSession();
  } catch {
    session = null;
  }
  if (!session) {
    window.location.replace('./login.html');
    return null;
  }
  return session;
}

/** Para login/register: con sesión activa → dashboard.html */
export async function redirectIfSession() {
  try {
    const session = await currentSession();
    if (session) {
      window.location.replace('./dashboard.html');
      return session;
    }
  } catch {
    /* sin sesión válida: se queda en la página */
  }
  return null;
}