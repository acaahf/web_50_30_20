// js/controllers/transactionsController.js — Controlador completo de la pestaña de Transacciones
import Swal from 'sweetalert2';
import { requireAuth } from '../utils/authGuard.js';
import { signOut, onAuthChange } from '../services/authService.js';
import * as budget from '../services/budgetService.js';
import * as catService from '../services/categoryService.js';
import * as security from '../services/securityService.js';
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
  necesidades: { label: 'Necesidades', pct: 50 },
  deseos: { label: 'Deseos', pct: 30 },
  ahorro: { label: 'Ahorro', pct: 20 }
};
const RULE_KEYS = Object.keys(RULES);
const METHODS = { efectivo: 'Efectivo', debito: 'Débito', credito: 'Crédito', transferencia: 'Transferencia' };
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
  ui: { ...DEFAULT_UI },
  channel: null,
  pending: new Set(),
  unsubAuth: null
};

const fmt = (value) => formatCurrency(value, state.profile.currency);

function sanitizeUi(raw = {}) {
  const ui = { ...DEFAULT_UI };
  if (['todas', ...RULE_KEYS].includes(raw.rule)) ui.rule = raw.rule;
  if (['todos', ...Object.keys(METHODS)].includes(raw.method)) ui.method = raw.method;
  if (typeof raw.category === 'string') ui.category = raw.category;
  if (['mes_actual', 'mes_anterior', 'anio'].includes(raw.period)) ui.period = raw.period;
  if (typeof raw.search === 'string') ui.search = raw.search.slice(0, 100);
  if ([5, 10, 25, 50].includes(Number(raw.pageSize))) ui.pageSize = Number(raw.pageSize);
  const page = Number(raw.page);
  if (Number.isInteger(page) && page >= 1) ui.page = page;
  if (['fecha', 'monto'].includes(raw.sortKey)) ui.sortKey = raw.sortKey;
  if (['asc', 'desc'].includes(raw.sortDir)) ui.sortDir = raw.sortDir;
  return ui;
}

const persistUi = () => state.user && saveUiState(state.user.id, state.ui);

/* ------------------------------ Bloqueo y PIN ------------------------------ */
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

/* ------------------------------ Lógica de Tabla y Filtros ------------------------------ */
const visibleTransactions = () => state.transactions.filter((t) => !state.pending.has(t.id));

function sortRows(rows) {
  const { sortKey, sortDir } = state.ui;
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp = sortKey === 'monto' ? a.monto - b.monto : a.fecha.localeCompare(b.fecha);
    if (cmp === 0) cmp = String(a.created_at).localeCompare(String(b.created_at));
    return cmp * dir;
  });
}

function filteredRows() {
  const range = getPeriodRange(state.ui.period);
  const { rule, method, search, category } = state.ui;
  const term = normalizeText(search);

  const rows = visibleTransactions().filter((t) => {
    if (t.fecha < range.from || t.fecha > range.to) return false;
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
    : `<span class="badge ${escapeHTML(t.categoria_503020)}">${RULES[t.categoria_503020]?.pct ?? ''}% ${RULES[t.categoria_503020]?.label ?? ''}</span>`;
  const concept = escapeHTML(t.concepto);
  return `<tr data-id="${escapeHTML(t.id)}">
    <td data-label="Fecha">${escapeHTML(formatDate(t.fecha))}</td>
    <td class="concept" data-label="Concepto">${concept}${t.es_recurrente ? ' 🔁' : ''}</td>
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

function renderTable() {
  const body = $('#tx-body');
  if (!body) return;
  const rows = filteredRows();
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
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'es'));
  select.innerHTML = '<option value="todas">Todas</option>' + sorted.map((n) => `<option value="${escapeHTML(n)}">${escapeHTML(n)}</option>`).join('');
  select.value = names.has(state.ui.category) ? state.ui.category : 'todas';
}

async function loadAll() {
  try {
    const from = `${new Date().getFullYear() - 1}-12-01`;
    const [profile, transactions, userCategories] = await Promise.all([
      budget.getProfile(state.user.id),
      budget.listTransactions(from),
      catService.listCategories()
    ]);
    Object.assign(state, { profile, transactions, categories: userCategories });
    renderCategoryFilter();
    renderTable();
  } catch (error) {
    showToast(friendlyError(error), { type: 'error' });
  }
}

/* ------------------------------ Modales ------------------------------ */
const options = (list, selected) =>
  list
    .map(([value, label]) => `<option value="${escapeHTML(value)}"${value === selected ? ' selected' : ''}>${escapeHTML(label)}</option>`)
    .join('');

async function openTransactionModal(tx = null) {
  const isEdit = Boolean(tx);
  const v = tx ?? {
    concepto: '', monto: '', tipo: 'gasto',
    categoria_503020: state.categories[0]?.categoria_503020 ?? 'necesidades',
    categoria_detalle: state.categories[0]?.nombre ?? '',
    metodo_pago: 'debito', es_recurrente: false, fecha: toISODate(new Date())
  };

  const result = await Swal.fire({
    title: isEdit ? 'Editar transacción' : 'Nueva transacción',
    background: 'var(--surface)', color: 'var(--text)',
    html: `<form class="swal-form" id="tx-form">
      <label>Concepto <input id="tx-concepto" type="text" required value="${escapeHTML(v.concepto)}" placeholder="Ej. Mercado"></label>
      <div class="row">
        <label>Monto <input id="tx-monto" type="number" step="0.01" min="0.01" max="${MAX_AMOUNT}" required value="${escapeHTML(v.monto)}"></label>
        <label>Tipo <select id="tx-tipo">${options([['gasto', 'Gasto'], ['ingreso', 'Ingreso']], v.tipo)}</select></label>
      </div>
      <div id="tx-category-row">
        <label>Categoría <select id="tx-detalle">${categoryOptionsHtml(v.categoria_detalle, tx)}</select></label>
      </div>
      <div class="row">
        <label>Pago <select id="tx-metodo">${options(Object.entries(METHODS), v.metodo_pago)}</select></label>
        <label>Fecha <input id="tx-fecha" type="date" required value="${escapeHTML(v.fecha)}"></label>
      </div>
    </form>`,
    showCancelButton: true,
    confirmButtonText: 'Guardar',
    cancelButtonText: 'Cancelar',
    didOpen: (popup) => {
      const tipo = $('#tx-tipo', popup);
      const toggle = () => { $('#tx-category-row', popup).hidden = tipo.value === 'ingreso'; };
      tipo.addEventListener('change', toggle);
      toggle();
    },
    preConfirm: async () => {
      const popup = Swal.getPopup();
      const concepto = $('#tx-concepto', popup).value.trim();
      const monto = Number($('#tx-monto', popup).value);
      const tipo = $('#tx-tipo', popup).value;
      const fecha = $('#tx-fecha', popup).value;
      const opt = $('#tx-detalle', popup).selectedOptions[0];

      if (!concepto || !monto || monto <= 0) return Swal.showValidationMessage('Escribe concepto y monto válidos.');

      const payload = {
        concepto, monto: roundMoney(monto), tipo,
        categoria_503020: tipo === 'ingreso' ? 'necesidades' : opt.dataset.rule,
        categoria_detalle: tipo === 'ingreso' ? 'Ingreso' : opt.value,
        metodo_pago: $('#tx-metodo', popup).value, fecha
      };
      return isEdit ? await budget.updateTransaction(tx.id, payload) : await budget.createTransaction(payload);
    }
  });

  if (result.isConfirmed) {
    showToast('Transacción guardada', { type: 'success' });
    await loadAll();
  }
}

function deleteWithUndo(id) {
  if (!state.transactions.some((t) => t.id === id) || state.pending.has(id)) return;
  state.pending.add(id);
  renderTable();

  showToast('Transacción eliminada', {
    type: 'info',
    duration: 5000,
    actionLabel: 'Deshacer',
    onAction: () => {
      state.pending.delete(id);
      renderTable();
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
    showToast(`No se pudo eliminar: ${friendlyError(error)}`, { type: 'error' });
  } finally {
    state.pending.delete(id);
    renderTable();
  }
}

function buildExportData() {
  const range = getPeriodRange(state.ui.period);
  const rows = filteredRows();
  return {
    user: { email: state.user.email },
    currency: state.profile.currency,
    periodLabel: range.label,
    range,
    summary: {
      income: state.profile.monthly_income,
      totalSpent: sumMoney(rows.filter((t) => t.tipo === 'gasto').map((t) => t.monto)),
      categories: []
    },
    transactions: rows
  };
}

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
    renderTable();
  };

  $('#f-search')?.addEventListener('input', debounce(onFilter('search'), 150));
  $('#f-rule')?.addEventListener('change', onFilter('rule'));
  $('#f-method')?.addEventListener('change', onFilter('method'));
  $('#f-category')?.addEventListener('change', onFilter('category'));
  $('#f-period')?.addEventListener('change', onFilter('period'));
  $('#page-size')?.addEventListener('change', (e) => { state.ui.pageSize = Number(e.target.value); state.ui.page = 1; renderTable(); });
  $('#page-prev')?.addEventListener('click', () => { state.ui.page--; renderTable(); });
  $('#page-next')?.addEventListener('click', () => { state.ui.page++; renderTable(); });

  const sortBy = (th) => {
    const key = th.dataset.sort;
    state.ui.sortDir = state.ui.sortKey === key ? (state.ui.sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    state.ui.sortKey = key;
    state.ui.page = 1;
    renderTable();
  };

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => sortBy(th));
  });

  $('#btn-add')?.addEventListener('click', () => openTransactionModal());
  $('#btn-clone')?.addEventListener('click', (e) =>
    withLoading(e.currentTarget, async () => {
      try {
        const { created } = await budget.cloneRecurringExpenses();
        showToast(created ? `Se copiaron ${created} gastos` : 'Sin gastos por copiar', { type: created ? 'success' : 'info' });
        if (created) await loadAll();
      } catch (error) {
        showToast(friendlyError(error), { type: 'error' });
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
        showToast(`Error al generar PDF: ${friendlyError(error)}`, { type: 'error' });
      }
    })
  );

  $('#btn-lock-now')?.addEventListener('click', () => triggerLockScreen());
  $('#btn-logout')?.addEventListener('click', async () => { await signOut(); window.location.replace('./index.html'); });

  $('#tx-body')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('tr')?.dataset.id;
    const tx = state.transactions.find((t) => t.id === id);
    if (!tx) return;
    if (btn.dataset.action === 'edit') openTransactionModal(tx);
    if (btn.dataset.action === 'delete') deleteWithUndo(id);
  });
}

async function init() {
  initStealthToggle($('#btn-stealth'));
  const user = await requireAuth();
  if (!user) return;

  state.user = user;
  const navEmail = $('#nav-email');
  if (navEmail) navEmail.textContent = user.email ?? '';

  state.ui = sanitizeUi(loadUiState(state.user.id));
  restoreControls();
  wireEvents();

  state.unsubAuth = onAuthChange((event) => {
    if (event === 'SIGNED_OUT') window.location.replace('./index.html');
  });

  if (security.isScreenLocked(state.user.id) && security.hasPinConfigured(state.user.id)) showLockOverlay();

  ['mousemove', 'keydown', 'touchstart', 'scroll'].forEach((evt) => {
    window.addEventListener(evt, resetInactivityTimer, { passive: true });
  });
  resetInactivityTimer();

  await loadAll();

  state.channel = budget.subscribeToChanges(state.user.id, () => loadAll());
}

init();