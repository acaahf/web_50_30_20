// js/controllers/analyticsController.js — Controlador de la vista de análisis
import { requireAuth } from '../utils/authGuard.js';
import { signOut } from '../services/authService.js';
import * as budget from '../services/budgetService.js';
import {
  renderBudgetChart,
  renderTrendChart,
  renderCategoryDoughnutChart,
  destroyChart
} from '../utils/chartManager.js';
import {
  formatCurrency,
  showToast,
  friendlyError,
  initStealthToggle,
  roundMoney,
  sumMoney
} from '../utils/helpers.js';

const RULES = {
  necesidades: { label: 'Necesidades', pct: 50, color: '#0284c7' },
  deseos: { label: 'Deseos', pct: 30, color: '#9333ea' },
  ahorro: { label: 'Ahorro', pct: 20, color: '#16a34a' }
};
const RULE_KEYS = Object.keys(RULES);
const PALETTE = ['#0284c7', '#9333ea', '#16a34a', '#eab308', '#f97316', '#ec4899', '#6366f1', '#14b8a6', '#06b6d4', '#84cc16'];

const $ = (selector) => document.querySelector(selector);

const state = {
  user: null,
  profile: { monthly_income: 0, currency: 'USD' },
  transactions: []
};

const fmt = (value) => formatCurrency(value, state.profile.currency);

async function loadData() {
  try {
    const period = $('#f-analytics-period').value;
    let fromDate = new Date();
    if (period === '6_meses') {
      fromDate.setMonth(fromDate.getMonth() - 6);
      fromDate.setDate(1);
    } else if (period === '12_meses') {
      fromDate.setMonth(fromDate.getMonth() - 12);
      fromDate.setDate(1);
    } else {
      fromDate = new Date(2000, 0, 1);
    }

    const fromStr = fromDate.toISOString().slice(0, 10);

    const [profileData, txData] = await Promise.all([
      budget.getProfile(state.user.id),
      budget.listTransactions(fromStr)
    ]);

    state.profile = profileData;
    state.transactions = txData;

    renderAllCharts();
  } catch (error) {
    showToast(friendlyError(error), { type: 'error', duration: 5000 });
  }
}

function renderAllCharts() {
  renderTrend();
  renderRulesDistribution();
  renderCategoriesBreakdown();
}

function renderTrend() {
  const canvas = $('#chart-trend');
  if (!canvas) return;

  const period = $('#f-analytics-period').value;
  const monthsBack = period === '6_meses' ? 6 : period === '12_meses' ? 12 : 24;
  const now = new Date();
  const monthsMap = {};

  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('es', { month: 'short', year: '2-digit' });
    monthsMap[key] = { label, income: state.profile.monthly_income, expenses: 0 };
  }

  state.transactions.forEach((t) => {
    const key = t.fecha.slice(0, 7);
    if (monthsMap[key]) {
      if (t.tipo === 'ingreso') {
        monthsMap[key].income += t.monto;
      } else {
        monthsMap[key].expenses += t.monto;
      }
    }
  });

  const keys = Object.keys(monthsMap).sort();
  renderTrendChart(canvas, {
    labels: keys.map((k) => monthsMap[k].label),
    incomes: keys.map((k) => monthsMap[k].income),
    expenses: keys.map((k) => monthsMap[k].expenses),
    formatter: fmt
  });
}

function renderRulesDistribution() {
  const canvas = $('#chart-rules');
  if (!canvas) return;

  const baseIncome = state.profile.monthly_income;
  const locked = baseIncome <= 0;
  const gastos = state.transactions.filter((t) => t.tipo === 'gasto');

  const categories = RULE_KEYS.map((key) => {
    const assigned = roundMoney((baseIncome * RULES[key].pct) / 100);
    const spent = sumMoney(gastos.filter((t) => t.categoria_503020 === key).map((t) => t.monto));
    return {
      key,
      assigned,
      spent,
      over: assigned > 0 && spent > assigned
    };
  });

  renderBudgetChart(canvas, {
    labels: RULE_KEYS.map((k) => `${RULES[k].pct}% ${RULES[k].label}`),
    colors: RULE_KEYS.map((k) => RULES[k].color),
    ideal: locked ? RULE_KEYS.map((k) => RULES[k].pct) : categories.map((c) => c.assigned),
    actual: categories.map((c) => c.spent),
    over: categories.map((c) => c.over),
    idealAsPercent: locked,
    formatter: fmt
  });
}

function renderCategoriesBreakdown() {
  const canvas = $('#chart-categories');
  if (!canvas) return;

  const catMap = {};
  state.transactions
    .filter((t) => t.tipo === 'gasto')
    .forEach((t) => {
      const name = t.categoria_detalle || 'Otros';
      catMap[name] = (catMap[name] || 0) + t.monto;
    });

  const labels = Object.keys(catMap).sort((a, b) => catMap[b] - catMap[a]);
  const data = labels.map((l) => catMap[l]);
  const colors = labels.map((_, i) => PALETTE[i % PALETTE.length]);

  renderCategoryDoughnutChart(canvas, {
    labels,
    data,
    colors,
    formatter: fmt
  });
}

async function init() {
  initStealthToggle($('#btn-stealth'));

  const user = await requireAuth();
  if (!user) return;

  state.user = user;
  $('#nav-email').textContent = user.email ?? '';

  $('#f-analytics-period').addEventListener('change', loadData);

  $('#btn-logout').addEventListener('click', async () => {
    destroyChart();
    await signOut();
    window.location.replace('./index.html');
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderAllCharts);

  await loadData();
}

init();