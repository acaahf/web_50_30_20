// js/utils/chartManager.js — Gestor central de gráficos (Chart.js vía Import Map)
import { Chart, registerables } from 'chart.js';

// Registrar todos los componentes necesarios (doughnut, line, tooltip, leyenda, etc.)
Chart.register(...registerables);

const instances = new Map();

const cssVar = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function getCanvasContext(canvas) {
  if (!canvas) return null;
  const id = canvas.id || 'default-canvas';
  if (instances.has(id)) {
    instances.get(id).destroy();
    instances.delete(id);
  }
  Chart.getChart(canvas)?.destroy();
  return { id, ctx: canvas.getContext('2d') };
}

function applyThemeDefaults() {
  const text = cssVar('--text', '#0f172a');
  Chart.defaults.color = text;
  Chart.defaults.font.family = cssVar('--font', 'system-ui, sans-serif');
}

/** Dona concéntrica: anillo exterior = presupuesto ideal, anillo interior = gasto real. */
export function renderBudgetChart(canvas, config) {
  if (!canvas) return null;
  const { id, ctx } = getCanvasContext(canvas);
  applyThemeDefaults();

  const { labels, colors, ideal, actual, over = [], formatter, idealAsPercent = false } = config;
  const text = cssVar('--text', '#0f172a');
  const surface = cssVar('--surface', '#ffffff');

  const chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          label: 'Presupuesto ideal',
          data: ideal,
          backgroundColor: colors.map((c) => `${c}b3`),
          borderColor: surface,
          borderWidth: 2
        },
        {
          label: 'Gasto real',
          data: actual,
          backgroundColor: colors.map((c, i) => (over[i] ? '#dc2626' : c)),
          borderColor: surface,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '40%',
      plugins: {
        legend: { position: 'bottom', labels: { color: text, usePointStyle: true } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const value = ctx.parsed;
              const shown = ctx.datasetIndex === 0 && idealAsPercent ? `${value}%` : formatter(value);
              return ` ${ctx.dataset.label} · ${ctx.label}: ${shown}`;
            }
          }
        }
      }
    }
  });

  instances.set(id, chart);
  return chart;
}

/** Gráfico de líneas: tendencia de ingresos vs. gastos */
export function renderTrendChart(canvas, config) {
  if (!canvas) return null;
  const { id, ctx } = getCanvasContext(canvas);
  applyThemeDefaults();

  const { labels, incomes, expenses, formatter } = config;

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Ingresos',
          data: incomes,
          borderColor: '#16a34a',
          backgroundColor: 'rgba(22, 163, 74, 0.15)',
          fill: true,
          tension: 0.35,
          borderWidth: 2.5
        },
        {
          label: 'Gastos',
          data: expenses,
          borderColor: '#dc2626',
          backgroundColor: 'rgba(220, 38, 38, 0.15)',
          fill: true,
          tension: 0.35,
          borderWidth: 2.5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${formatter ? formatter(ctx.raw) : ctx.raw}`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: (v) => (formatter ? formatter(v) : v)
          }
        }
      }
    }
  });

  instances.set(id, chart);
  return chart;
}

/** Gráfico de dona: desglose de gastos por categoría individual */
export function renderCategoryDoughnutChart(canvas, config) {
  if (!canvas) return null;
  const { id, ctx } = getCanvasContext(canvas);
  applyThemeDefaults();

  const { labels, data, colors, formatter } = config;
  const surface = cssVar('--surface', '#ffffff');

  const chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: colors,
          borderColor: surface,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${formatter ? formatter(ctx.raw) : ctx.raw}`
          }
        }
      }
    }
  });

  instances.set(id, chart);
  return chart;
}

export function destroyChart(canvasId = null) {
  if (canvasId && instances.has(canvasId)) {
    instances.get(canvasId).destroy();
    instances.delete(canvasId);
  } else {
    instances.forEach((chart) => chart.destroy());
    instances.clear();
  }
}