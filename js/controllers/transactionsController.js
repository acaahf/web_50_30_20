// js/controllers/transactionsController.js
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
  normalizeText,
  roundMoney,
  showToast,
  sumMoney,
  toISODate,
  withLoading
} from '../utils/helpers.js';

const RULES = {
  necesidades: { label: 'Necesidades', pct: 50 },
  deseos: { label: 'Deseos', pct: 30 },
  ahorro: { label: 'Ahorro', pct: 20 }
};
const RULE_KEYS = Object.keys(RULES);
const METHODS = { efectivo: 'Efectivo', debito: 'Débito', credito: 'Crédito', transferencia: 'Transferencia' };
const MAX_AMOUNT = 9999999999.99;

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  user: null,
  profile: { monthly_income: 0, currency: 'USD' },
  transactions: [],
  categories: [],
  ui: {
    rule: 'todas',
    category: 'todas',
    method: 'todos',
    period: 'todos',
    search: '',
    page: 1,
    pageSize: 10,
    sortKey: 'fecha',
    sortDir: 'desc'
  },
  pending: new Set()
};

const fmt = (value) => formatCurrency(value, state.profile.currency);

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
  const { rule, method, search, category, period } = state.ui;
  const term = normalizeText(search);

  return sortRows(
    state.transactions.filter((t) => {
      if (state.pending.has(t.id)) return false;

      if (period !== 'todos') {
        const range = getPeriodRange(period);
        if (t.fecha < range.from || t.fecha > range.to) return false;
      }

      if (rule !== 'todas' && !(t.tipo === 'gasto' && t.categoria_503020 === rule)) return false;
      if (method !== 'todos' && t.metodo_pago !== method) return false;
      if (category !== 'todas' && t.categoria_detalle !== category) return false;
      if (term && !normalizeText(`${t.concepto} ${t.categoria_detalle}`).includes(term)) return false;

      return true;
    })
  );
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
      <button class="btn small icon" type="button" data-action="edit">✏️</button>
      <button class="btn small icon" type="button" data-action="delete">🗑️</button>
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
    : '<tr><td colspan="7" class="empty-state">No hay transacciones registradas o que coincidan con los filtros.</td></tr>';

  const info = $('#page-info');
  if (info) info.textContent = `Página ${state.ui.page} de ${pages} · ${rows.length} registros`;
  const prev = $('#page-prev');
  if (prev) prev.disabled = state.ui.page <= 1;
  const next = $('#page-next');
  if (next) next.disabled = state.ui.page >= pages;
}

function renderCategoryFilter() {
  const select = $('#f-category');
  if (!select) return;
  const names = new Set(state.categories.map((c) => c.nombre));
  state.transactions.forEach((t) => {
    if (t.tipo === 'gasto') names.add(t.categoria_detalle);
  });
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'es'));
  select.innerHTML = '<option value="todas">Todas</option>' + sorted.map((n) => `<option value="${escapeHTML(n)}">${escapeHTML(n)}</option>`).join('');
  select.value = state.ui.category;
}

async function loadAll() {
  try {
    const [profile, transactions, userCategories] = await Promise.all([
      budget.getProfile(state.user.id),
      budget.listTransactions('2000-01-01'),
      catService.listCategories()
    ]);
    Object.assign(state, { profile, transactions, categories: userCategories });
    renderCategoryFilter();
    renderTable();
  } catch (error) {
    showToast(friendlyError(error), { type: 'error' });
  }
}

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
      <label>Concepto <input id="tx-concepto" type="text" required value="${escapeHTML(v.concepto)}"></label>
      <div class="row">
        <label>Monto <input id="tx-monto" type="number" step="0.01" min="0.01" required value="${escapeHTML(v.monto)}"></label>
        <label>Tipo <select id="tx-tipo"><option value="gasto"${v.tipo === 'gasto' ? ' selected' : ''}>Gasto</option><option value="ingreso"${v.tipo === 'ingreso' ? ' selected' : ''}>Ingreso</option></select></label>
      </div>
      <div id="tx-category-row">
        <label>Categoría <select id="tx-detalle">${state.categories.map(c => `<option value="${escapeHTML(c.nombre)}" data-rule="${c.categoria_503020}">${escapeHTML(c.nombre)}</option>`).join('')}</select></label>
      </div>
      <div class="row">
        <label>Pago <select id="tx-metodo">${Object.entries(METHODS).map(([k, val]) => `<option value="${k}"${v.metodo_pago === k ? ' selected' : ''}>${val}</option>`).join('')}</select></label>
        <label>Fecha <input id="tx-fecha" type="date" required value="${escapeHTML(v.fecha)}"></label>
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
      return isEdit ? await budget.updateTransaction(tx.id, payload) : await budget.createTransaction(payload);
    }
  });

  if (result.isConfirmed) {
    showToast('Transacción guardada', { type: 'success' });
    await loadAll();
  }
}

function wireEvents() {
  $('#f-search')?.addEventListener('input', debounce((e) => { state.ui.search = e.target.value; state.ui.page = 1; renderTable(); }, 150));
  $('#f-rule')?.addEventListener('change', (e) => { state.ui.rule = e.target.value; state.ui.page = 1; renderTable(); });
  $('#f-method')?.addEventListener('change', (e) => { state.ui.method = e.target.value; state.ui.page = 1; renderTable(); });
  $('#f-category')?.addEventListener('change', (e) => { state.ui.category = e.target.value; state.ui.page = 1; renderTable(); });
  $('#f-period')?.addEventListener('change', (e) => { state.ui.period = e.target.value; state.ui.page = 1; renderTable(); });
  $('#page-size')?.addEventListener('change', (e) => { state.ui.pageSize = Number(e.target.value); state.ui.page = 1; renderTable(); });
  $('#page-prev')?.addEventListener('click', () => { state.ui.page--; renderTable(); });
  $('#page-next')?.addEventListener('click', () => { state.ui.page++; renderTable(); });

  $('#btn-add')?.addEventListener('click', () => openTransactionModal());
  $('#btn-logout')?.addEventListener('click', async () => { await signOut(); window.location.replace('./index.html'); });

  $('#tx-body')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('tr')?.dataset.id;
    const tx = state.transactions.find((t) => t.id === id);
    if (!tx) return;
    if (btn.dataset.action === 'edit') openTransactionModal(tx);
    if (btn.dataset.action === 'delete') {
      await budget.deleteTransaction(id);
      showToast('Transacción eliminada', { type: 'success' });
      await loadAll();
    }
  });
}

async function init() {
  initStealthToggle($('#btn-stealth'));
  const user = await requireAuth();
  if (!user) return;

  state.user = user;
  const navEmail = $('#nav-email');
  if (navEmail) navEmail.textContent = user.email ?? '';

  wireEvents();
  await loadAll();
  state.channel = budget.subscribeToChanges(state.user.id, () => loadAll());
}

init();