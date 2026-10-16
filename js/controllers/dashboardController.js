// js/controllers/dashboardController.js — Panel principal (Dashboard)
import Swal from 'sweetalert2';
import { supabase } from '../supabaseClient.js';
import { requireAuth } from '../utils/authGuard.js';
import { signOut, onAuthChange } from '../services/authService.js';
import * as budget from '../services/budgetService.js';
import * as catService from '../services/categoryService.js';
import * as security from '../services/securityService.js';
import { renderBudgetChart, destroyChart } from '../utils/chartManager.js';
import { exportCSV } from '../utils/csvExport.js';
import {
  debounce,
  escapeHTML,
  formatCurrency,
  formatDate,
  friendlyError,
  getPeriodRange,
  initStealthToggle,
  loadUiState,
  normalizeText,
  roundMoney,
  saveUiState,
  showToast,
  sumMoney,
  toISODate,
  withLoading
} from '../utils/helpers.js';

/* ------------------------------ Constantes ------------------------------ */
const RULES = {
  necesidades: { label: 'Necesidades', pct: 50, color: '#0284c7' },
  deseos: { label: 'Deseos', pct: 30, color: '#9333ea' },
  ahorro: { label: 'Ahorro', pct: 20, color: '#16a34a' }
};
const RULE_KEYS = Object.keys(RULES);
const METHODS = { efectivo: 'Efectivo', debito: 'Débito', credito: 'Crédito', transferencia: 'Transferencia' };
const CURRENCIES = ['USD', 'EUR', 'COP', 'MXN', 'ARS', 'CLP', 'PEN', 'BRL', 'UYU', 'BOB', 'PYG', 'GTQ', 'CRC', 'DOP', 'GBP', 'CAD'];
const PERIODS = ['mes_actual', 'mes_anterior', 'anio'];
const MAX_AMOUNT = 9999999999.99;

const DEFAULT_UI = {
  rule: 'todas',
  category: 'todas',
  method: 'todos',
  period: 'mes_actual',
  search: '',
  page: 1,
  pageSize: 10,
  sortKey: 'fecha',
  sortDir: 'desc'
};

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  user: null,
  profile: { monthly_income: 0, currency: 'USD' },
  transactions: [],
  categories: [],
  goals: [],
  debts: [],
  savingsTotal: 0,
  onboardingShown: false,
  ui: { ...DEFAULT_UI },
  channel: null,
  pending: new Set(),
  loaded: false,
  unsubAuth: null
};

const fmt = (value) => formatCurrency(value, state.profile.currency);

function sanitizeUi(raw = {}) {
  const ui = { ...DEFAULT_UI };
  if (['todas', ...RULE_KEYS].includes(raw.rule)) ui.rule = raw.rule;
  if (['todos', ...Object.keys(METHODS)].includes(raw.method)) ui.method = raw.method;
  if (typeof raw.category === 'string' && raw.category.length > 0 && raw.category.length <= 60) ui.category = raw.category;
  if (PERIODS.includes(raw.period)) ui.period = raw.period;
  if (typeof raw.search === 'string') ui.search = raw.search.slice(0, 100);
  if ([5, 10].includes(Number(raw.pageSize))) ui.pageSize = Number(raw.pageSize);
  const page = Number(raw.page);
  if (Number.isInteger(page) && page >= 1) ui.page = page;
  if (['fecha', 'monto'].includes(raw.sortKey)) ui.sortKey = raw.sortKey;
  if (['asc', 'desc'].includes(raw.sortDir)) ui.sortDir = raw.sortDir;
  return ui;
}

const persistUi = () => state.user && saveUiState(state.user.id, state.ui);

/* ------------------------------ PWA & Accesos Rápidos ------------------------------ */
let deferredPrompt = null;

function setupPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  const installBtn = $('#btn-install-pwa');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        installBtn.hidden = true;
      }
      deferredPrompt = null;
    });
  }
}

function checkQuickActions() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('action') === 'add') {
    window.history.replaceState({}, document.title, window.location.pathname);
    openTransactionModal();
  }
}

/* ------------------------------ Bloqueo por PIN y Biometría ------------------------------ */
let inactivityTimer = null;

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (state.user && security.hasPinConfigured(state.user.id)) {
    inactivityTimer = setTimeout(() => triggerLockScreen(), 5 * 60 * 1000);
  }
}

function triggerLockScreen() {
  if (!state.user || !security.hasPinConfigured(state.user.id)) {
    return showToast('Primero configura un PIN en el ícono ⚙️ para habilitar el bloqueo.', { type: 'info' });
  }
  security.lockScreen(state.user.id);
  showLockOverlay();
}

function showLockOverlay() {
  if (document.getElementById('lock-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'lock-overlay';
  overlay.className = 'lock-overlay';

  const hasBio = security.hasBiometricsConfigured(state.user.id);

  overlay.innerHTML = `
    <div class="lock-card">
      <h2>🔒 App Bloqueada</h2>
      <p style="font-size: 0.85rem; margin-top: 0.25rem;">Ingresa tu PIN de 4 dígitos</p>
      
      <div class="pin-display">
        <span class="pin-dot" id="dot-0"></span>
        <span class="pin-dot" id="dot-1"></span>
        <span class="pin-dot" id="dot-2"></span>
        <span class="pin-dot" id="dot-3"></span>
      </div>

      <div class="pin-pad">
        <button class="btn ghost" data-num="1">1</button>
        <button class="btn ghost" data-num="2">2</button>
        <button class="btn ghost" data-num="3">3</button>
        <button class="btn ghost" data-num="4">4</button>
        <button class="btn ghost" data-num="5">5</button>
        <button class="btn ghost" data-num="6">6</button>
        <button class="btn ghost" data-num="7">7</button>
        <button class="btn ghost" data-num="8">8</button>
        <button class="btn ghost" data-num="9">9</button>
        <button class="btn ghost danger" id="btn-pin-clear">⌫</button>
        <button class="btn ghost" data-num="0">0</button>
        ${hasBio ? '<button class="btn ghost success" id="btn-bio-unlock" title="Desbloquear con Huella/FaceID">👆</button>' : '<div></div>'}
      </div>

      <div style="margin-top: 1.5rem;">
        <button class="btn ghost small danger" id="btn-lock-logout">Cerrar sesión</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  let enteredPin = '';

  const updateDots = () => {
    for (let i = 0; i < 4; i++) {
      const dot = document.getElementById(`dot-${i}`);
      if (dot) dot.classList.toggle('filled', i < enteredPin.length);
    }
  };

  const handleNum = async (num) => {
    if (enteredPin.length < 4) {
      enteredPin += num;
      updateDots();
    }
    if (enteredPin.length === 4) {
      const valid = await security.verifyPin(state.user.id, enteredPin);
      if (valid) {
        security.unlockScreen(state.user.id);
        overlay.remove();
        showToast('Pantalla desbloqueada', { type: 'success' });
      } else {
        showToast('PIN incorrecto', { type: 'error' });
        enteredPin = '';
        updateDots();
      }
    }
  };

  overlay.querySelectorAll('[data-num]').forEach((btn) => {
    btn.addEventListener('click', () => handleNum(btn.dataset.num));
  });

  document.getElementById('btn-pin-clear')?.addEventListener('click', () => {
    enteredPin = enteredPin.slice(0, -1);
    updateDots();
  });

  document.getElementById('btn-lock-logout')?.addEventListener('click', async () => {
    overlay.remove();
    await teardown();
    await signOut();
    window.location.replace('./index.html');
  });

  const tryBio = async () => {
    try {
      const success = await security.verifyBiometrics(state.user.id);
      if (success) {
        security.unlockScreen(state.user.id);
        overlay.remove();
        showToast('Desbloqueado con biometría', { type: 'success' });
      }
    } catch {
      showToast('Error de biometría', { type: 'error' });
    }
  };

  if (hasBio) {
    document.getElementById('btn-bio-unlock')?.addEventListener('click', tryBio);
    tryBio();
  }
}

async function openSecurityModal() {
  const hasPin = security.hasPinConfigured(state.user.id);
  const hasBio = security.hasBiometricsConfigured(state.user.id);
  const bioSupported = await security.isBiometricsSupported();

  const result = await Swal.fire({
    title: '⚙️ Seguridad y PIN',
    background: 'var(--surface)',
    color: 'var(--text)',
    html: `
      <div style="text-align: left; display: flex; flex-direction: column; gap: 1rem;">
        <p style="font-size: 0.85rem;">Configura un PIN de 4 dígitos para bloquear tu pantalla rápidamente o por inactividad.</p>

        <label for="swal-pin-input">
          ${hasPin ? 'Cambiar PIN (4 dígitos)' : 'Crear PIN de 4 dígitos'}
          <input id="swal-pin-input" type="password" maxlength="4" inputmode="numeric" placeholder="****" style="margin-top: 0.25rem;">
        </label>

        ${
          bioSupported
            ? `<div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.05); padding: 0.75rem; border-radius: 8px;">
                <span>👆 Huella / FaceID</span>
                <button class="btn small ${hasBio ? 'danger' : 'primary'}" type="button" id="btn-toggle-bio">
                  ${hasBio ? 'Desactivar' : 'Activar'}
                </button>
               </div>`
            : ''
        }

        ${
          hasPin
            ? `<button class="btn small danger" type="button" id="btn-remove-security" style="margin-top: 0.5rem;">
                Eliminar PIN y Protección
               </button>`
            : ''
        }
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: 'Guardar PIN',
    cancelButtonText: 'Cancelar',
    didOpen: (popup) => {
      popup.querySelector('#btn-toggle-bio')?.addEventListener('click', async () => {
        try {
          if (hasBio) {
            localStorage.removeItem(`budget_bio_cred_${state.user.id}`);
            showToast('Biometría desactivada', { type: 'info' });
            Swal.close();
          } else {
            const ok = await security.registerBiometrics(state.user.id, state.user.email);
            if (ok) {
              showToast('Biometría configurada correctamente', { type: 'success' });
              Swal.close();
            }
          }
        } catch (err) {
          showToast(err.message, { type: 'error' });
        }
      });

      popup.querySelector('#btn-remove-security')?.addEventListener('click', () => {
        security.removeSecurity(state.user.id);
        showToast('Seguridad eliminada', { type: 'info' });
        Swal.close();
      });
    },
    preConfirm: async () => {
      const pin = document.getElementById('swal-pin-input').value;
      if (!pin) {
        if (!hasPin) return Swal.showValidationMessage('Escribe un PIN de 4 dígitos.');
        return true;
      }
      try {
        await security.setPin(state.user.id, pin);
        return true;
      } catch (err) {
        return Swal.showValidationMessage(err.message);
      }
    }
  });

  if (result.isConfirmed) {
    showToast('Ajustes de seguridad actualizados', { type: 'success' });
  }
}

/* ------------------------------ Cálculos ------------------------------ */
const visibleTransactions = () => state.transactions.filter((t) => !state.pending.has(t.id));

function sortRows(rows) {
  const { sortKey, sortDir } = state.ui;
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp;
    if (sortKey === 'monto') cmp = a.monto - b.monto;
    else cmp = a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0;
    if (cmp === 0) cmp = String(a.created_at).localeCompare(String(b.created_at));
    return cmp * dir;
  });
}

function computeSummary() {
  const range = getPeriodRange(state.ui.period);
  const rows = visibleTransactions().filter((t) => t.fecha >= range.from && t.fecha <= range.to);
  const baseIncome = state.profile.monthly_income;
  const income = roundMoney(baseIncome * range.months);
  const gastos = rows.filter((t) => t.tipo === 'gasto');
  const extraIncome = sumMoney(rows.filter((t) => t.tipo === 'ingreso').map((t) => t.monto));

  const categories = RULE_KEYS.map((key) => {
    const assigned = roundMoney((income * RULES[key].pct) / 100);
    const spent = sumMoney(gastos.filter((t) => t.categoria_503020 === key).map((t) => t.monto));
    return {
      key,
      label: RULES[key].label,
      pct: RULES[key].pct,
      assigned,
      spent,
      diff: roundMoney(assigned - spent),
      usage: assigned > 0 ? (spent / assigned) * 100 : 0,
      over: assigned > 0 && spent > assigned
    };
  });

  return {
    range,
    rows,
    income,
    extraIncome,
    categories,
    totalSpent: sumMoney(gastos.map((t) => t.monto)),
    locked: baseIncome <= 0
  };
}

function allocateGoals() {
  let remaining = state.savingsTotal;
  return state.goals.map((goal) => {
    const assigned = Math.min(remaining, goal.monto_objetivo);
    remaining = roundMoney(remaining - assigned);
    return { ...goal, progress: roundMoney(assigned) };
  });
}

/* ------------------------------ Render ------------------------------ */
function setKpi(id, { value, cap, left, pct, over }) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('skeleton');
  const valEl = $('[data-field="value"]', el);
  if (valEl) valEl.textContent = value;
  const capEl = $('[data-field="cap"]', el);
  if (capEl) capEl.textContent = cap;
  const leftEl = $('[data-field="left"]', el);
  if (leftEl) {
    leftEl.textContent = left;
    leftEl.classList.toggle('over', over);
  }

  const bar = $('.progress', el);
  if (bar) {
    const clamped = Math.min(Math.max(pct, 0), 100);
    bar.style.setProperty('--pct', `${clamped.toFixed(1)}%`);
    bar.classList.toggle('over', over);
    bar.setAttribute('aria-valuenow', String(Math.round(clamped)));
  }
}

function renderKpis(summary) {
  const onb = $('#onboarding');
  if (onb) onb.hidden = !summary.locked;

  const incomeBase = summary.income + summary.extraIncome;
  const incomeOver = !summary.locked && summary.totalSpent > incomeBase;
  setKpi('kpi-income', {
    value: fmt(summary.income),
    cap: `Ingresos extra registrados: ${fmt(summary.extraIncome)}`,
    left: summary.locked
      ? 'Configura tu ingreso mensual'
      : incomeOver
        ? `Excedido por: ${fmt(summary.totalSpent - incomeBase)}`
        : `Disponible: ${fmt(incomeBase - summary.totalSpent)}`,
    pct: incomeBase > 0 ? (summary.totalSpent / incomeBase) * 100 : 0,
    over: incomeOver
  });

  for (const c of summary.categories) {
    setKpi(`kpi-${c.key === 'necesidades' ? 'needs' : c.key === 'deseos' ? 'wants' : 'save'}`, {
      value: fmt(c.spent),
      cap: summary.locked ? 'Tope: configura tu ingreso' : `Tope ${c.pct}%: ${fmt(c.assigned)}`,
      left: summary.locked ? 'Cálculo bloqueado' : c.over ? `Excedido por: ${fmt(-c.diff)}` : `Disponible: ${fmt(c.diff)}`,
      pct: c.usage,
      over: c.over
    });
  }
}

function renderChart(summary) {
  const canvas = $('#budget-chart');
  if (!canvas) return;
  renderBudgetChart(canvas, {
    labels: RULE_KEYS.map((k) => `${RULES[k].pct}% ${RULES[k].label}`),
    colors: RULE_KEYS.map((k) => RULES[k].color),
    ideal: summary.locked ? RULE_KEYS.map((k) => RULES[k].pct) : summary.categories.map((c) => c.assigned),
    actual: summary.categories.map((c) => c.spent),
    over: summary.categories.map((c) => c.over),
    idealAsPercent: summary.locked,
    formatter: fmt
  });
}

function renderGoals() {
  const list = $('#goals-list');
  if (!list) return;
  const goals = allocateGoals();

  if (!goals.length) {
    list.innerHTML =
      '<p class="goal-meta">Crea una meta o inversión (por ejemplo, “Fondo de emergencia”, “ETF S&P500”). Se financiará con lo que registres como Ahorro (20%).</p>';
    return;
  }

  list.innerHTML =
    `<p class="goal-meta">Ahorro acumulado: <strong class="sensitive">${escapeHTML(fmt(state.savingsTotal))}</strong></p>` +
    goals
      .map((g) => {
        const pct = g.monto_objetivo > 0 ? Math.min(100, (g.progress / g.monto_objetivo) * 100) : 0;
        const done = g.progress >= g.monto_objetivo;
        const name = escapeHTML(g.nombre);
        return `<article class="goal" data-id="${escapeHTML(g.id)}">
          <div class="goal-head">
            <span class="goal-name">${name}</span>
            <span class="row-actions">
              <button class="btn small icon no-print" type="button" data-goal-action="edit" aria-label="Editar meta ${name}">✏️</button>
              <button class="btn small icon no-print" type="button" data-goal-action="delete" aria-label="Eliminar meta ${name}">🗑️</button>
            </span>
          </div>
          <div class="progress" style="--pct:${pct.toFixed(1)}%" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="Progreso de ${name}"></div>
          <span class="goal-meta sensitive">${escapeHTML(fmt(g.progress))} de ${escapeHTML(fmt(g.monto_objetivo))} · ${pct.toFixed(0)}%${done ? ' 🎉 Meta alcanzada' : ''}</span>
        </article>`;
      })
      .join('');
}

function renderDebts() {
  const list = $('#debts-list');
  if (!list) return;
  if (!state.debts.length) {
    list.innerHTML =
      '<p class="goal-meta">Registra una deuda (por ejemplo, “Tarjeta de Crédito”, “Préstamo automotriz”) para dar seguimiento a los saldos y abonos.</p>';
    return;
  }

  const totalDebt = sumMoney(state.debts.map((d) => d.monto_total));
  const totalPaid = sumMoney(state.debts.map((d) => d.monto_pagado));

  list.innerHTML =
    `<p class="goal-meta">Total amortizado: <strong class="sensitive">${escapeHTML(fmt(totalPaid))}</strong> de <strong class="sensitive">${escapeHTML(fmt(totalDebt))}</strong></p>` +
    state.debts
      .map((d) => {
        const pct = d.monto_total > 0 ? Math.min(100, (d.monto_pagado / d.monto_total) * 100) : 0;
        const done = d.monto_pagado >= d.monto_total;
        const name = escapeHTML(d.nombre);
        return `<article class="goal debt-item" data-id="${escapeHTML(d.id)}">
          <div class="goal-head">
            <span class="goal-name">${name}</span>
            <span class="row-actions">
              <button class="btn small icon no-print" type="button" data-debt-action="edit" aria-label="Editar deuda ${name}">✏️</button>
              <button class="btn small icon no-print" type="button" data-debt-action="delete" aria-label="Eliminar deuda ${name}">🗑️</button>
            </span>
          </div>
          <div class="progress" style="--pct:${pct.toFixed(1)}%; background: rgba(220, 38, 38, 0.15);" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="Progreso de ${name}"></div>
          <span class="goal-meta sensitive">${escapeHTML(fmt(d.monto_pagado))} de ${escapeHTML(fmt(d.monto_total))} · ${pct.toFixed(0)}%${done ? ' ✅ Deuda Saldada' : ''}</span>
        </article>`;
      })
      .join('');
}

function filteredRows(summary) {
  const { rule, method, search, category } = state.ui;
  const term = normalizeText(search);
  const rows = summary.rows.filter((t) => {
    if (rule !== 'todas' && !(t.tipo === 'gasto' && t.categoria_503020 === rule)) return false;
    if (method !== 'todos' && t.metodo_pago !== method) return false;
    if (category !== 'todas' && t.categoria_detalle !== category) return false;
    if (term && !normalizeText(`${t.concepto} ${t.categoria_detalle}`).includes(term)) return false;
    return true;
  });
  return sortRows(rows);
}

function rowHtml(t) {
  const isIncome = t.tipo === 'ingreso';
  const badge = isIncome
    ? '<span class="badge ingreso">Ingreso</span>'
    : `<span class="badge ${escapeHTML(t.categoria_503020)}">${escapeHTML(RULES[t.categoria_503020]?.pct ?? '')}% ${escapeHTML(RULES[t.categoria_503020]?.label ?? t.categoria_503020)}</span>`;
  const concept = escapeHTML(t.concepto);
  return `<tr data-id="${escapeHTML(t.id)}">
    <td data-label="Fecha">${escapeHTML(formatDate(t.fecha))}</td>
    <td class="concept" data-label="Concepto">${concept}${t.es_recurrente ? ' <span title="Recurrente" aria-label="Recurrente">🔁</span>' : ''}</td>
    <td data-label="Regla">${badge}</td>
    <td data-label="Detalle">${escapeHTML(t.categoria_detalle)}</td>
    <td data-label="Pago">${escapeHTML(METHODS[t.metodo_pago] ?? t.metodo_pago)}</td>
    <td class="num" data-label="Monto"><span class="sensitive amount-${isIncome ? 'ingreso' : 'gasto'}">${isIncome ? '+' : '−'}${escapeHTML(fmt(t.monto))}</span></td>
    <td class="no-print" data-label="Acciones"><span class="row-actions">
      <button class="btn small icon" type="button" data-action="edit" aria-label="Editar ${concept}">✏️</button>
      <button class="btn small icon" type="button" data-action="delete" aria-label="Eliminar ${concept}">🗑️</button>
    </span></td>
  </tr>`;
}

function renderTable(summary) {
  const body = $('#tx-body');
  if (!body) return;
  const rows = filteredRows(summary);
  const { pageSize } = state.ui;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  state.ui.page = Math.min(Math.max(1, state.ui.page), pages);
  const start = (state.ui.page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);

  body.innerHTML = slice.length
    ? slice.map(rowHtml).join('')
    : '<tr><td colspan="7" class="empty-state">No hay transacciones para los filtros seleccionados.</td></tr>';

  const info = $('#page-info');
  if (info) info.textContent = `Página ${state.ui.page} de ${pages} · ${rows.length} registro${rows.length === 1 ? '' : 's'}`;
  const prev = $('#page-prev');
  if (prev) prev.disabled = state.ui.page <= 1;
  const next = $('#page-next');
  if (next) next.disabled = state.ui.page >= pages;

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    const active = th.dataset.sort === state.ui.sortKey;
    th.setAttribute('aria-sort', active ? (state.ui.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  persistUi();
}

function renderAll() {
  const summary = computeSummary();
  renderKpis(summary);
  renderChart(summary);
  renderGoals();
  renderDebts();
  renderCategoryFilter();
  renderTable(summary);
}

/* ------------------------------ Carga de datos ------------------------------ */
async function loadAll() {
  try {
    const from = `${new Date().getFullYear() - 1}-12-01`;
    const [profile, transactions, goals, debts, savingsTotal, userCategories] = await Promise.all([
      budget.getProfile(state.user.id),
      budget.listTransactions(from),
      budget.listGoals(),
      budget.listDebts(),
      budget.getSavingsTotal(),
      catService.listCategories()
    ]);
    Object.assign(state, { profile, transactions, goals, debts, savingsTotal, categories: userCategories });
    state.pending.forEach((id) => {
      if (!transactions.some((t) => t.id === id)) state.pending.delete(id);
    });
    renderAll();
    syncGoalProgress();
  } catch (error) {
    showToast(friendlyError(error), { type: 'error', duration: 5000 });
    if (!state.loaded) renderAll();
  } finally {
    state.loaded = true;
  }
}

async function syncGoalProgress() {
  const stale = allocateGoals().filter((g) => Math.abs(g.progress - g.monto_actual) >= 0.01);
  if (!stale.length) return;
  try {
    await Promise.all(stale.map((g) => budget.updateGoalProgress(g.id, g.progress)));
    stale.forEach((g) => {
      const goal = state.goals.find((x) => x.id === g.id);
      if (goal) goal.monto_actual = g.progress;
    });
  } catch {
    /* no crítico */
  }
}

const scheduleReload = debounce(loadAll, 400);

/* ------------------------------ Modales ------------------------------ */
const options = (list, selected) =>
  list
    .map(([value, label]) => `<option value="${escapeHTML(value)}"${value === selected ? ' selected' : ''}>${escapeHTML(label)}</option>`)
    .join('');

async function openTransactionModal(tx = null) {
  const isEdit = Boolean(tx);
  if (!isEdit && !state.categories.length) {
    showToast('Primero crea o restaura tus categorías.', { type: 'info' });
    return openCategoryManager();
  }
  const v = tx ?? {
    concepto: '',
    monto: '',
    tipo: 'gasto',
    categoria_503020: state.categories[0]?.categoria_503020 ?? 'necesidades',
    categoria_detalle: state.categories[0]?.nombre ?? '',
    metodo_pago: 'debito',
    es_recurrente: false,
    fecha: toISODate(new Date())
  };

  const result = await Swal.fire({
    title: isEdit ? 'Editar transacción' : 'Nueva transacción',
    background: 'var(--surface)',
    color: 'var(--text)',
    html: `<form class="swal-form" id="tx-form" novalidate>
      <label for="tx-concepto">Concepto
        <input id="tx-concepto" type="text" maxlength="120" required value="${escapeHTML(v.concepto)}" placeholder="Ej. Arriendo">
      </label>
      <div class="row">
        <label for="tx-monto">Monto
          <input id="tx-monto" type="number" inputmode="decimal" min="0.01" step="0.01" max="${MAX_AMOUNT}" required value="${escapeHTML(v.monto)}" placeholder="0.00">
        </label>
        <label for="tx-tipo">Tipo
          <select id="tx-tipo">${options([['gasto', 'Gasto'], ['ingreso', 'Ingreso']], v.tipo)}</select>
        </label>
      </div>
      <div id="tx-category-row">
        <label for="tx-detalle">Categoría
          <select id="tx-detalle">${categoryOptionsHtml(v.categoria_detalle, tx)}</select>
        </label>
        <span class="hint" id="tx-rule-hint" aria-live="polite"></span>
      </div>
      <div class="row">
        <label for="tx-metodo">Método de pago
          <select id="tx-metodo">${options(Object.entries(METHODS), v.metodo_pago)}</select>
        </label>
        <label for="tx-fecha">Fecha
          <input id="tx-fecha" type="date" required value="${escapeHTML(v.fecha)}">
        </label>
      </div>
      <label class="check" for="tx-recurrente">
        <input id="tx-recurrente" type="checkbox"${v.es_recurrente ? ' checked' : ''}> Gasto recurrente (se puede copiar al mes siguiente)
      </label>
    </form>`,
    showCancelButton: true,
    confirmButtonText: isEdit ? 'Guardar cambios' : 'Guardar',
    cancelButtonText: 'Cancelar',
    focusConfirm: false,
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !Swal.isLoading(),
    didOpen: (popup) => {
      const tipo = $('#tx-tipo', popup);
      const toggle = () => {
        $('#tx-category-row', popup).hidden = tipo.value === 'ingreso';
      };
      tipo.addEventListener('change', toggle);
      toggle();

      const detalle = $('#tx-detalle', popup);
      const hint = $('#tx-rule-hint', popup);
      const updateHint = () => {
        const selectedOpt = detalle.selectedOptions[0];
        const rule = selectedOpt?.dataset.rule;
        const catName = selectedOpt?.value;
        const catObj = state.categories.find((c) => c.nombre === catName);

        let hintText = rule ? `Cuenta para: ${RULES[rule].pct}% ${RULES[rule].label}` : '';
        if (catObj?.limite_monto) {
          const currentMonthRange = getPeriodRange('mes_actual');
          const monthExpenses = visibleTransactions().filter(
            (t) => t.tipo === 'gasto' && t.fecha >= currentMonthRange.from && t.fecha <= currentMonthRange.to
          );
          const spent = sumMoney(monthExpenses.filter((t) => t.categoria_detalle === catName).map((t) => t.monto));
          const pct = (spent / catObj.limite_monto) * 100;
          hintText += ` · Límite: ${fmt(spent)} de ${fmt(catObj.limite_monto)} (${pct.toFixed(0)}%)`;
        }
        hint.textContent = hintText;
      };
      detalle.addEventListener('change', updateHint);
      updateHint();

      $('#tx-form', popup).addEventListener('submit', (e) => {
        e.preventDefault();
        Swal.clickConfirm();
      });
      $('#tx-concepto', popup).focus();
    },
    preConfirm: async () => {
      const popup = Swal.getPopup();
      const concepto = $('#tx-concepto', popup).value.trim();
      const montoInput = $('#tx-monto', popup);
      const monto = Number(montoInput.value);
      const tipo = $('#tx-tipo', popup).value;
      const fecha = $('#tx-fecha', popup).value;

      if (!concepto) return Swal.showValidationMessage('Escribe un concepto.');
      const detalleOption = $('#tx-detalle', popup).selectedOptions[0];
      if (tipo === 'gasto' && !detalleOption) {
        return Swal.showValidationMessage('Crea al menos una categoría antes de registrar un gasto.');
      }
      if (!montoInput.checkValidity() || !Number.isFinite(monto) || monto < 0.01 || monto > MAX_AMOUNT) {
        return Swal.showValidationMessage('El monto debe ser un número positivo (mínimo 0.01, máximo 2 decimales).');
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return Swal.showValidationMessage('Selecciona una fecha válida.');

      const payload = {
        concepto,
        monto: roundMoney(monto),
        tipo,
        categoria_503020: tipo === 'ingreso' ? 'necesidades' : detalleOption.dataset.rule,
        categoria_detalle: tipo === 'ingreso' ? 'Ingreso' : detalleOption.value,
        metodo_pago: $('#tx-metodo', popup).value,
        es_recurrente: $('#tx-recurrente', popup).checked,
        fecha
      };

      try {
        return isEdit ? await budget.updateTransaction(tx.id, payload) : await budget.createTransaction(payload);
      } catch (error) {
        return Swal.showValidationMessage(friendlyError(error));
      }
    }
  });

  if (result.isConfirmed && result.value) {
    showToast(isEdit ? 'Transacción actualizada' : 'Transacción guardada', { type: 'success' });
    await loadAll();
  }
}

async function openIncomeModal({ onboarding = false } = {}) {
  const currencies = CURRENCIES.includes(state.profile.currency) ? CURRENCIES : [state.profile.currency, ...CURRENCIES];
  const result = await Swal.fire({
    title: onboarding ? 'Configura tu presupuesto' : 'Ingreso mensual y divisa',
    background: 'var(--surface)',
    color: 'var(--text)',
    html: `<form class="swal-form" id="income-form" novalidate>
      <label for="inc-monto">Ingreso mensual base
        <input id="inc-monto" type="number" inputmode="decimal" min="0.01" step="0.01" max="${MAX_AMOUNT}" required value="${state.profile.monthly_income > 0 ? escapeHTML(state.profile.monthly_income) : ''}" placeholder="0.00">
      </label>
      <label for="inc-currency">Divisa
        <select id="inc-currency">${options(currencies.map((c) => [c, c]), state.profile.currency)}</select>
      </label>
    </form>`,
    showCancelButton: true,
    confirmButtonText: 'Guardar',
    cancelButtonText: 'Cancelar',
    focusConfirm: false,
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !Swal.isLoading(),
    didOpen: (popup) => {
      $('#income-form', popup).addEventListener('submit', (e) => {
        e.preventDefault();
        Swal.clickConfirm();
      });
      $('#inc-monto', popup).focus();
    },
    preConfirm: async () => {
      const popup = Swal.getPopup();
      const input = $('#inc-monto', popup);
      const monthly_income = Number(input.value);
      if (!input.checkValidity() || !Number.isFinite(monthly_income) || monthly_income < 0.01) {
        return Swal.showValidationMessage('Ingresa un ingreso mensual mayor a 0.');
      }
      try {
        return await budget.updateProfile(state.user.id, {
          monthly_income,
          currency: $('#inc-currency', popup).value
        });
      } catch (error) {
        return Swal.showValidationMessage(friendlyError(error));
      }
    }
  });

  if (result.isConfirmed && result.value) {
    state.profile = result.value;
    renderAll();
    showToast('Ingreso y divisa actualizados', { type: 'success' });
  }
}

async function openGoalModal(goal = null) {
  const isEdit = Boolean(goal);
  const result = await Swal.fire({
    title: isEdit ? 'Editar meta / inversión' : 'Nueva meta o inversión',
    background: 'var(--surface)',
    color: 'var(--text)',
    html: `<form class="swal-form" id="goal-form" novalidate>
      <label for="goal-nombre">Nombre
        <input id="goal-nombre" type="text" maxlength="80" required value="${escapeHTML(goal?.nombre ?? '')}" placeholder="Ej. Fondo de emergencia o ETF S&P500">
      </label>
      <label for="goal-monto">Monto objetivo
        <input id="goal-monto" type="number" inputmode="decimal" min="0.01" step="0.01" max="${MAX_AMOUNT}" required value="${escapeHTML(goal?.monto_objetivo ?? '')}" placeholder="0.00">
      </label>
    </form>`,
    showCancelButton: true,
    confirmButtonText: 'Guardar',
    cancelButtonText: 'Cancelar',
    focusConfirm: false,
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !Swal.isLoading(),
    didOpen: (popup) => {
      $('#goal-form', popup).addEventListener('submit', (e) => {
        e.preventDefault();
        Swal.clickConfirm();
      });
      $('#goal-nombre', popup).focus();
    },
    preConfirm: async () => {
      const popup = Swal.getPopup();
      const nombre = $('#goal-nombre', popup).value.trim();
      const montoInput = $('#goal-monto', popup);
      const monto_objetivo = Number(montoInput.value);
      if (!nombre) return Swal.showValidationMessage('Escribe un nombre para la meta.');
      if (!montoInput.checkValidity() || !Number.isFinite(monto_objetivo) || monto_objetivo < 0.01) {
        return Swal.showValidationMessage('El monto objetivo debe ser un número positivo.');
      }
      try {
        return isEdit
          ? await budget.updateGoal(goal.id, { nombre, monto_objetivo })
          : await budget.createGoal({ nombre, monto_objetivo });
      } catch (error) {
        return Swal.showValidationMessage(friendlyError(error));
      }
    }
  });

  if (result.isConfirmed && result.value) {
    showToast(isEdit ? 'Meta actualizada' : 'Meta creada', { type: 'success' });
    await loadAll();
  }
}

async function confirmDeleteGoal(goal) {
  const result = await Swal.fire({
    icon: 'warning',
    title: '¿Eliminar meta?',
    background: 'var(--surface)',
    color: 'var(--text)',
    html: `Se eliminará <strong>${escapeHTML(goal.nombre)}</strong>. Tus transacciones de ahorro no se afectan.`,
    showCancelButton: true,
    confirmButtonText: 'Eliminar',
    cancelButtonText: 'Cancelar',
    confirmButtonColor: '#dc2626',
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !Swal.isLoading(),
    preConfirm: async () => {
      try {
        await budget.deleteGoal(goal.id);
        return true;
      } catch (error) {
        return Swal.showValidationMessage(friendlyError(error));
      }
    }
  });
  if (result.isConfirmed && result.value) {
    showToast('Meta eliminada', { type: 'success' });
    await loadAll();
  }
}

async function openDebtModal(debt = null) {
  const isEdit = Boolean(debt);
  const result = await Swal.fire({
    title: isEdit ? 'Editar Deuda' : 'Nueva Deuda',
    background: 'var(--surface)',
    color: 'var(--text)',
    html: `<form class="swal-form" id="debt-form" novalidate>
      <label for="debt-nombre">Nombre de la deuda
        <input id="debt-nombre" type="text" maxlength="80" required value="${escapeHTML(debt?.nombre ?? '')}" placeholder="Ej. Tarjeta Visa">
      </label>
      <div class="row">
        <label for="debt-total">Monto total
          <input id="debt-total" type="number" inputmode="decimal" min="0.01" step="0.01" max="${MAX_AMOUNT}" required value="${escapeHTML(debt?.monto_total ?? '')}" placeholder="0.00">
        </label>
        <label for="debt-pagado">Monto abonado
          <input id="debt-pagado" type="number" inputmode="decimal" min="0" step="0.01" max="${MAX_AMOUNT}" value="${escapeHTML(debt?.monto_pagado ?? 0)}" placeholder="0.00">
        </label>
      </div>
    </form>`,
    showCancelButton: true,
    confirmButtonText: 'Guardar',
    cancelButtonText: 'Cancelar',
    focusConfirm: false,
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !Swal.isLoading(),
    didOpen: (popup) => {
      $('#debt-form', popup).addEventListener('submit', (e) => {
        e.preventDefault();
        Swal.clickConfirm();
      });
      $('#debt-nombre', popup).focus();
    },
    preConfirm: async () => {
      const popup = Swal.getPopup();
      const nombre = $('#debt-nombre', popup).value.trim();
      const total = Number($('#debt-total', popup).value);
      const pagado = Number($('#debt-pagado', popup).value) || 0;

      if (!nombre) return Swal.showValidationMessage('Escribe el nombre de la deuda.');
      if (!Number.isFinite(total) || total <= 0) return Swal.showValidationMessage('Ingresa un monto total positivo.');
      if (pagado < 0 || pagado > total) return Swal.showValidationMessage('El abono no puede ser negativo ni superar la deuda total.');

      try {
        return isEdit
          ? await budget.updateDebt(debt.id, { nombre, monto_total: roundMoney(total), monto_pagado: roundMoney(pagado) })
          : await budget.createDebt({ nombre, monto_total: roundMoney(total), monto_pagado: roundMoney(pagado) });
      } catch (error) {
        return Swal.showValidationMessage(friendlyError(error));
      }
    }
  });

  if (result.isConfirmed && result.value) {
    showToast(isEdit ? 'Deuda actualizada' : 'Deuda registrada', { type: 'success' });
    await loadAll();
  }
}

async function confirmDeleteDebt(debt) {
  const result = await Swal.fire({
    icon: 'warning',
    title: '¿Eliminar deuda?',
    background: 'var(--surface)',
    color: 'var(--text)',
    html: `Se eliminará la deuda <strong>${escapeHTML(debt.nombre)}</strong>.`,
    showCancelButton: true,
    confirmButtonText: 'Eliminar',
    cancelButtonText: 'Cancelar',
    confirmButtonColor: '#dc2626',
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !Swal.isLoading(),
    preConfirm: async () => {
      try {
        await budget.deleteDebt(debt.id);
        return true;
      } catch (error) {
        return Swal.showValidationMessage(friendlyError(error));
      }
    }
  });

  if (result.isConfirmed && result.value) {
    showToast('Deuda eliminada', { type: 'success' });
    await loadAll();
  }
}

/* ------------------------------ Categorías dinámicas y Límites ------------------------------ */
const ruleOptions = (selected) =>
  RULE_KEYS.map(
    (k) => `<option value="${k}"${k === selected ? ' selected' : ''}>${RULES[k].pct}% ${escapeHTML(RULES[k].label)}</option>`
  ).join('');

function categoryOptionsHtml(selected, tx = null) {
  const list = state.categories.map((c) => ({ nombre: c.nombre, rule: c.categoria_503020, removed: false }));
  if (tx?.tipo === 'gasto' && tx.categoria_detalle && !list.some((c) => c.nombre === tx.categoria_detalle)) {
    list.push({ nombre: tx.categoria_detalle, rule: tx.categoria_503020, removed: true });
  }
  return RULE_KEYS.map((rule) => {
    const items = list.filter((c) => c.rule === rule).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    if (!items.length) return '';
    const label = escapeHTML(`${RULES[rule].pct}% ${RULES[rule].label}`);
    const opts = items
      .map(
        (c) =>
          `<option value="${escapeHTML(c.nombre)}" data-rule="${rule}"${c.nombre === selected ? ' selected' : ''}>${escapeHTML(c.nombre)}${c.removed ? ' (eliminada)' : ''}</option>`
      )
      .join('');
    return `<optgroup label="${label}">${opts}</optgroup>`;
  }).join('');
}

function renderCategoryFilter() {
  const select = $('#f-category');
  if (!select) return;
  const names = new Set(state.categories.map((c) => c.nombre));
  visibleTransactions().forEach((t) => {
    if (t.tipo === 'gasto') names.add(t.categoria_detalle);
  });
  if ((state.categories.length || state.transactions.length) && state.ui.category !== 'todas' && !names.has(state.ui.category)) {
    state.ui.category = 'todas';
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'es'));
  select.innerHTML =
    '<option value="todas">Todas</option>' +
    sorted.map((n) => `<option value="${escapeHTML(n)}">${escapeHTML(n)}</option>`).join('');
  select.value = names.has(state.ui.category) ? state.ui.category : 'todas';
}

async function openCategoryManager() {
  const ui = { editingId: null, deleteId: null, confirmReset: false, busy: false };
  let root = null;

  const currentMonthRange = getPeriodRange('mes_actual');
  const monthExpenses = visibleTransactions().filter(
    (t) => t.tipo === 'gasto' && t.fecha >= currentMonthRange.from && t.fecha <= currentMonthRange.to
  );

  const getSpent = (catName) =>
    sumMoney(monthExpenses.filter((t) => t.categoria_detalle === catName).map((t) => t.monto));

  const row = (c) => {
    const name = escapeHTML(c.nombre);
    const id = escapeHTML(c.id);
    const limit = c.limite_monto ? Number(c.limite_monto) : null;
    const spent = getSpent(c.nombre);

    if (ui.editingId === c.id) {
      return `<li><form class="cat-row editing" data-form="edit" data-id="${id}" novalidate style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
        <input name="nombre" type="text" maxlength="${catService.MAX_NAME_LENGTH}" required value="${name}" aria-label="Nombre de la categoría" style="flex:1">
        <select name="rule" aria-label="Pilar 50/30/20">${ruleOptions(c.categoria_503020)}</select>
        <input name="limite_monto" type="number" step="0.01" min="0.01" value="${limit ?? ''}" placeholder="Límite (opcional)" aria-label="Límite máximo de gasto" style="width:130px">
        <button class="btn small success" type="submit" aria-label="Guardar cambios de ${name}">Guardar</button>
        <button class="btn small" type="button" data-cat="cancel" aria-label="Cancelar edición">Cancelar</button>
      </form></li>`;
    }
    if (ui.deleteId === c.id) {
      return `<li class="cat-row"><span class="cat-name">¿Eliminar “${name}”?</span>
        <span class="cat-actions">
          <button class="btn small danger" type="button" data-cat="confirm-delete" data-id="${id}">Sí, eliminar</button>
          <button class="btn small" type="button" data-cat="cancel">No</button>
        </span></li>`;
    }

    let alertBadge = '';
    if (limit) {
      const pct = (spent / limit) * 100;
      const isOver = pct >= 100;
      const isNear = pct >= 80 && pct < 100;
      const badgeColor = isOver ? '#dc2626' : isNear ? '#eab308' : '#16a34a';
      const statusIcon = isOver ? '🚨 Excedido' : isNear ? '⚠️ Cerca del límite' : '🟢 Dentro del tope';

      alertBadge = `<span class="sensitive" style="font-size:0.8rem; padding:0.2rem 0.5rem; border-radius:4px; background:${badgeColor}1a; color:${badgeColor}; font-weight:600;" title="Gastado este mes: ${escapeHTML(fmt(spent))} de ${escapeHTML(fmt(limit))}">
        ${escapeHTML(fmt(spent))} / ${escapeHTML(fmt(limit))} (${pct.toFixed(0)}%) · ${statusIcon}
      </span>`;
    }

    return `<li class="cat-row" style="display:flex; justify-space-between; align-items:center; gap:0.5rem; flex-wrap:wrap;">
      <div style="display:flex; align-items:center; gap:0.5rem; flex:1; min-width:200px;">
        <span class="cat-name">${name}</span>
        ${alertBadge}
      </div>
      <span class="cat-actions">
        <button class="btn small icon" type="button" data-cat="edit" data-id="${id}" aria-label="Editar categoría ${name}">✏️</button>
        <button class="btn small icon" type="button" data-cat="delete" data-id="${id}" aria-label="Eliminar categoría ${name}">🗑️</button>
      </span>
    </li>`;
  };

  const render = () => {
    const groups = RULE_KEYS.map((rule) => {
      const items = state.categories
        .filter((c) => c.categoria_503020 === rule)
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      return `<section class="cat-group ${rule}" aria-label="Categorías de ${escapeHTML(RULES[rule].label)}">
        <h3>${RULES[rule].pct}% ${escapeHTML(RULES[rule].label)}</h3>
        ${items.length ? `<ul>${items.map(row).join('')}</ul>` : '<p class="hint">Sin categorías en este pilar.</p>'}
      </section>`;
    }).join('');

    const footer = ui.confirmReset
      ? `<p class="hint">Se reemplazarán TODAS tus categorías por las predeterminadas. Tus transacciones conservan su categoría.</p>
         <div class="cat-footer">
           <button class="btn small danger" type="button" data-cat="confirm-reset">Sí, restablecer</button>
           <button class="btn small" type="button" data-cat="cancel">Cancelar</button>
         </div>`
      : `<div class="cat-footer">
           <button class="btn small" type="button" data-cat="restore">Restaurar predeterminadas</button>
           <button class="btn small danger" type="button" data-cat="reset">Restablecer todo</button>
         </div>
         <p class="hint">Restaurar añade las predeterminadas que falten. Las transacciones existentes conservan su categoría.</p>`;

    root.innerHTML = `<form class="cat-add" data-form="add" novalidate style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:1rem;">
        <input name="nombre" type="text" maxlength="${catService.MAX_NAME_LENGTH}" required placeholder="Nueva categoría (ej. Restaurantes)" aria-label="Nombre de la nueva categoría" style="flex:1; min-width:160px;">
        <select name="rule" aria-label="Pilar 50/30/20 de la nueva categoría">${ruleOptions('necesidades')}</select>
        <input name="limite_monto" type="number" step="0.01" min="0.01" placeholder="Límite $ (opcional)" aria-label="Límite mensual opcional" style="width:140px;">
        <button class="btn primary small" type="submit">＋ Agregar</button>
      </form>${groups}${footer}`;
    root.querySelector('[data-form="edit"] input')?.focus();
  };

  const run = async (task, okMessage) => {
    if (ui.busy) return;
    ui.busy = true;
    root.setAttribute('aria-busy', 'true');
    let ok = false;
    try {
      const result = await task();
      await loadAll();
      showToast(typeof result === 'string' ? result : okMessage, { type: 'success' });
      ok = true;
    } catch (error) {
      showToast(friendlyError(error), { type: 'error', duration: 5000 });
    } finally {
      ui.busy = false;
      root.removeAttribute('aria-busy');
      if (ok) Object.assign(ui, { editingId: null, deleteId: null, confirmReset: false });
      render();
    }
  };

  await Swal.fire({
    title: 'Mis categorías y límites de gasto',
    background: 'var(--surface)',
    color: 'var(--text)',
    html: '<div class="cat-manager" id="cat-manager"></div>',
    width: 720,
    confirmButtonText: 'Cerrar',
    didOpen: (popup) => {
      root = $('#cat-manager', popup);

      root.addEventListener('submit', (e) => {
        e.preventDefault();
        const form = e.target.closest('form');
        const data = new FormData(form);
        const input = {
          nombre: data.get('nombre'),
          categoria_503020: data.get('rule'),
          limite_monto: data.get('limite_monto')
        };
        if (form.dataset.form === 'add') run(() => catService.createCategory(input), 'Categoría creada');
        if (form.dataset.form === 'edit') run(() => catService.updateCategory(form.dataset.id, input), 'Categoría actualizada');
      });

      root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cat]');
        if (!btn || ui.busy) return;
        const id = btn.dataset.id;
        switch (btn.dataset.cat) {
          case 'edit':
            Object.assign(ui, { editingId: id, deleteId: null, confirmReset: false });
            render();
            break;
          case 'delete':
            Object.assign(ui, { deleteId: id, editingId: null, confirmReset: false });
            render();
            break;
          case 'reset':
            Object.assign(ui, { confirmReset: true, editingId: null, deleteId: null });
            render();
            break;
          case 'cancel':
            Object.assign(ui, { editingId: null, deleteId: null, confirmReset: false });
            render();
            break;
          case 'confirm-delete':
            run(() => catService.deleteCategory(id), 'Categoría eliminada');
            break;
          case 'restore':
            run(async () => {
              const created = await catService.seedDefaults();
              return created ? `Se restauraron ${created} categoría${created === 1 ? '' : 's'}` : 'Ya tienes todas las predeterminadas';
            });
            break;
          case 'confirm-reset':
            run(() => catService.resetDefaults(), 'Categorías restablecidas');
            break;
          default:
        }
      });

      render();
    }
  });
}

/* ------------------------------ Borrado optimista con Deshacer ------------------------------ */
function deleteWithUndo(id) {
  if (!state.transactions.some((t) => t.id === id) || state.pending.has(id)) return;
  state.pending.add(id);
  renderAll();

  showToast('Transacción eliminada', {
    type: 'info',
    duration: 5000,
    actionLabel: 'Deshacer',
    onAction: () => {
      state.pending.delete(id);
      renderAll();
    },
    onClose: (reason) => {
      if (reason !== 'action') commitDelete(id);
    }
  });
}

async function commitDelete(id) {
  try {
    await budget.deleteTransaction(id);
    state.transactions = state.transactions.filter((t) => t.id !== id);
    showToast('Transacción eliminada definitivamente', { type: 'success', duration: 2000 });
  } catch (error) {
    showToast(`No se pudo eliminar: ${friendlyError(error)}`, { type: 'error', duration: 5000 });
  } finally {
    state.pending.delete(id);
    renderAll();
    syncGoalAfterChange();
  }
}

const syncGoalAfterChange = debounce(async () => {
  try {
    state.savingsTotal = await budget.getSavingsTotal();
    renderGoals();
    syncGoalProgress();
  } catch {
    /* no crítico */
  }
}, 300);

/* ------------------------------ Exportaciones ------------------------------ */
function buildExportData() {
  const summary = computeSummary();
  return {
    user: { email: state.user.email },
    currency: state.profile.currency,
    periodLabel: summary.range.label,
    range: summary.range,
    summary: {
      income: summary.income,
      totalSpent: summary.totalSpent,
      categories: summary.categories
    },
    transactions: sortRows(summary.rows)
  };
}

/* ------------------------------ Eventos ------------------------------ */
function restoreControls() {
  const searchEl = $('#f-search'); if (searchEl) searchEl.value = state.ui.search;
  const ruleEl = $('#f-rule'); if (ruleEl) ruleEl.value = state.ui.rule;
  const methodEl = $('#f-method'); if (methodEl) methodEl.value = state.ui.method;
  const periodEl = $('#f-period'); if (periodEl) periodEl.value = state.ui.period;
  const pageSizeEl = $('#page-size'); if (pageSizeEl) pageSizeEl.value = String(state.ui.pageSize);
}

function wireEvents() {
  const onFilter = (key) => (e) => {
    state.ui[key] = e.target.value;
    state.ui.page = 1;
    key === 'period' ? renderAll() : renderTable(computeSummary());
  };

  $('#f-search')?.addEventListener('input', debounce(onFilter('search'), 150));
  $('#f-rule')?.addEventListener('change', onFilter('rule'));
  $('#f-method')?.addEventListener('change', onFilter('method'));
  $('#f-category')?.addEventListener('change', onFilter('category'));
  $('#f-period')?.addEventListener('change', onFilter('period'));
  $('#page-size')?.addEventListener('change', (e) => {
    state.ui.pageSize = Number(e.target.value);
    state.ui.page = 1;
    renderTable(computeSummary());
  });
  $('#page-prev')?.addEventListener('click', () => {
    state.ui.page -= 1;
    renderTable(computeSummary());
  });
  $('#page-next')?.addEventListener('click', () => {
    state.ui.page += 1;
    renderTable(computeSummary());
  });

  const sortBy = (th) => {
    const key = th.dataset.sort;
    state.ui.sortDir = state.ui.sortKey === key ? (state.ui.sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    state.ui.sortKey = key;
    state.ui.page = 1;
    renderTable(computeSummary());
  };
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => sortBy(th));
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        sortBy(th);
      }
    });
  });

  $('#tx-body')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('tr')?.dataset.id;
    const tx = state.transactions.find((t) => t.id === id);
    if (!tx) return;
    if (btn.dataset.action === 'edit') openTransactionModal(tx);
    if (btn.dataset.action === 'delete') deleteWithUndo(id);
  });

  $('#goals-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-goal-action]');
    if (!btn) return;
    const goal = state.goals.find((g) => g.id === btn.closest('.goal')?.dataset.id);
    if (!goal) return;
    if (btn.dataset.goalAction === 'edit') openGoalModal(goal);
    if (btn.dataset.goalAction === 'delete') confirmDeleteGoal(goal);
  });

  $('#btn-add')?.addEventListener('click', () => openTransactionModal());
  $('#btn-goal')?.addEventListener('click', () => openGoalModal());
  $('#btn-income')?.addEventListener('click', () => openIncomeModal());
  $('#btn-categories')?.addEventListener('click', () => openCategoryManager());
  $('#btn-onboard')?.addEventListener('click', () => openIncomeModal({ onboarding: true }));

  $('#btn-lock-now')?.addEventListener('click', () => triggerLockScreen());
  $('#btn-security-settings')?.addEventListener('click', () => openSecurityModal());

  $('#btn-debt')?.addEventListener('click', () => openDebtModal());

  $('#debts-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-debt-action]');
    if (!btn) return;
    const debt = state.debts.find((d) => d.id === btn.closest('.debt-item')?.dataset.id);
    if (!debt) return;
    if (btn.dataset.debtAction === 'edit') openDebtModal(debt);
    if (btn.dataset.debtAction === 'delete') confirmDeleteDebt(debt);
  });

  $('#btn-clone')?.addEventListener('click', (e) =>
    withLoading(e.currentTarget, async () => {
      try {
        const { created, skipped } = await budget.cloneRecurringExpenses();
        showToast(
          created
            ? `Se copiaron ${created} gasto${created === 1 ? '' : 's'} recurrente${created === 1 ? '' : 's'}${skipped ? ` (${skipped} ya existían)` : ''}`
            : 'No hay gastos recurrentes nuevos por copiar',
          { type: created ? 'success' : 'info' }
        );
        if (created) await loadAll();
      } catch (error) {
        showToast(friendlyError(error), { type: 'error', duration: 5000 });
      }
    })
  );

  $('#btn-csv')?.addEventListener('click', (e) =>
    withLoading(e.currentTarget, async () => {
      try {
        exportCSV(buildExportData());
        showToast('CSV generado', { type: 'success' });
      } catch (error) {
        showToast(friendlyError(error), { type: 'error' });
      }
    })
  );

  $('#btn-pdf')?.addEventListener('click', (e) =>
    withLoading(e.currentTarget, async () => {
      try {
        const { exportPDF } = await import('../utils/pdfExport.js');
        await exportPDF(buildExportData());
        showToast('PDF generado', { type: 'success' });
      } catch (error) {
        showToast(`No se pudo generar el PDF: ${friendlyError(error)}`, { type: 'error', duration: 5000 });
      }
    })
  );

  $('#btn-logout')?.addEventListener('click', (e) =>
    withLoading(e.currentTarget, async () => {
      try {
        await teardown();
        await signOut();
      } catch (error) {
        showToast(friendlyError(error), { type: 'error' });
      } finally {
        window.location.replace('./index.html');
      }
    })
  );

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.loaded && renderChart(computeSummary()));

  window.addEventListener('pagehide', () => {
    state.pending.forEach((id) => budget.deleteTransaction(id).catch(() => {}));
    budget.unsubscribe(state.channel);
  });
}

async function teardown() {
  state.unsubAuth?.();
  state.unsubAuth = null;
  await budget.unsubscribe(state.channel);
  state.channel = null;
  destroyChart();
}

/* ------------------------------ Inicio ------------------------------ */
async function init() {
  setupPWA();
  initStealthToggle($('#btn-stealth'));

  const user = await requireAuth();
  if (!user) return;

  state.user = user;
  const navEmail = $('#nav-email');
  if (navEmail) {
    navEmail.textContent = user.email ?? '';
    navEmail.title = user.email ?? '';
  }

  state.ui = sanitizeUi(loadUiState(state.user.id));
  restoreControls();
  wireEvents();

  state.unsubAuth = onAuthChange((event) => {
    if (event === 'SIGNED_OUT') {
      teardown().finally(() => window.location.replace('./index.html'));
    }
  });

  if (security.isScreenLocked(state.user.id) && security.hasPinConfigured(state.user.id)) {
    showLockOverlay();
  }

  ['mousemove', 'keydown', 'touchstart', 'scroll'].forEach((evt) => {
    window.addEventListener(evt, resetInactivityTimer, { passive: true });
  });
  resetInactivityTimer();

  await loadAll();

  state.channel = budget.subscribeToChanges(state.user.id, () => scheduleReload());

  if (state.profile.monthly_income <= 0 && !state.onboardingShown) {
    state.onboardingShown = true;
    openIncomeModal({ onboarding: true });
  }

  checkQuickActions();
}

init();