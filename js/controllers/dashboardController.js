// js/controllers/dashboardController.js — Panel Principal completo con Seguridad y PWA
import Swal from 'sweetalert2';
import { requireAuth } from '../utils/authGuard.js';
import { signOut, onAuthChange } from '../services/authService.js';
import * as budget from '../services/budgetService.js';
import * as catService from '../services/categoryService.js';
import * as security from '../services/securityService.js';
import {
  escapeHTML,
  formatCurrency,
  friendlyError,
  getPeriodRange,
  initStealthToggle,
  roundMoney,
  showToast,
  sumMoney,
  toISODate
} from '../utils/helpers.js';

const RULES = {
  necesidades: { label: 'Necesidades', pct: 50 },
  deseos: { label: 'Deseos', pct: 30 },
  ahorro: { label: 'Ahorro', pct: 20 }
};
const RULE_KEYS = Object.keys(RULES);
const METHODS = { efectivo: 'Efectivo', debito: 'Débito', credito: 'Crédito', transferencia: 'Transferencia' };
const CURRENCIES = ['USD', 'EUR', 'COP', 'MXN', 'ARS', 'CLP', 'PEN', 'BRL', 'UYU', 'BOB', 'PYG', 'GTQ', 'CRC', 'DOP', 'GBP', 'CAD'];

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  user: null,
  profile: { monthly_income: 0, currency: 'USD' },
  transactions: [],
  categories: [],
  goals: [],
  debts: [],
  savingsTotal: 0
};

const fmt = (value) => formatCurrency(value, state.profile.currency);

/* ------------------------------ PWA ------------------------------ */
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
  installBtn?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted' && installBtn) {
      installBtn.hidden = true;
    }
    deferredPrompt = null;
  });
}

/* ------------------------------ Bloqueo y Seguridad ------------------------------ */
let inactivityTimer = null;

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (state.user && security.hasPinConfigured(state.user.id)) {
    inactivityTimer = setTimeout(() => triggerLockScreen(), 5 * 60 * 1000);
  }
}

function triggerLockScreen() {
  if (!state.user || !security.hasPinConfigured(state.user.id)) return;
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
        <span class="pin-dot" id="dot-0"></span><span class="pin-dot" id="dot-1"></span>
        <span class="pin-dot" id="dot-2"></span><span class="pin-dot" id="dot-3"></span>
      </div>
      <div class="pin-pad">
        <button class="btn ghost" data-num="1">1</button><button class="btn ghost" data-num="2">2</button><button class="btn ghost" data-num="3">3</button>
        <button class="btn ghost" data-num="4">4</button><button class="btn ghost" data-num="5">5</button><button class="btn ghost" data-num="6">6</button>
        <button class="btn ghost" data-num="7">7</button><button class="btn ghost" data-num="8">8</button><button class="btn ghost" data-num="9">9</button>
        <button class="btn ghost danger" id="btn-pin-clear">⌫</button><button class="btn ghost" data-num="0">0</button>
        ${hasBio ? '<button class="btn ghost success" id="btn-bio-unlock">👆</button>' : '<div></div>'}
      </div>
      <div style="margin-top: 1.5rem;">
        <button class="btn ghost small danger" id="btn-lock-logout">Cerrar sesión</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  let enteredPin = '';

  const updateDots = () => {
    for (let i = 0; i < 4; i++) {
      const dot = document.getElementById(`dot-${i}`);
      if (dot) dot.classList.toggle('filled', i < enteredPin.length);
    }
  };

  overlay.querySelectorAll('[data-num]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (enteredPin.length < 4) {
        enteredPin += btn.dataset.num;
        updateDots();
      }
      if (enteredPin.length === 4) {
        if (await security.verifyPin(state.user.id, enteredPin)) {
          security.unlockScreen(state.user.id);
          overlay.remove();
        } else {
          showToast('PIN incorrecto', { type: 'error' });
          enteredPin = '';
          updateDots();
        }
      }
    });
  });

  document.getElementById('btn-pin-clear')?.addEventListener('click', () => {
    enteredPin = enteredPin.slice(0, -1);
    updateDots();
  });

  document.getElementById('btn-lock-logout')?.addEventListener('click', async () => {
    overlay.remove();
    await signOut();
    window.location.replace('./index.html');
  });

  if (hasBio) {
    document.getElementById('btn-bio-unlock')?.addEventListener('click', async () => {
      if (await security.verifyBiometrics(state.user.id)) {
        security.unlockScreen(state.user.id);
        overlay.remove();
      }
    });
  }
}

async function configurePinModal() {
  const { value: pin } = await Swal.fire({
    title: 'Configurar PIN de 4 dígitos',
    input: 'password',
    inputAttributes: { maxlength: 4, inputmode: 'numeric', pattern: '[0-9]*' },
    background: 'var(--surface)',
    color: 'var(--text)',
    showCancelButton: true,
    confirmButtonText: 'Guardar',
    cancelButtonText: 'Cancelar',
    inputValidator: (value) => {
      if (!value || value.length !== 4 || !/^\d{4}$/.test(value)) {
        return 'El PIN debe tener exactamente 4 números.';
      }
    }
  });

  if (pin) {
    await security.savePin(state.user.id, pin);
    showToast('PIN guardado exitosamente', { type: 'success' });
  }
}

async function openSecurityModal() {
  const hasPin = security.hasPinConfigured(state.user.id);
  const hasBio = security.hasBiometricsConfigured(state.user.id);

  await Swal.fire({
    title: '⚙️ Seguridad y PIN',
    background: 'var(--surface)',
    color: 'var(--text)',
    html: `
      <div style="text-align:left; font-size: 0.9rem; display:flex; flex-direction:column; gap:1rem;">
        <div>
          <p style="margin-bottom:0.5rem;"><strong>PIN de Bloqueo (4 dígitos):</strong> ${hasPin ? '✅ Configurado' : '❌ No configurado'}</p>
          <button type="button" class="btn small primary" id="swal-btn-pin">${hasPin ? 'Cambiar PIN' : 'Configurar PIN'}</button>
          ${hasPin ? '<button type="button" class="btn small danger" id="swal-btn-remove-pin" style="margin-left:0.5rem;">Eliminar PIN</button>' : ''}
        </div>
        <hr style="border-color:var(--border, #334155); margin:0;">
        <div>
          <p style="margin-bottom:0.5rem;"><strong>Biometría / WebAuthn:</strong> ${hasBio ? '✅ Configurada' : '❌ No configurada'}</p>
          ${hasPin ? `<button type="button" class="btn small ${hasBio ? 'danger' : 'success'}" id="swal-btn-bio">${hasBio ? 'Desactivar Biometría' : 'Activar Biometría'}</button>` : '<p style="font-size:0.8rem; color:var(--text-muted, #94a3b8);">Configura un PIN primero para activar la biometría.</p>'}
        </div>
      </div>
    `,
    showConfirmButton: false,
    showCancelButton: true,
    cancelButtonText: 'Cerrar',
    didOpen: (popup) => {
      $('#swal-btn-pin', popup)?.addEventListener('click', async () => {
        Swal.close();
        await configurePinModal();
      });
      $('#swal-btn-remove-pin', popup)?.addEventListener('click', async () => {
        Swal.close();
        security.removePin(state.user.id);
        showToast('PIN eliminado', { type: 'info' });
      });
      $('#swal-btn-bio', popup)?.addEventListener('click', async () => {
        Swal.close();
        if (hasBio) {
          security.disableBiometrics(state.user.id);
          showToast('Biometría desactivada', { type: 'info' });
        } else {
          const registered = await security.registerBiometrics(state.user.id, state.user.email);
          if (registered) showToast('Biometría activada correctamente', { type: 'success' });
          else showToast('No se pudo activar la biometría en este dispositivo', { type: 'error' });
        }
      });
    }
  });
}

/* ------------------------------ Cántulos y Render ------------------------------ */
function computeSummary() {
  const range = getPeriodRange('mes_actual');
  const rows = state.transactions.filter((t) => t.fecha >= range.from && t.fecha <= range.to);
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

  return { range, rows, income, extraIncome, categories, totalSpent: sumMoney(gastos.map((t) => t.monto)), locked: baseIncome <= 0 };
}

function allocateGoals() {
  let remaining = state.savingsTotal;
  return state.goals.map((goal) => {
    const assigned = Math.min(remaining, goal.monto_objetivo);
    remaining = roundMoney(remaining - assigned);
    return { ...goal, progress: roundMoney(assigned) };
  });
}

function setKpi(id, { value, cap, left, pct, over }) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('skeleton');
  $('[data-field="value"]', el).textContent = value;
  $('[data-field="cap"]', el).textContent = cap;
  const leftEl = $('[data-field="left"]', el);
  leftEl.textContent = left;
  leftEl.classList.toggle('over', over);

  const bar = $('.progress', el);
  const clamped = Math.min(Math.max(pct, 0), 100);
  bar.style.setProperty('--pct', `${clamped.toFixed(1)}%`);
  bar.classList.toggle('over', over);
}

function renderKpis(summary) {
  const onboarding = $('#onboarding');
  if (onboarding) onboarding.hidden = !summary.locked;

  const incomeBase = summary.income + summary.extraIncome;
  const incomeOver = !summary.locked && summary.totalSpent > incomeBase;

  setKpi('kpi-income', {
    value: fmt(summary.income),
    cap: `Ingresos extra: ${fmt(summary.extraIncome)}`,
    left: summary.locked ? 'Configura tu ingreso' : incomeOver ? `Excedido por: ${fmt(summary.totalSpent - incomeBase)}` : `Disponible: ${fmt(incomeBase - summary.totalSpent)}`,
    pct: incomeBase > 0 ? (summary.totalSpent / incomeBase) * 100 : 0,
    over: incomeOver
  });

  for (const c of summary.categories) {
    setKpi(`kpi-${c.key === 'necesidades' ? 'needs' : c.key === 'deseos' ? 'wants' : 'save'}`, {
      value: fmt(c.spent),
      cap: summary.locked ? 'Tope: configura ingreso' : `Tope ${c.pct}%: ${fmt(c.assigned)}`,
      left: summary.locked ? 'Bloqueado' : c.over ? `Excedido por: ${fmt(-c.diff)}` : `Disponible: ${fmt(c.diff)}`,
      pct: c.usage,
      over: c.over
    });
  }
}

function renderGoals() {
  const list = $('#goals-list');
  if (!list) return;
  const goals = allocateGoals();
  if (!goals.length) {
    list.innerHTML = '<p class="goal-meta">Crea una meta o inversión. Se financiará con el 20% de Ahorro.</p>';
    return;
  }
  list.innerHTML = `<p class="goal-meta">Ahorro acumulado: <strong class="sensitive">${escapeHTML(fmt(state.savingsTotal))}</strong></p>` +
    goals.map((g) => {
      const pct = g.monto_objetivo > 0 ? Math.min(100, (g.progress / g.monto_objetivo) * 100) : 0;
      const name = escapeHTML(g.nombre);
      return `<article class="goal" data-id="${escapeHTML(g.id)}">
        <div class="goal-head">
          <span class="goal-name">${name}</span>
          <span class="row-actions">
            <button class="btn small icon no-print" type="button" data-goal-action="edit">✏️</button>
            <button class="btn small icon no-print" type="button" data-goal-action="delete">🗑️</button>
          </span>
        </div>
        <div class="progress" style="--pct:${pct.toFixed(1)}%"></div>
        <span class="goal-meta sensitive">${escapeHTML(fmt(g.progress))} de ${escapeHTML(fmt(g.monto_objetivo))} · ${pct.toFixed(0)}%</span>
      </article>`;
    }).join('');
}

function renderDebts() {
  const list = $('#debts-list');
  if (!list) return;
  if (!state.debts.length) {
    list.innerHTML = '<p class="goal-meta">Registra una deuda para dar seguimiento a saldos y abonos.</p>';
    return;
  }
  const totalDebt = sumMoney(state.debts.map((d) => d.monto_total));
  const totalPaid = sumMoney(state.debts.map((d) => d.monto_pagado));
  list.innerHTML = `<p class="goal-meta">Total amortizado: <strong class="sensitive">${escapeHTML(fmt(totalPaid))}</strong> de <strong class="sensitive">${escapeHTML(fmt(totalDebt))}</strong></p>` +
    state.debts.map((d) => {
      const pct = d.monto_total > 0 ? Math.min(100, (d.monto_pagado / d.monto_total) * 100) : 0;
      const name = escapeHTML(d.nombre);
      return `<article class="goal debt-item" data-id="${escapeHTML(d.id)}">
        <div class="goal-head">
          <span class="goal-name">${name}</span>
          <span class="row-actions">
            <button class="btn small icon no-print" type="button" data-debt-action="edit">✏️</button>
            <button class="btn small icon no-print" type="button" data-debt-action="delete">🗑️</button>
          </span>
        </div>
        <div class="progress" style="--pct:${pct.toFixed(1)}%; background: rgba(220, 38, 38, 0.15);"></div>
        <span class="goal-meta sensitive">${escapeHTML(fmt(d.monto_pagado))} de ${escapeHTML(fmt(d.monto_total))} · ${pct.toFixed(0)}%</span>
      </article>`;
    }).join('');
}

function renderAll() {
  const summary = computeSummary();
  renderKpis(summary);
  renderGoals();
  renderDebts();
}

/* ------------------------------ Modales ------------------------------ */
async function openTransactionModal() {
  if (!state.categories.length) return openCategoryManager();
  const result = await Swal.fire({
    title: 'Nueva transacción',
    background: 'var(--surface)', color: 'var(--text)',
    html: `<form class="swal-form" id="tx-form">
      <label>Concepto <input id="tx-concepto" type="text" required placeholder="Ej. Supermercado"></label>
      <div class="row">
        <label>Monto <input id="tx-monto" type="number" step="0.01" min="0.01" required placeholder="0.00"></label>
        <label>Tipo <select id="tx-tipo"><option value="gasto">Gasto</option><option value="ingreso">Ingreso</option></select></label>
      </div>
      <div id="tx-category-row">
        <label>Categoría <select id="tx-detalle">${state.categories.map(c => `<option value="${escapeHTML(c.nombre)}" data-rule="${c.categoria_503020}">${escapeHTML(c.nombre)}</option>`).join('')}</select></label>
      </div>
      <div class="row">
        <label>Pago <select id="tx-metodo">${Object.entries(METHODS).map(([k, val]) => `<option value="${k}">${val}</option>`).join('')}</select></label>
        <label>Fecha <input id="tx-fecha" type="date" required value="${toISODate(new Date())}"></label>
      </div>
    </form>`,
    showCancelButton: true,
    preConfirm: async () => {
      const popup = Swal.getPopup();
      const concepto = $('#tx-concepto', popup).value.trim();
      const monto = Number($('#tx-monto', popup).value);
      const tipo = $('#tx-tipo', popup).value;
      const fecha = $('#tx-fecha', popup).value;
      const opt = $('#tx-detalle', popup).selectedOptions[0];

      if (!concepto || !monto || monto <= 0) return Swal.showValidationMessage('Campos requeridos vacíos');

      const payload = {
        concepto, monto: roundMoney(monto), tipo,
        categoria_503020: tipo === 'ingreso' ? 'necesidades' : opt.dataset.rule,
        categoria_detalle: tipo === 'ingreso' ? 'Ingreso' : opt.value,
        metodo_pago: $('#tx-metodo', popup).value, fecha
      };
      return await budget.createTransaction(payload);
    }
  });

  if (result.isConfirmed) {
    showToast('Transacción creada', { type: 'success' });
    await loadAll();
  }
}

async function openIncomeModal() {
  const result = await Swal.fire({
    title: 'Ingreso mensual y divisa',
    background: 'var(--surface)', color: 'var(--text)',
    html: `<form class="swal-form" id="income-form">
      <label>Ingreso mensual base <input id="inc-monto" type="number" step="0.01" min="0.01" value="${state.profile.monthly_income || ''}" required></label>
      <label>Divisa <select id="inc-currency">${CURRENCIES.map(c => `<option value="${c}"${c === state.profile.currency ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
    </form>`,
    showCancelButton: true,
    preConfirm: async () => {
      const popup = Swal.getPopup();
      const monthly_income = Number($('#inc-monto', popup).value);
      if (!monthly_income || monthly_income <= 0) return Swal.showValidationMessage('Ingresa un valor válido');
      return await budget.updateProfile(state.user.id, { monthly_income, currency: $('#inc-currency', popup).value });
    }
  });

  if (result.isConfirmed) {
    state.profile = result.value;
    showToast('Ingreso actualizado', { type: 'success' });
    await loadAll();
  }
}

async function openGoalModal(goal = null) {
  const isEdit = Boolean(goal);
  const result = await Swal.fire({
    title: isEdit ? 'Editar Meta' : 'Nueva Meta',
    background: 'var(--surface)', color: 'var(--text)',
    html: `<form class="swal-form" id="goal-form">
      <label>Nombre <input id="goal-nombre" type="text" required value="${escapeHTML(goal?.nombre ?? '')}"></label>
      <label>Monto objetivo <input id="goal-monto" type="number" step="0.01" min="0.01" required value="${escapeHTML(goal?.monto_objetivo ?? '')}"></label>
    </form>`,
    showCancelButton: true,
    preConfirm: async () => {
      const popup = Swal.getPopup();
      const nombre = $('#goal-nombre', popup).value.trim();
      const monto = Number($('#goal-monto', popup).value);
      if (!nombre || !monto || monto <= 0) return Swal.showValidationMessage('Completa los campos');
      return isEdit ? await budget.updateGoal(goal.id, { nombre, monto_objetivo: roundMoney(monto) }) : await budget.createGoal({ nombre, monto_objetivo: roundMoney(monto) });
    }
  });

  if (result.isConfirmed) {
    showToast('Meta guardada', { type: 'success' });
    await loadAll();
  }
}

async function openDebtModal(debt = null) {
  const isEdit = Boolean(debt);
  const result = await Swal.fire({
    title: isEdit ? 'Editar Deuda' : 'Nueva Deuda',
    background: 'var(--surface)', color: 'var(--text)',
    html: `<form class="swal-form" id="debt-form">
      <label>Nombre <input id="debt-nombre" type="text" required value="${escapeHTML(debt?.nombre ?? '')}"></label>
      <div class="row">
        <label>Monto total <input id="debt-total" type="number" step="0.01" min="0.01" required value="${escapeHTML(debt?.monto_total ?? '')}"></label>
        <label>Monto pagado <input id="debt-pagado" type="number" step="0.01" min="0" value="${escapeHTML(debt?.monto_pagado ?? 0)}"></label>
      </div>
    </form>`,
    showCancelButton: true,
    preConfirm: async () => {
      const popup = Swal.getPopup();
      const nombre = $('#debt-nombre', popup).value.trim();
      const total = Number($('#debt-total', popup).value);
      const pagado = Number($('#debt-pagado', popup).value) || 0;
      if (!nombre || !total || total <= 0) return Swal.showValidationMessage('Ingresa datos válidos');
      return isEdit ? await budget.updateDebt(debt.id, { nombre, monto_total: roundMoney(total), monto_pagado: roundMoney(pagado) }) : await budget.createDebt({ nombre, monto_total: roundMoney(total), monto_pagado: roundMoney(pagado) });
    }
  });

  if (result.isConfirmed) {
    showToast('Deuda guardada', { type: 'success' });
    await loadAll();
  }
}

async function openCategoryManager() {
  await Swal.fire({
    title: 'Categorías',
    background: 'var(--surface)', color: 'var(--text)',
    html: `<div style="text-align:left;">
      <p style="font-size:0.85rem;">Las categorías se administran en tus transacciones.</p>
      <ul>${state.categories.map(c => `<li><strong>${escapeHTML(c.nombre)}</strong> (${c.categoria_503020})</li>`).join('')}</ul>
    </div>`,
    confirmButtonText: 'Cerrar'
  });
}

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
    renderAll();
  } catch (error) {
    showToast(friendlyError(error), { type: 'error' });
  }
}

function wireEvents() {
  $('#btn-add')?.addEventListener('click', () => openTransactionModal());
  $('#btn-income')?.addEventListener('click', () => openIncomeModal());
  $('#btn-onboard')?.addEventListener('click', () => openIncomeModal());
  $('#btn-goal')?.addEventListener('click', () => openGoalModal());
  $('#btn-debt')?.addEventListener('click', () => openDebtModal());
  $('#btn-categories')?.addEventListener('click', () => openCategoryManager());

  // Navegación superior
  $('#btn-security-settings')?.addEventListener('click', () => openSecurityModal());
  $('#btn-lock-now')?.addEventListener('click', () => {
    if (!security.hasPinConfigured(state.user.id)) {
      showToast('Configura un PIN primero para activar el bloqueo', { type: 'info' });
      openSecurityModal();
    } else {
      triggerLockScreen();
    }
  });
  $('#btn-logout')?.addEventListener('click', async () => { await signOut(); window.location.replace('./index.html'); });

  // Listas
  $('#goals-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-goal-action]');
    if (!btn) return;
    const goal = state.goals.find((g) => g.id === btn.closest('.goal')?.dataset.id);
    if (!goal) return;
    if (btn.dataset.goalAction === 'edit') openGoalModal(goal);
    if (btn.dataset.goalAction === 'delete') {
      await budget.deleteGoal(goal.id);
      showToast('Meta eliminada', { type: 'success' });
      await loadAll();
    }
  });

  $('#debts-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-debt-action]');
    if (!btn) return;
    const debt = state.debts.find((d) => d.id === btn.closest('.debt-item')?.dataset.id);
    if (!debt) return;
    if (btn.dataset.debtAction === 'edit') openDebtModal(debt);
    if (btn.dataset.debtAction === 'delete') {
      await budget.deleteDebt(debt.id);
      showToast('Deuda eliminada', { type: 'success' });
      await loadAll();
    }
  });
}

async function init() {
  initStealthToggle($('#btn-stealth'));
  setupPWA();

  const user = await requireAuth();
  if (!user) return;
  state.user = user;

  const navEmail = $('#nav-email');
  if (navEmail) navEmail.textContent = user.email ?? '';

  wireEvents();

  if (security.isScreenLocked(state.user.id) && security.hasPinConfigured(state.user.id)) {
    showLockOverlay();
  }

  ['mousemove', 'keydown', 'touchstart'].forEach((evt) => window.addEventListener(evt, resetInactivityTimer, { passive: true }));
  resetInactivityTimer();

  await loadAll();
}

init();