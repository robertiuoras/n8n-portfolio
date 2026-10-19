// Writes the synthetic test documents for invoice-extract into tests/invoices/ (from tests/invoice-eval.json), plus
// scanned.pdf, a page with no text layer. Plain PDF 1.4 with the built-in Helvetica fonts, so no PDF library is needed.
// Run: node scripts/make-invoices.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cents = (n) => Math.round(n * 100) / 100;

// What is printed on the document: a line is [description, qty, unit price, printed amount (optional, to plant an error)];
// doc.total overrides the printed total. Subtotal is the sum of the printed line amounts and GST is 10% of it.
export function invoiceFigures(doc) {
  const lines = doc.lines.map(([description, quantity, unit_price, printed]) => ({ description, quantity, unit_price, amount: cents(printed ?? quantity * unit_price) }));
  const subtotal = cents(lines.reduce((s, l) => s + l.amount, 0)), tax = cents(subtotal * 0.1);
  return { lines, subtotal, tax, total: cents(doc.total ?? subtotal + tax) };
}

const money = (n, sign = true) => (sign ? '$' : '') + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[\\()]/g, (c) => '\\' + c);

function pdf(ops) {
  // ops: [x, y, size, text, bold] for text, or ['rect', x, y, w, h, grey] for a filled box.
  const content = ops.map((o) => o[0] === 'rect' ? `${o[5]} g ${o[1]} ${o[2]} ${o[3]} ${o[4]} re f 0 g` : `BT /${o[4] ? 'F2' : 'F1'} ${o[2]} Tf ${o[0]} ${o[1]} Td (${esc(o[3])}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const BILL_TO = ['Acme Solar Pty Ltd', '12 Example Street', 'Burleigh Heads QLD 4220'];
function render(doc) {
  const f = invoiceFigures(doc), ops = [];
  const meta = [doc.number && ['Invoice No', doc.number], ['Date', doc.date], doc.due && ['Due date', doc.due]].filter(Boolean);
  if (doc.layout === 'a') {
    ops.push([50, 780, 16, doc.supplier, true], [50, 762, 9, 'ABN ' + doc.abn], [50, 750, 9, '40 Supply Road, Yatala QLD 4207']);
    ops.push([380, 780, 16, doc.title, true]);
    meta.forEach(([k, v], i) => ops.push([380, 760 - i * 13, 9, k + ':', true], [450, 760 - i * 13, 9, v]));
    ops.push([50, 700, 9, 'Bill to', true]); BILL_TO.forEach((t, i) => ops.push([50, 687 - i * 12, 9, t]));
    ops.push(['rect', 50, 616, 495, 16, 0.9], [55, 621, 9, 'Description', true], [330, 621, 9, 'Qty', true], [380, 621, 9, 'Unit price', true], [480, 621, 9, 'Amount', true]);
    f.lines.forEach((l, i) => { const y = 600 - i * 16; ops.push([55, y, 9, l.description], [330, y, 9, String(l.quantity)], [380, y, 9, money(l.unit_price)], [480, y, 9, money(l.amount)]); });
    const y0 = 590 - f.lines.length * 16 - 20;
    [['Subtotal', f.subtotal], ['GST', f.tax], [doc.total_label || 'Total', f.total]].forEach(([k, v], i) => ops.push([380, y0 - i * 15, 10, k, i === 2], [480, y0 - i * 15, 10, money(v), i === 2]));
    if (doc.note) ops.push([50, y0 - 70, 9, doc.note]);
    ops.push([50, 80, 8, 'Payment by bank transfer within the terms shown. Please quote the invoice number as the reference.']);
  } else {
    ops.push([230, 790, 18, doc.title, true]);
    ops.push([330, 750, 11, doc.supplier, true], [330, 736, 9, 'A.B.N. ' + doc.abn], [330, 724, 9, 'Unit 3, 8 Harbour Drive, Coomera QLD 4209']);
    ops.push([50, 750, 9, 'To:', true]); BILL_TO.forEach((t, i) => ops.push([50, 737 - i * 12, 9, t]));
    meta.forEach(([k, v], i) => ops.push([50, 680 - i * 13, 9, k, true], [130, 680 - i * 13, 9, v]));
    ops.push([50, 612, 9, 'Qty', true], [90, 612, 9, 'Item', true], [370, 612, 9, 'Each (AUD)', true], [470, 612, 9, 'Line total (AUD)', true], ['rect', 50, 606, 495, 1, 0]);
    f.lines.forEach((l, i) => { const y = 590 - i * 16; ops.push([50, y, 9, String(l.quantity)], [90, y, 9, l.description], [370, y, 9, money(l.unit_price, false)], [470, y, 9, money(l.amount, false)]); });
    const y0 = 580 - f.lines.length * 16 - 20;
    [['Subtotal (excl. GST)', f.subtotal], ['GST 10%', f.tax], [doc.total_label || 'Total (incl. GST)', f.total]].forEach(([k, v], i) => ops.push([330, y0 - i * 15, 10, k, i === 2], [470, y0 - i * 15, 10, money(v), i === 2]));
    if (doc.note) ops.push([50, y0 - 70, 9, doc.note]);
  }
  return pdf(ops);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.join(root, 'tests', 'invoices');
  fs.mkdirSync(dir, { recursive: true });
  for (const t of JSON.parse(fs.readFileSync(path.join(root, 'tests/invoice-eval.json'), 'utf8'))) fs.writeFileSync(path.join(dir, t.file), render(t.doc));
  // A "scan": grey boxes where the text would be, and no text at all, which is what a photographed invoice looks like.
  fs.writeFileSync(path.join(dir, 'scanned.pdf'), pdf([['rect', 50, 760, 200, 18, 0.6], ['rect', 380, 760, 160, 18, 0.6], ['rect', 50, 500, 495, 200, 0.85], ['rect', 380, 440, 160, 40, 0.6]]));
  console.log('wrote', fs.readdirSync(dir).length, 'files to tests/invoices/');
}
