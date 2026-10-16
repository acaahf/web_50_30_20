// js/utils/chartManager.js — Ciclo de vida del gráfico de dona (Chart.js vía Import Map)
import { Chart } from 'chart.js';

let chartInstance = null;

const cssVar = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * Dona concéntrica: anillo exterior = presupuesto ideal, anillo interior = gasto real.
 * @param {HTMLCanvasElement} canvas
 * @param {{labels:string[], colors:string[], ideal:number[], actual:number[], over?:boolean[],
 *          formatter:(n:number)=>string, idealAsPercent?:boolean}} config
 */
export function renderBudgetChart(canvas, config) {
  const { labels, colors, ideal, actual, over = [], formatter, idealAsPercent = false } = config;

  // Destruye cualquier instancia previa antes de crear una nueva
  chartInstance?.destroy();
  chartInstance = null;
  Chart.getChart(canvas)?.destroy();

  const text = cssVar('--text', '#0f172a');
  const surface = cssVar('--surface', '#ffffff');
  Chart.defaults.color = text;
  Chart.defaults.font.family = cssVar('--font', 'system-ui, sans-serif');

  chartInstance = new Chart(canvas, {
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

  return chartInstance;
}

export function destroyChart() {
  chartInstance?.destroy();
  chartInstance = null;
}
