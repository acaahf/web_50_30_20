// js/supabaseClient.js — Instancia singleton del cliente Supabase (vía Import Map)
import { createClient } from 'supabase';

export const SUPABASE_URL = 'https://gckpjtilrabiufubpiea.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_AU8Du3akJm_lEUnepJ-qYQ_UIXC2urC';

export const isConfigured =
  !SUPABASE_URL.includes('TU-PROYECTO') && !SUPABASE_ANON_KEY.includes('TU-ANON-KEY');

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true, // Mantiene la sesión entre cierres del navegador
    autoRefreshToken: true,
    detectSessionInUrl: true, // Procesa el enlace de confirmación de email
    storage: window.localStorage
  },
  realtime: { params: { eventsPerSecond: 5 } }
});