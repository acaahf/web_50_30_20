// js/utils/helpers.js — Utilidades compartidas
// Sanitización XSS, formato monetario (Intl), Stealth Mode, toasts, red y estado UI.

const LOCALE = (typeof navigator !== 'undefined' && navigator.language) || 'es-CO';

/* ------------------------------------------------------------------ */
/* Sanitización XSS                                                    */
/* ------------------------------------------------------------------ */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escapa texto antes de insertarlo en innerHTML o en modales HTML de SweetAlert2. */
export const escapeHTML = (value) => String(value ?? '').replace(/[&<>"'`]/g, (c) => ESC_MAP[c]);

export const normalizeText = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/* ------------------------------------------------------------------ */
/* Dinero (Intl.NumberFormat + aritmética en centavos)                 */
/* ------------------------------------------------------------------ */
const formatterCache = new Map();

function getFormatter(currency, display) {
  const key = `${currency}|${display}`;
  if (!formatterCache.has(key)) {
    let formatter;
    try {
      formatter = new Intl.NumberFormat(LOCALE, { style: 'currency', currency, currencyDisplay: display });
    } catch {
      formatter = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', currencyDisplay: display });
    }
    formatterCache.set(key, formatter);
  }
  return formatterCache.get(key);
}

export const roundMoney = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Suma segura en centavos (evita errores de coma flotante). */
export const sumMoney = (values) =>
  values.reduce((acc, v) => acc + Math.round((Number(v) || 0) * 100), 0) / 100;

/**
 * @param {number} amount
 * @param {string} currency  código ISO 4217
 * @param {'symbol'|'code'} display
 */
export function formatCurrency(amount, currency = 'USD', display = 'symbol') {
  return getFormatter(currency, display).format(roundMoney(amount));
}

/* ------------------------------------------------------------------ */
/* Fechas y períodos                                                   */
/* ------------------------------------------------------------------ */
export const toISODate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function parseISODate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function formatDate(iso) {
  return new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: 'short', year: 'numeric' }).format(parseISODate(iso));
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** @returns {{from:string,to:string,label:string,months:number}} */
export function getPeriodRange(period, ref = new Date()) {
  const y = ref.getFullYear();
  const m = ref.getMonth();
  const monthFmt = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });

  if (period === 'anio') {
    return { from: toISODate(new Date(y, 0, 1)), to: toISODate(new Date(y, 11, 31)), label: `Año ${y}`, months: 12 };
  }
  if (period === 'mes_anterior') {
    const start = new Date(y, m - 1, 1);
    return {
      from: toISODate(start),
      to: toISODate(new Date(y, m, 0)),
      label: capitalize(monthFmt.format(start)),
      months: 1
    };
  }
  const start = new Date(y, m, 1);
  return {
    from: toISODate(start),
    to: toISODate(new Date(y, m + 1, 0)),
    label: capitalize(monthFmt.format(start)),
    months: 1
  };
}

export const debounce = (fn, wait = 200) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
};

/* ------------------------------------------------------------------ */
/* Persistencia de estado en localStorage                              */
/* ------------------------------------------------------------------ */
const uiKey = (userId) => `presupuesto:ui:v1:${userId}`;

export function loadUiState(userId) {
  try {
    return JSON.parse(localStorage.getItem(uiKey(userId)) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

export function saveUiState(userId, state) {
  try {
    localStorage.setItem(uiKey(userId), JSON.stringify(state));
  } catch {
    /* almacenamiento lleno o bloqueado: se ignora */
  }
}

/* ------------------------------------------------------------------ */
/* Modo Sigilo (Stealth Mode)                                          */
/* ------------------------------------------------------------------ */
const STEALTH_KEY = 'presupuesto:stealth';

export function isStealth() {
  try {
    return localStorage.getItem(STEALTH_KEY) === '1';
  } catch {
    return false;
  }
}

export function applyStealth(on = isStealth(), button = null) {
  document.documentElement.classList.toggle('stealth', on);
  if (button) {
    button.textContent = on ? '🙈' : '👁️';
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? 'Desactivar modo privacidad' : 'Activar modo privacidad');
  }
}

export function initStealthToggle(button) {
  applyStealth(isStealth(), button);
  button.addEventListener('click', () => {
    const next = !isStealth();
    try {
      localStorage.setItem(STEALTH_KEY, next ? '1' : '0');
    } catch {
      /* ignorar */
    }
    applyStealth(next, button);
  });
}

/* ------------------------------------------------------------------ */
/* Toasts flotantes (no invasivos; no interfieren con los modales)     */
/* ------------------------------------------------------------------ */
let toastRoot = null;

function getToastRoot() {
  if (!toastRoot?.isConnected) {
    toastRoot = document.createElement('div');
    toastRoot.className = 'toast-container';
    toastRoot.setAttribute('role', 'region');
    toastRoot.setAttribute('aria-live', 'polite');
    toastRoot.setAttribute('aria-label', 'Notificaciones');
    document.body.append(toastRoot);
  }
  return toastRoot;
}

/**
 * @param {string} message
 * @param {{type?:'success'|'error'|'warning'|'info', duration?:number, actionLabel?:string,
 *          onAction?:Function, onClose?:(reason:'action'|'timeout'|'dismiss')=>void}} options
 * @returns {{close:Function}}
 */
export function showToast(message, options = {}) {
  const { type = 'info', duration = 3500, actionLabel, onAction, onClose } = options;
  const icons = { success: '✅', error: '⚠️', warning: '📡', info: 'ℹ️' };

  const el = document.createElement('div');
  el.className = `toast ${type}`;

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = `${icons[type] ?? 'ℹ️'} ${message}`; // textContent: seguro frente a XSS
  el.append(text);

  let closed = false;
  let timer = null;

  const close = (reason = 'dismiss') => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
    onClose?.(reason);
  };

  if (actionLabel) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = actionLabel;
    action.addEventListener('click', () => {
      onAction?.();
      close('action');
    });
    el.append(action);
  } else {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'toast-close';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Cerrar notificación');
    x.addEventListener('click', () => close('dismiss'));
    el.append(x);
  }

  getToastRoot().append(el);
  if (duration > 0) timer = setTimeout(() => close('timeout'), duration);
  return { close };
}

/* ------------------------------------------------------------------ */
/* Errores amigables y control de doble envío                          */
/* ------------------------------------------------------------------ */
export function friendlyError(error) {
  const raw = String(error?.message ?? error ?? '');
  const map = [
    [/failed to fetch|networkerror|network request failed|load failed/i, 'No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.'],
    [/invalid login credentials/i, 'Correo o contraseña incorrectos.'],
    [/email not confirmed/i, 'Tu correo aún no está confirmado. Revisa tu bandeja de entrada.'],
    [/user already registered|already been registered/i, 'Este correo ya está registrado. Inicia sesión.'],
    [/password should be at least/i, 'La contraseña debe tener al menos 6 caracteres.'],
    [/rate limit|too many requests|over_email_send_rate_limit/i, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.'],
    [/row-level security|permission denied|jwt/i, 'No tienes permiso para esta operación. Vuelve a iniciar sesión.'],
    [/duplicate key|23505|ya existe una categor/i, 'Ya existe una categoría con ese nombre.'],
    [/invalid email|unable to validate email/i, 'El correo electrónico no es válido.']
  ];
  for (const [pattern, message] of map) if (pattern.test(raw)) return message;
  return raw || 'Ocurrió un error inesperado.';
}

/** Deshabilita el botón mientras corre la tarea (evita doble submit). */
export async function withLoading(button, task) {
  if (!button) return task();
  if (button.dataset.busy === '1') return undefined;
  button.dataset.busy = '1';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await task();
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

/* ------------------------------------------------------------------ */
/* Manejadores globales de red / errores y Service Worker              */
/* ------------------------------------------------------------------ */
function installGlobalHandlers() {
  if (window.__presupuestoHandlers) return;
  window.__presupuestoHandlers = true;

  let offlineToast = null;

  window.addEventListener('offline', () => {
    offlineToast?.close();
    offlineToast = showToast('Sin conexión a internet. Algunos cambios no se guardarán.', { type: 'warning', duration: 0 });
  });

  window.addEventListener('online', () => {
    offlineToast?.close();
    offlineToast = null;
    showToast('Conexión restablecida.', { type: 'success' });
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('Promesa rechazada sin manejar:', event.reason);
    showToast(friendlyError(event.reason), { type: 'error', duration: 5000 });
    event.preventDefault();
  });

  if (!navigator.onLine) window.dispatchEvent(new Event('offline'));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW no registrado:', err));
  });
}

/* ------------------------------------------------------------------ */
/* Modo Claro / Oscuro (Theme Toggle)                                  */
/* ------------------------------------------------------------------ */
const THEME_KEY = 'presupuesto:theme';

export function getTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme = getTheme(), button = null) {
  document.documentElement.setAttribute('data-theme', theme);
  if (button) {
    button.textContent = theme === 'light' ? '🌙' : '☀️';
    button.setAttribute('aria-label', theme === 'light' ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro');
    button.setAttribute('title', theme === 'light' ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro');
  }
}

export function initThemeToggle(button) {
  applyTheme(getTheme(), button);
  if (!button) return;
  button.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || getTheme();
    const next = current === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignorar */
    }
    applyTheme(next, button);
  });
}

/**
 * Procesa montos con separadores de miles (puntos) y decimales (coma o punto).
 * Ejemplos aceptados:
 * - "1.000"        -> 1000
 * - "50.000"       -> 50000
 * - "1.000.000"    -> 1000000
 * - "1.000.000,50" -> 1000000.5
 */

export function parseMoneyInput(val) {
  if (val === null || val === undefined) return 0;
  let str = String(val).trim().replace(/[^0-9.,-]/g, '');
  if (!str) return 0;

  // 1. Si contiene tanto punto como coma (ej. "1.000.000,50")
  if (str.includes('.') && str.includes(',')) {
    if (str.lastIndexOf(',') > str.lastIndexOf('.')) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  } 
  // 2. Si solo contiene comas (ej. "1000,50")
  else if (str.includes(',') && !str.includes('.')) {
    const parts = str.split(',');
    if (parts.length > 2) {
      str = str.replace(/,/g, '');
    } else {
      str = str.replace(',', '.');
    }
  } 
  // 3. Si solo contiene puntos (ej. "1.000", "50.000", "1.000.000" o "10.50")
  else if (str.includes('.') && !str.includes(',')) {
    const dotCount = (str.match(/\./g) || []).length;
    if (dotCount > 1) {
      str = str.replace(/\./g, '');
    } else {
      const parts = str.split('.');
      // Si tiene exactamente 3 dígitos tras el punto (ej. 1.000 o 50.000), es separador de miles
      if (parts[1].length === 3) {
        str = str.replace('.', '');
      }
    }
  }

  const num = Number(str);
  return isNaN(num) ? 0 : num;
}

installGlobalHandlers();
registerServiceWorker();
