// js/supabaseClient.js — Instancia singleton del cliente Supabase (vía Import Map)
import { createClient } from 'supabase';

export const SUPABASE_URL = 'https://gckpjtilrabiufubpiea.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_AU8Du3akJm_lEUnepJ-qYQ_UIXC2urC';

export const isConfigured =
  !SUPABASE_URL.includes('TU-PROYECTO') && !SUPABASE_ANON_KEY.includes('TU-ANON-KEY');

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: window.localStorage
  },
  realtime: { params: { eventsPerSecond: 5 } }
});

// Asignación global a window para resolver "supabase is not defined" en cualquier ámbito
if (typeof window !== 'undefined') {
  window.supabase = supabase;
}