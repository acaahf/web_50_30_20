// js/utils/pdfExport.js — Reporte ejecutivo en PDF (jsPDF vía Import Map)
import { jsPDF } from 'jspdf';
import { formatCurrency, formatDate } from './helpers.js';

const BLUE = [2, 132, 199];
const RED = [220, 38, 38];
const GREEN = [22, 163, 74];
const INK = [15, 23, 42];
const MUTED = [100, 116, 139];
const STRIPE = [241, 245, 249];

const RULE_LABEL = { necesidades: '50% Necesidades', deseos: '30% Deseos', ahorro: '20% Ahorro' };
const METHOD_LABEL = { efectivo: 'Efectivo', debito: 'Debito', credito: 'Credito', transferencia: 'Transferencia' };

/** Las fuentes estándar de PDF solo soportan Latin-1: se normaliza el texto. */
const pdfText = (s) =>
  String(s ?? '')
    .replace(/[  ]/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E¡-ÿ]/g, '?');

/**
 * @param {{user:{email:string}, currency:string, periodLabel:string, range:{from:string,to:string},
 *          summary:{income:number,totalSpent:number,categories:Array}, transactions:Array}} data
 */
export async function exportPDF(data) {
  const { user, currency, periodLabel, range, summary, transactions } = data;

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 14;
  const money = (v) => pdfText(formatCurrency(v, currency, 'code'));

  /* ---------- Encabezado institucional ---------- */
  doc.setFillColor(...BLUE);
  doc.rect(0, 0, W, 30, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('Reporte financiero 50/30/20', M, 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(pdfText(`Periodo: ${periodLabel} (${range.from} a ${range.to})`), M, 22);

  doc.setTextColor(...INK);
  doc.setFontSize(10);
  let y = 40;
  const meta = [
    ['Fecha de emision', formatDate(new Date().toISOString().slice(0, 10))],
    ['Usuario', user?.email ?? ''],
    ['Divisa', currency]
  ];
  for (const [k, v] of meta) {
    doc.setFont('helvetica', 'bold');
    doc.text(`${k}:`, M, y);
    doc.setFont('helvetica', 'normal');
    doc.text(pdfText(v), M + 38, y);
    y += 6;
  }

  /* ---------- Resumen: Ingreso base + asignado vs. real ---------- */
  y += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Resumen del presupuesto', M, y);
  y += 3;

  doc.setFillColor(...STRIPE);
  doc.roundedRect(M, y, W - 2 * M, 14, 2, 2, 'F');
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  doc.text('Ingreso base del periodo', M + 4, y + 6);
  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(money(summary.income), M + 4, y + 12);
  y += 20;

  y = drawTable(doc, {
    startY: y,
    margin: M,
    columns: [
      { header: 'Categoria', width: 50 },
      { header: 'Asignado', width: 36, align: 'right' },
      { header: 'Gasto real', width: 36, align: 'right' },
      { header: 'Estado', width: 60 }
    ],
    rows: summary.categories.map((c) => {
      const over = c.assigned > 0 && c.spent > c.assigned;
      const estado = c.assigned <= 0 ? 'Sin ingreso configurado' : over ? `Excedido por ${money(c.spent - c.assigned)}` : `Disponible ${money(c.assigned - c.spent)}`;
      return { cells: [`${c.label} (${c.pct}%)`, money(c.assigned), money(c.spent), estado], color: over ? RED : null, colorCol: 3 };
    }),
    pageHeight: H,
    topMargin: 20
  });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...INK);
  doc.text(`Total gastos del periodo: ${money(summary.totalSpent)}`, M, y + 6);
  y += 16;

  /* ---------- Tabla de transacciones ---------- */
  if (y > H - 50) {
    doc.addPage();
    y = 20;
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(`Transacciones (${transactions.length})`, M, y);
  y += 3;

  drawTable(doc, {
    startY: y,
    margin: M,
    columns: [
      { header: 'Fecha', width: 24 },
      { header: 'Concepto', width: 54 },
      { header: 'Regla', width: 28 },
      { header: 'Detalle', width: 26 },
      { header: 'Pago', width: 24 },
      { header: 'Monto', width: 26, align: 'right' }
    ],
    rows: transactions.map((t) => ({
      cells: [
        formatDate(t.fecha),
        t.concepto,
        t.tipo === 'gasto' ? (RULE_LABEL[t.categoria_503020] ?? t.categoria_503020) : 'Ingreso',
        t.categoria_detalle,
        METHOD_LABEL[t.metodo_pago] ?? t.metodo_pago,
        `${t.tipo === 'ingreso' ? '+' : '-'}${money(t.monto)}`
      ],
      color: t.tipo === 'ingreso' ? GREEN : null,
      colorCol: 5
    })),
    emptyText: 'No hay transacciones en este periodo.',
    pageHeight: H,
    topMargin: 20
  });

  /* ---------- Pie con numeración ---------- */
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text('Presupuesto 50/30/20 - Informativo, no constituye asesoria financiera.', M, H - 8);
    doc.text(`Pagina ${i} de ${pages}`, W - M, H - 8, { align: 'right' });
  }

  doc.save(`reporte_presupuesto_${range.from}_${range.to}.pdf`);
}

/**
 * Dibuja una tabla con encabezado repetido en cada página.
 * @returns {number} posición Y final
 */
function drawTable(doc, { startY, margin, columns, rows, pageHeight, topMargin, emptyText }) {
  const rowH = 7;
  const bottom = pageHeight - 16;
  const totalW = columns.reduce((a, c) => a + c.width, 0);
  let y = startY;

  const header = () => {
    doc.setFillColor(...BLUE);
    doc.rect(margin, y, totalW, rowH, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(255, 255, 255);
    let x = margin;
    for (const col of columns) {
      const tx = col.align === 'right' ? x + col.width - 2 : x + 2;
      doc.text(pdfText(col.header), tx, y + 4.8, { align: col.align === 'right' ? 'right' : 'left' });
      x += col.width;
    }
    y += rowH;
  };

  header();

  if (!rows.length) {
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(...MUTED);
    doc.text(pdfText(emptyText ?? 'Sin datos.'), margin + 2, y + 5);
    return y + rowH;
  }

  rows.forEach((row, index) => {
    if (y + rowH > bottom) {
      doc.addPage();
      y = topMargin;
      header();
    }
    if (index % 2 === 0) {
      doc.setFillColor(...STRIPE);
      doc.rect(margin, y, totalW, rowH, 'F');
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    let x = margin;
    columns.forEach((col, i) => {
      const raw = pdfText(row.cells[i]);
      const maxW = col.width - 4;
      let text = raw;
      if (doc.getTextWidth(text) > maxW) {
        while (text.length > 1 && doc.getTextWidth(`${text}...`) > maxW) text = text.slice(0, -1);
        text = `${text}...`;
      }
      const color = row.color && row.colorCol === i ? row.color : INK;
      doc.setTextColor(...color);
      const tx = col.align === 'right' ? x + col.width - 2 : x + 2;
      doc.text(text, tx, y + 4.8, { align: col.align === 'right' ? 'right' : 'left' });
      x += col.width;
    });
    y += rowH;
  });

  return y;
}
