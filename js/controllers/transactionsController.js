// js/controllers/transactionsController.js — Controlador del Histórico de Transacciones
import Swal from 'sweetalert2';
import { jsPDF } from 'jspdf';
import { requireAuth } from '../utils/authGuard.js';
import { signOut } from '../services/authService.js';
import * as budget from '../services/budgetService.js';
import * as catService from '../services/categoryService.js';
import * as security from '../services/securityService.js';
import {
  escapeHTML,
  formatCurrency,
  friendlyError,
  getPeriodRange,
  initStealthToggle,
  initThemeToggle,
  parseMoneyInput,
  roundMoney,
  showToast,
  toISODate
} from '../utils/helpers.js';

const METHODS = { efectivo: 'Efectivo', debito: 'Débito', credito: 'Crédito', transferencia: 'Transferencia' };
const CURRENCIES = ['USD', 'EUR', 'COP', 'MXN', 'ARS', 'CLP', 'PEN', 'BRL', 'UYU', 'BOB', 'PYG', 'GTQ', 'CRC', 'DOP', 'GBP', 'CAD'];

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  user: null,
  profile: { monthly_income: 0, currency: 'USD' },
  transactions: [],
  filteredTransactions: [],
  categories: [],
  currentPage: 1,
  pageSize: 10,
  sortField: 'fecha',
  sortAsc: false
};

const fmt = (value) => formatCurrency(value, state.profile.currency);

/* ------------------------------ Seguridad y Bloqueo ------------------------------ */
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
    background: 'var(--surface)', color: 'var(--text)',
    showCancelButton: true, confirmButtonText: 'Guardar', cancelButtonText: 'Cancelar',
    inputValidator: (value) => {
      if (!value || value.length !== 4 || !/^\d{4}$/.test(value)) return 'El PIN debe tener exactamente 4 números.';
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
    background: 'var(--surface)', color: 'var(--text)',
    html: `
      <div style="text-align:left; font-size:0.9rem; display:flex; flex-direction:column; gap:1rem;">
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
    showConfirmButton: false, showCancelButton: true, cancelButtonText: 'Cerrar',
    didOpen: (popup) => {
      $('#swal-btn-pin', popup)?.addEventListener('click', async () => { Swal.close(); await configurePinModal(); });
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
          if (registered) showToast('Biometría activada', { type: 'success' });
          else showToast('No se pudo activar la biometría', { type: 'error' });
        }
      });
    }
  });
}

/* ------------------------------ Filtros y Tabla ------------------------------ */
function applyFilters() {
  const search = $('#f-search')?.value.toLowerCase().trim() || '';
  const rule = $('#f-rule')?.value || 'todas';
  const category = $('#f-category')?.value || 'todas';
  const method = $('#f-method')?.value || 'todos';
  const period = $('#f-period')?.value || 'todos';

  let filtered = [...state.transactions];

  if (period !== 'todos') {
    const range = getPeriodRange(period);
    filtered = filtered.filter((t) => t.fecha >= range.from && t.fecha <= range.to);
  }

  if (rule !== 'todas') {
    filtered = filtered.filter((t) => t.categoria_503020 === rule);
  }

  if (category !== 'todas') {
    filtered = filtered.filter((t) => t.categoria_detalle === category);
  }

  if (method !== 'todos') {
    filtered = filtered.filter((t) => t.metodo_pago === method);
  }

  if (search) {
    filtered = filtered.filter(
      (t) =>
        (t.concepto && t.concepto.toLowerCase().includes(search)) ||
        (t.categoria_detalle && t.categoria_detalle.toLowerCase().includes(search))
    );
  }

  filtered.sort((a, b) => {
    let valA = a[state.sortField];
    let valB = b[state.sortField];
    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();
    if (valA < valB) return state.sortAsc ? -1 : 1;
    if (valA > valB) return state.sortAsc ? 1 : -1;
    return 0;
  });

  state.filteredTransactions = filtered;
  state.currentPage = 1;
  renderTable();
}

function renderTable() {
  const tbody = $('#tx-body');
  if (!tbody) return;

  if (!state.filteredTransactions.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No se encontraron transacciones.</td></tr>';
    $('#page-info').textContent = '0 de 0';
    return;
  }

  const startIdx = (state.currentPage - 1) * state.pageSize;
  const endIdx = startIdx + state.pageSize;
  const pageRows = state.filteredTransactions.slice(startIdx, endIdx);
  const totalPages = Math.ceil(state.filteredTransactions.length / state.pageSize);

  tbody.innerHTML = pageRows
    .map((t) => {
      const isGasto = t.tipo === 'gasto';
      const montoFormatted = `${isGasto ? '-' : '+'}${fmt(t.monto)}`;
      const ruleText = t.categoria_503020 === 'necesidades' ? '50% Necesidades' : t.categoria_503020 === 'deseos' ? '30% Deseos' : '20% Ahorro';

      return `<tr data-id="${escapeHTML(t.id)}">
        <td>${escapeHTML(t.fecha)}</td>
        <td><strong>${escapeHTML(t.concepto)}</strong></td>
        <td><span class="badge ${t.categoria_503020}">${ruleText}</span></td>
        <td>${escapeHTML(t.categoria_detalle || 'General')}</td>
        <td>${escapeHTML(METHODS[t.metodo_pago] || t.metodo_pago)}</td>
        <td class="num ${isGasto ? 'negative' : 'positive'} sensitive">${escapeHTML(montoFormatted)}</td>
        <td class="no-print">
          <button class="btn small icon" type="button" data-tx-action="edit">✏️</button>
          <button class="btn small icon danger" type="button" data-tx-action="delete">🗑️</button>
        </td>
      </tr>`;
    })
    .join('');

  $('#page-info').textContent = `Página ${state.currentPage} de ${totalPages} (${state.filteredTransactions.length} registros)`;
  $('#page-prev').disabled = state.currentPage <= 1;
  $('#page-next').disabled = state.currentPage >= totalPages;
}

/* ------------------------------ Modales ------------------------------ */

async function openTransactionModal(tx = null) {
  const isEdit = Boolean(tx);
  if (!state.categories.length) state.categories = await catService.listCategories();

  const result = await Swal.fire({
    title: isEdit ? 'Editar transacción' : 'Nueva transacción',
    background: 'var(--surface)', color: 'var(--text)',
    html: `<form class="swal-form" id="tx-form">
      <label>Concepto <input id="tx-concepto" type="text" required value="${escapeHTML(tx?.concepto ?? '')}" placeholder="Ej. Supermercado"></label>
      <div class="row">
        <label>Monto <input id="tx-monto" type="text" inputmode="decimal" required value="${tx?.monto ?? ''}" placeholder="Ej. 1.000.000,00"></label>
        <label>Tipo <select id="tx-tipo">
          <option value="gasto"${tx?.tipo === 'gasto' ? ' selected' : ''}>Gasto</option>
          <option value="ingreso"${tx?.tipo === 'ingreso' ? ' selected' : ''}>Ingreso</option>
        </select></label>
      </div>
      <div id="tx-category-row">
        <label>Categoría <select id="tx-detalle">${state.categories.map(c => `<option value="${escapeHTML(c.nombre)}" data-rule="${c.categoria_503020}"${tx?.categoria_detalle === c.nombre ? ' selected' : ''}>${escapeHTML(c.nombre)}</option>`).join('')}</select></label>
      </div>
      <div class="row">
        <label>Pago <select id="tx-metodo">${Object.entries(METHODS).map(([k, val]) => `<option value="${k}"${tx?.metodo_pago === k ? ' selected' : ''}>${val}</option>`).join('')}</select></label>
        <label>Fecha <input id="tx-fecha" type="date" required value="${tx?.fecha ?? toISODate(new Date())}"></label>
      </div>
    </form>`,
    showCancelButton: true,
    preConfirm: async () => {
      const popup = Swal.getPopup();
      const concepto = $('#tx-concepto', popup).value.trim();
      const monto = parseMoneyInput($('#tx-monto', popup).value);
      const tipo = $('#tx-tipo', popup).value;
      const fecha = $('#tx-fecha', popup).value;
      const opt = $('#tx-detalle', popup).selectedOptions[0];

      if (!concepto || !monto || monto <= 0) return Swal.showValidationMessage('Ingresa un monto válido');

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
    showToast(isEdit ? 'Transacción actualizada' : 'Transacción creada', { type: 'success' });
    await loadAll();
  }
}

async function openIncomeModal() {
  const result = await Swal.fire({
    title: 'Ingreso mensual y divisa',
    background: 'var(--surface)', color: 'var(--text)',
    html: `<form class="swal-form" id="income-form">
      <label>Ingreso mensual base <input id="inc-monto" type="text" inputmode="decimal" value="${state.profile.monthly_income || ''}" required placeholder="Ej. 2.500.000"></label>
      <label>Divisa <select id="inc-currency">${CURRENCIES.map(c => `<option value="${c}"${c === state.profile.currency ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
    </form>`,
    showCancelButton: true,
    preConfirm: async () => {
      const popup = Swal.getPopup();
      const monthly_income = parseMoneyInput($('#inc-monto', popup).value);
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

async function cloneRecurrentTransactions() {
  const prevRange = getPeriodRange('mes_anterior');
  const prevTxs = state.transactions.filter((t) => t.fecha >= prevRange.from && t.fecha <= prevRange.to && t.tipo === 'gasto');

  if (!prevTxs.length) {
    showToast('No hay gastos del mes anterior para duplicar', { type: 'info' });
    return;
  }

  const result = await Swal.fire({
    title: '🔁 Copiar recurrentes',
    text: `Se copiarán ${prevTxs.length} gastos del mes anterior con fecha de hoy (${toISODate(new Date())}). ¿Deseas continuar?`,
    icon: 'question',
    background: 'var(--surface)', color: 'var(--text)',
    showCancelButton: true, confirmButtonText: 'Sí, copiar', cancelButtonText: 'Cancelar'
  });

  if (result.isConfirmed) {
    const today = toISODate(new Date());
    for (const tx of prevTxs) {
      await budget.createTransaction({
        concepto: tx.concepto,
        monto: tx.monto,
        tipo: tx.tipo,
        categoria_503020: tx.categoria_503020,
        categoria_detalle: tx.categoria_detalle,
        metodo_pago: tx.metodo_pago,
        fecha: today
      });
    }
    showToast(`${prevTxs.length} transacciones duplicadas`, { type: 'success' });
    await loadAll();
  }
}

async function openCategoryManager() {
  const renderCatList = () =>
    state.categories
      .map(
        (c) => `<li style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0; border-bottom:1px solid rgba(255,255,255,0.1);">
          <span><strong>${escapeHTML(c.nombre)}</strong> <small style="opacity:0.7">(${c.categoria_503020})</small></span>
          ${!c.is_default ? `<button class="btn small danger icon" data-cat-delete="${c.id}" type="button">🗑️</button>` : '<small style="opacity:0.5">Predeterminada</small>'}
        </li>`
      )
      .join('');

  await Swal.fire({
    title: '🏷️ Gestión de Categorías',
    background: 'var(--surface)', color: 'var(--text)',
    html: `<div style="text-align:left;">
      <div style="margin-bottom:1rem; display:flex; gap:0.5rem;">
        <input id="new-cat-name" type="text" placeholder="Nueva categoría..." style="flex:1;" />
        <select id="new-cat-rule">
          <option value="necesidades">50% Necesidades</option>
          <option value="deseos">30% Deseos</option>
          <option value="ahorro">20% Ahorro</option>
        </select>
        <button id="btn-add-cat" class="btn primary small" type="button">＋</button>
      </div>
      <ul id="cat-list-modal" style="list-style:none; padding:0; margin:0; max-height:220px; overflow-y:auto;">
        ${renderCatList()}
      </ul>
    </div>`,
    showConfirmButton: false, showCancelButton: true, cancelButtonText: 'Cerrar',
    didOpen: (popup) => {
      const catListEl = $('#cat-list-modal', popup);
      $('#btn-add-cat', popup)?.addEventListener('click', async () => {
        const name = $('#new-cat-name', popup).value.trim();
        const rule = $('#new-cat-rule', popup).value;
        if (!name) return showToast('Ingresa un nombre', { type: 'error' });
        try {
          await catService.createCategory({ nombre: name, categoria_503020: rule });
          state.categories = await catService.listCategories();
          catListEl.innerHTML = renderCatList();
          $('#new-cat-name', popup).value = '';
          showToast('Categoría creada', { type: 'success' });
        } catch (err) {
          showToast(friendlyError(err), { type: 'error' });
        }
      });

      catListEl?.addEventListener('click', async (e) => {
        const delBtn = e.target.closest('[data-cat-delete]');
        if (!delBtn) return;
        try {
          await catService.deleteCategory(delBtn.dataset.catDelete);
          state.categories = await catService.listCategories();
          catListEl.innerHTML = renderCatList();
          showToast('Categoría eliminada', { type: 'success' });
        } catch (err) {
          showToast(friendlyError(err), { type: 'error' });
        }
      });
    }
  });

  await loadAll();
}

function exportCSV() {
  if (!state.filteredTransactions.length) {
    showToast('No hay transacciones para exportar', { type: 'info' });
    return;
  }
  const headers = ['Fecha', 'Concepto', 'Regla 50/30/20', 'Categoría Detalle', 'Método de Pago', 'Tipo', 'Monto'];
  const rows = state.filteredTransactions.map((t) => [
    t.fecha,
    `"${(t.concepto || '').replace(/"/g, '""')}"`,
    t.categoria_503020,
    `"${(t.categoria_detalle || '').replace(/"/g, '""')}"`,
    t.metodo_pago,
    t.tipo,
    t.monto
  ]);
  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `transacciones_${toISODate(new Date())}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Archivo CSV descargado', { type: 'success' });
}

function exportPDF() {
  if (!state.filteredTransactions.length) {
    showToast('No hay transacciones para exportar', { type: 'info' });
    return;
  }
  try {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text('Reporte de Transacciones — Presupuesto 50/30/20', 14, 20);
    doc.setFontSize(10);
    doc.text(`Fecha de generación: ${new Date().toLocaleDateString('es')}`, 14, 27);

    let y = 36;
    doc.setFontSize(9);
    doc.text('Fecha', 14, y);
    doc.text('Concepto', 42, y);
    doc.text('Regla', 105, y);
    doc.text('Categoría', 135, y);
    doc.text('Monto', 175, y);
    doc.line(14, y + 2, 196, y + 2);
    y += 8;

    state.filteredTransactions.forEach((t) => {
      if (y > 280) {
        doc.addPage();
        y = 20;
      }
      const concepto = (t.concepto || '').substring(0, 26);
      const detalle = (t.categoria_detalle || '').substring(0, 18);
      const montoFmt = `${t.tipo === 'gasto' ? '-' : '+'}${formatCurrency(t.monto, state.profile.currency)}`;

      doc.text(t.fecha || '', 14, y);
      doc.text(concepto, 42, y);
      doc.text(t.categoria_503020 || '', 105, y);
      doc.text(detalle, 135, y);
      doc.text(montoFmt, 175, y);
      y += 6;
    });

    doc.save(`reporte_transacciones_${toISODate(new Date())}.pdf`);
    showToast('Archivo PDF descargado', { type: 'success' });
  } catch (err) {
    console.error(err);
    showToast('Error al generar PDF', { type: 'error' });
  }
}

/* ------------------------------ Carga Inicial y Eventos ------------------------------ */
async function loadAll() {
  try {
    const from = `${new Date().getFullYear() - 1}-12-01`;
    const [profile, transactions, userCategories] = await Promise.all([
      budget.getProfile(state.user.id),
      budget.listTransactions(from),
      catService.listCategories()
    ]);

    state.profile = profile;
    state.transactions = transactions;
    state.categories = userCategories;

    const catSelect = $('#f-category');
    if (catSelect) {
      catSelect.innerHTML = '<option value="todas">Todas</option>' + userCategories.map((c) => `<option value="${escapeHTML(c.nombre)}">${escapeHTML(c.nombre)}</option>`).join('');
    }

    applyFilters();
  } catch (error) {
    showToast(friendlyError(error), { type: 'error' });
  }
}

function wireEvents() {
  $('#btn-add')?.addEventListener('click', () => openTransactionModal());
  $('#btn-income')?.addEventListener('click', () => openIncomeModal());
  $('#btn-clone')?.addEventListener('click', () => cloneRecurrentTransactions());
  $('#btn-categories')?.addEventListener('click', () => openCategoryManager());
  $('#btn-csv')?.addEventListener('click', () => exportCSV());
  $('#btn-pdf')?.addEventListener('click', () => exportPDF());

  $('#btn-security-settings')?.addEventListener('click', () => openSecurityModal());
  $('#btn-lock-now')?.addEventListener('click', () => {
    if (!security.hasPinConfigured(state.user.id)) {
      showToast('Configura un PIN primero para activar el bloqueo', { type: 'info' });
      openSecurityModal();
    } else {
      triggerLockScreen();
    }
  });
  $('#btn-logout')?.addEventListener('click', async () => {
    await signOut();
    window.location.replace('./index.html');
  });

  ['f-search', 'f-rule', 'f-category', 'f-method', 'f-period'].forEach((id) => {
    $(`#${id}`)?.addEventListener('input', applyFilters);
    $(`#${id}`)?.addEventListener('change', applyFilters);
  });

  $('#page-size')?.addEventListener('change', (e) => {
    state.pageSize = Number(e.target.value);
    state.currentPage = 1;
    renderTable();
  });
  $('#page-prev')?.addEventListener('click', () => {
    if (state.currentPage > 1) {
      state.currentPage--;
      renderTable();
    }
  });
  $('#page-next')?.addEventListener('click', () => {
    const totalPages = Math.ceil(state.filteredTransactions.length / state.pageSize);
    if (state.currentPage < totalPages) {
      state.currentPage++;
      renderTable();
    }
  });

  $('#tx-body')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-tx-action]');
    if (!btn) return;
    const row = btn.closest('tr');
    const tx = state.transactions.find((t) => t.id === row?.dataset.id);
    if (!tx) return;

    if (btn.dataset.txAction === 'edit') {
      openTransactionModal(tx);
    } else if (btn.dataset.txAction === 'delete') {
      const confirm = await Swal.fire({
        title: '¿Eliminar transacción?',
        text: `Concepto: "${tx.concepto}" por ${fmt(tx.monto)}`,
        icon: 'warning',
        background: 'var(--surface)', color: 'var(--text)',
        showCancelButton: true, confirmButtonText: 'Sí, eliminar', cancelButtonText: 'Cancelar'
      });
      if (confirm.isConfirmed) {
        await budget.deleteTransaction(tx.id);
        showToast('Transacción eliminada', { type: 'success' });
        await loadAll();
      }
    }
  });
}

async function init() {
  initStealthToggle($('#btn-stealth'));
  initThemeToggle($('#btn-theme-toggle'));

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