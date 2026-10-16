// js/utils/csvExport.js — CSV compatible con RFC 4180 + UTF-8 BOM
import { formatDate } from './helpers.js';

const COLUMNS = 8;
const CRLF = '\r\n';
const TYPE_LABEL = { ingreso: 'Ingreso', gasto: 'Gasto' };
const RULE_LABEL = { necesidades: '50% Necesidades', deseos: '30% Deseos', ahorro: '20% Ahorro' };
const METHOD_LABEL = { efectivo: 'Efectivo', debito: 'Débito', credito: 'Crédito', transferencia: 'Transferencia' };

/** Escapa un campo según RFC 4180 (y neutraliza inyección de fórmulas en texto). */
function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(2) : '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita ejecución de fórmulas en Excel/Sheets
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Cada registro tiene el mismo número de campos (RFC 4180, sección 2.4). */
function record(fields) {
  const padded = [...fields];
  while (padded.length < COLUMNS) padded.push('');
  return padded.map(cell).join(',');
}

/**
 * @param {{user:{email:string}, currency:string, periodLabel:string, range:{from:string,to:string},
 *          summary:{income:number, totalSpent:number, categories:Array}, transactions:Array}} data
 */
export function buildCSV(data) {
  const { user, currency, periodLabel, range, summary, transactions } = data;
  const lines = [];

  lines.push(record(['Reporte financiero 50/30/20']));
  lines.push(record(['Generado', new Date().toISOString().slice(0, 10)]));
  lines.push(record(['Usuario', user?.email ?? '']));
  lines.push(record(['Período', `${periodLabel} (${range.from} a ${range.to})`]));
  lines.push(record(['Divisa', currency]));
  lines.push(record(['Ingreso base del período', summary.income]));
  lines.push(record([]));
  lines.push(record(['Categoría', 'Presupuesto asignado', 'Gasto real', 'Diferencia', '% usado']));
  for (const c of summary.categories) {
    lines.push(
      record([
        `${c.label} (${c.pct}%)`,
        c.assigned,
        c.spent,
        c.diff,
        c.assigned > 0 ? `${((c.spent / c.assigned) * 100).toFixed(1)}%` : 'N/A'
      ])
    );
  }
  lines.push(record(['Total gastos', '', summary.totalSpent]));
  lines.push(record([]));
  lines.push(record(['Fecha', 'Concepto', 'Tipo', 'Regla 50/30/20', 'Categoría detallada', 'Método de pago', 'Recurrente', 'Monto']));
  for (const t of transactions) {
    lines.push(
      record([
        t.fecha,
        t.concepto,
        TYPE_LABEL[t.tipo] ?? t.tipo,
        t.tipo === 'gasto' ? (RULE_LABEL[t.categoria_503020] ?? t.categoria_503020) : '',
        t.categoria_detalle,
        METHOD_LABEL[t.metodo_pago] ?? t.metodo_pago,
        t.es_recurrente ? 'Sí' : 'No',
        t.monto
      ])
    );
  }

  return `﻿${lines.join(CRLF)}${CRLF}`;
}

export function exportCSV(data) {
  const csv = buildCSV(data);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `presupuesto_${data.range.from}_${data.range.to}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Re-exportado por conveniencia para pruebas
export { formatDate };
