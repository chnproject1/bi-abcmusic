import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const CSV_URL = process.env.GOOGLE_SHEETS_CSV_URL || 'https://docs.google.com/spreadsheets/d/1chGv3wblDy9_4-OFZ2nEMzR_ipfotyXWbBi1-iDG1Uo/gviz/tq?tqx=out:csv&sheet=Transa%C3%A7%C3%B5es';
const MONTHLY_REVENUE_TARGET = Number(process.env.MONTHLY_REVENUE_TARGET || 1500000);
const TARGET_MARGIN = Number(process.env.TARGET_MARGIN || 0.55);
const BI_USER = process.env.BI_USER || '';
const BI_PASSWORD = process.env.BI_PASSWORD || '';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);

let cache = { at: 0, data: null };

function requireAuth(req, res) {
  if (!BI_USER || !BI_PASSWORD) return true;
  const header = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(`${BI_USER}:${BI_PASSWORD}`).toString('base64');
  if (header === expected) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="abcMusic BI"' });
  res.end('Auth required');
  return false;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((value) => String(value).trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }

  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((value) => String(value).trim() !== '')) rows.push(row);
  }

  return rows;
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function parseDatePtBr(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return null;
  const day = match[1].padStart(2, '0');
  const month = match[2].padStart(2, '0');
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${day}`;
}

function parseMoneyPtBr(value) {
  const normalized = String(value || '')
    .replace(/R\$/g, '')
    .trim()
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function dateAddDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function compare(current, baseline) {
  if (!baseline || !Number.isFinite(baseline)) return null;
  return (current - baseline) / baseline;
}

function brl(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

async function loadMetrics(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) return cache.data;

  const response = await fetch(CSV_URL, { headers: { 'User-Agent': 'abcMusic-BI/1.0' } });
  if (!response.ok) throw new Error(`Erro ao buscar CSV: HTTP ${response.status}`);

  const rows = parseCsv(await response.text());
  if (!rows.length) throw new Error('CSV vazio');

  const headers = rows[0].map(normalizeHeader);
  const idx = Object.fromEntries(headers.map((header, index) => [header, index]));
  const required = ['DATA', 'TIPO', 'CATEGORIA', 'DESCRICAO', 'VALOR'];

  for (const col of required) {
    if (!(col in idx)) throw new Error(`Coluna obrigatória ausente: ${col}`);
  }

  const transactions = rows
    .slice(1)
    .map((row) => ({
      data: parseDatePtBr(row[idx.DATA]),
      tipo: String(row[idx.TIPO] || '').trim(),
      categoria: String(row[idx.CATEGORIA] || '').trim(),
      descricao: String(row[idx.DESCRICAO] || '').trim(),
      valor: parseMoneyPtBr(row[idx.VALOR]),
      id: idx.ID !== undefined ? String(row[idx.ID] || '').trim() : '',
    }))
    .filter((item) => item.data && item.tipo && item.valor !== 0);

  const byDate = new Map();
  const byCategory = new Map();

  for (const item of transactions) {
    if (!byDate.has(item.data)) {
      byDate.set(item.data, { data: item.data, receita: 0, despesa: 0, lucro: 0, margem: null, roasFinanceiro: null, transacoes: 0 });
    }

    const day = byDate.get(item.data);

    if (/^receita/i.test(item.tipo)) day.receita += item.valor;

    if (/^despesa/i.test(item.tipo)) {
      day.despesa += item.valor;
      byCategory.set(item.categoria, (byCategory.get(item.categoria) || 0) + item.valor);
    }

    day.transacoes += 1;
  }

  const daily = Array.from(byDate.values())
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((day) => {
      day.lucro = day.receita - day.despesa;
      day.margem = day.receita > 0 ? day.lucro / day.receita : null;
      day.roasFinanceiro = day.despesa > 0 ? day.receita / day.despesa : null;
      return day;
    });

  const totals = daily.reduce(
    (acc, day) => {
      acc.receita += day.receita;
      acc.despesa += day.despesa;
      acc.lucro += day.lucro;
      acc.transacoes += day.transacoes;
      return acc;
    },
    { receita: 0, despesa: 0, lucro: 0, transacoes: 0 },
  );

  totals.margem = totals.receita > 0 ? totals.lucro / totals.receita : null;
  totals.roasFinanceiro = totals.despesa > 0 ? totals.receita / totals.despesa : null;

  const latest = daily.at(-1) || null;
  const latestDate = latest?.data;
  const latestRevenue = latest?.receita || 0;
  const lastNDays = (n) => daily.filter((day) => latestDate && day.data < latestDate && day.data >= dateAddDays(latestDate, -n));

  const yesterday = latestDate ? daily.find((day) => day.data === dateAddDays(latestDate, -1)) : null;
  const sameWeekdayLastWeek = latestDate ? daily.find((day) => day.data === dateAddDays(latestDate, -7)) : null;
  const avg7 = average(lastNDays(7).map((day) => day.receita));
  const avg14 = average(lastNDays(14).map((day) => day.receita));
  const avg30 = average(lastNDays(30).map((day) => day.receita));

  let projection = null;
  if (latestDate) {
    const [year, month, day] = latestDate.split('-').map(Number);
    const monthDays = new Date(year, month, 0).getDate();
    const remainingDays = Math.max(monthDays - day, 0);
    const remainingToTarget = MONTHLY_REVENUE_TARGET - totals.receita;
    projection = {
      monthDays,
      latestDayOfMonth: day,
      filledDays: daily.length,
      monthlyRevenueTarget: MONTHLY_REVENUE_TARGET,
      targetMargin: TARGET_MARGIN,
      projectedRevenueByFilledDays: daily.length ? (totals.receita / daily.length) * monthDays : 0,
      projectedRevenueByCalendarDay: day ? (totals.receita / day) * monthDays : 0,
      remainingToTarget,
      neededPerRemainingCalendarDay: remainingDays > 0 ? remainingToTarget / remainingDays : 0,
      targetProgress: MONTHLY_REVENUE_TARGET > 0 ? totals.receita / MONTHLY_REVENUE_TARGET : null,
    };
  }

  const comparisons = latest
    ? {
        metric: 'receita_ultimo_dia',
        latestDate,
        latestRevenue,
        vsYesterday: yesterday ? { baselineDate: yesterday.data, baseline: yesterday.receita, delta: latestRevenue - yesterday.receita, deltaPct: compare(latestRevenue, yesterday.receita) } : null,
        vsSameWeekdayLastWeek: sameWeekdayLastWeek ? { baselineDate: sameWeekdayLastWeek.data, baseline: sameWeekdayLastWeek.receita, delta: latestRevenue - sameWeekdayLastWeek.receita, deltaPct: compare(latestRevenue, sameWeekdayLastWeek.receita) } : null,
        vsAvg7: avg7 !== null ? { baseline: avg7, delta: latestRevenue - avg7, deltaPct: compare(latestRevenue, avg7) } : null,
        vsAvg14: avg14 !== null ? { baseline: avg14, delta: latestRevenue - avg14, deltaPct: compare(latestRevenue, avg14) } : null,
        vsAvg30: avg30 !== null ? { baseline: avg30, delta: latestRevenue - avg30, deltaPct: compare(latestRevenue, avg30) } : null,
      }
    : null;

  const categories = Array.from(byCategory.entries())
    .map(([categoria, valor]) => ({ categoria, valor }))
    .sort((a, b) => b.valor - a.valor);

  const alerts = [];
  if (totals.margem !== null && totals.margem < TARGET_MARGIN) alerts.push({ level: 'warning', text: `Margem acumulada abaixo da meta: ${(totals.margem * 100).toFixed(1)}% vs ${(TARGET_MARGIN * 100).toFixed(0)}%` });
  if (projection && projection.neededPerRemainingCalendarDay > latestRevenue) alerts.push({ level: 'warning', text: `Receita do último dia abaixo do necessário/dia para bater meta: ${brl(latestRevenue)} vs ${brl(projection.neededPerRemainingCalendarDay)}` });
  if (comparisons?.vsYesterday?.deltaPct !== null && comparisons?.vsYesterday?.deltaPct < -0.1) alerts.push({ level: 'danger', text: `Receita do último dia caiu ${(Math.abs(comparisons.vsYesterday.deltaPct) * 100).toFixed(1)}% vs dia anterior` });

  const result = { updatedAt: new Date().toISOString(), source: { csvUrl: CSV_URL, sheet: 'Transações' }, totals, latest, daily, categories, comparisons, projection, alerts, transactions };
  cache = { at: now, data: result };
  return result;
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data, null, 2));
}

function htmlPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>abcMusic BI</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root { color-scheme: dark; --bg:#070a12; --card:#101827; --muted:#94a3b8; --text:#e5e7eb; --green:#22c55e; --red:#ef4444; --blue:#60a5fa; --yellow:#f59e0b; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at top, #172554 0, #070a12 40%); color:var(--text); }
    main { max-width:1180px; margin:0 auto; padding:28px 18px 60px; }
    header { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:22px; }
    h1 { margin:0; font-size:28px; letter-spacing:-.04em; }
    .subtitle { color:var(--muted); margin-top:6px; font-size:14px; }
    button { background:#2563eb; color:white; border:0; border-radius:10px; padding:10px 14px; font-weight:700; cursor:pointer; }
    .grid { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:14px; }
    .card { background:rgba(16,24,39,.86); border:1px solid rgba(148,163,184,.16); border-radius:18px; padding:16px; box-shadow:0 10px 30px rgba(0,0,0,.2); }
    .label { color:var(--muted); font-size:13px; margin-bottom:8px; }
    .value { font-size:25px; font-weight:800; letter-spacing:-.04em; }
    .positive { color:var(--green); } .negative { color:var(--red); } .blue { color:var(--blue); } .yellow { color:var(--yellow); }
    .section { margin-top:18px; }
    .charts { display:grid; grid-template-columns: 2fr 1fr; gap:14px; margin-top:14px; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th, td { padding:11px 8px; border-bottom:1px solid rgba(148,163,184,.14); text-align:right; }
    th:first-child, td:first-child { text-align:left; }
    th { color:var(--muted); font-weight:600; }
    .alerts { display:flex; flex-direction:column; gap:8px; }
    .alert { padding:12px 14px; border-radius:12px; background:rgba(245,158,11,.12); border:1px solid rgba(245,158,11,.25); color:#fde68a; }
    .muted { color:var(--muted); }
    @media (max-width:900px){ .grid{grid-template-columns:repeat(2,1fr)} .charts{grid-template-columns:1fr} header{flex-direction:column} }
    @media (max-width:560px){ .grid{grid-template-columns:1fr} .value{font-size:22px} main{padding:18px 12px 40px} }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>abcMusic BI Financeiro</h1>
      <div class="subtitle" id="updated">Carregando dados da planilha...</div>
    </div>
    <button onclick="load(true)">Atualizar</button>
  </header>
  <div class="alerts section" id="alerts"></div>
  <section class="grid section" id="cards"></section>
  <section class="charts section">
    <div class="card"><div class="label">Receita vs gastos por dia</div><canvas id="dailyChart"></canvas></div>
    <div class="card"><div class="label">Despesas por categoria</div><canvas id="categoryChart"></canvas></div>
  </section>
  <section class="card section">
    <div class="label">Comparativo do último dia com histórico disponível</div>
    <div id="comparisons" class="muted"></div>
  </section>
  <section class="card section">
    <div class="label">Tabela diária</div>
    <div style="overflow:auto"><table id="dailyTable"></table></div>
  </section>
</main>
<script>
let dailyChart, categoryChart;
const brl = v => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v || 0);
const pct = v => v == null ? '—' : new Intl.NumberFormat('pt-BR',{maximumFractionDigits:1}).format(v*100)+'%';
const compact = v => new Intl.NumberFormat('pt-BR',{notation:'compact', maximumFractionDigits:1}).format(v || 0);
function metricCard(label, value, cls='') { return '<div class="card"><div class="label">' + label + '</div><div class="value ' + cls + '">' + value + '</div></div>'; }
function comparisonLine(label, c) {
  if (!c) return '<div>' + label + ': sem histórico suficiente</div>';
  const cls = c.delta >= 0 ? 'positive' : 'negative';
  return '<div>' + label + ': <b>' + brl(c.baseline) + '</b> → <span class="' + cls + '">' + brl(c.delta) + ' (' + pct(c.deltaPct) + ')</span></div>';
}
async function load(force=false) {
  const res = await fetch('/api/metrics' + (force ? '?force=1' : ''));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar');
  document.getElementById('updated').textContent = 'Atualizado em ' + new Date(data.updatedAt).toLocaleString('pt-BR') + ' • Fonte: Google Sheets / aba Transações';
  document.getElementById('cards').innerHTML = [
    metricCard('Receita acumulada', brl(data.totals.receita), 'positive'),
    metricCard('Gastos acumulados', brl(data.totals.despesa), 'negative'),
    metricCard('Lucro estimado', brl(data.totals.lucro), data.totals.lucro >= 0 ? 'positive' : 'negative'),
    metricCard('Margem', pct(data.totals.margem), data.totals.margem >= 0.55 ? 'positive' : 'yellow'),
    metricCard('ROAS financeiro', data.totals.roasFinanceiro ? data.totals.roasFinanceiro.toFixed(2).replace('.',',') : '—', 'blue'),
    metricCard('Última receita diária', brl(data.latest?.receita || 0), 'positive'),
    metricCard('Projeção mês', brl(data.projection?.projectedRevenueByFilledDays || 0), 'blue'),
    metricCard('Necessário/dia p/ meta', brl(data.projection?.neededPerRemainingCalendarDay || 0), 'yellow')
  ].join('');
  document.getElementById('alerts').innerHTML = data.alerts.length ? data.alerts.map(a => '<div class="alert">' + a.text + '</div>').join('') : '<div class="alert" style="background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.25);color:#bbf7d0">Sem alertas críticos com os dados atuais.</div>';
  document.getElementById('comparisons').innerHTML = [
    comparisonLine('Vs ontem', data.comparisons?.vsYesterday),
    comparisonLine('Vs mesmo dia semana passada', data.comparisons?.vsSameWeekdayLastWeek),
    comparisonLine('Vs média 7d', data.comparisons?.vsAvg7),
    comparisonLine('Vs média 14d', data.comparisons?.vsAvg14),
    comparisonLine('Vs média 30d', data.comparisons?.vsAvg30)
  ].join('');
  document.getElementById('dailyTable').innerHTML = '<thead><tr><th>Data</th><th>Receita</th><th>Gasto</th><th>Lucro</th><th>Margem</th><th>ROAS</th></tr></thead><tbody>' + data.daily.map(d => '<tr><td>' + d.data + '</td><td>' + brl(d.receita) + '</td><td>' + brl(d.despesa) + '</td><td class="' + (d.lucro>=0?'positive':'negative') + '">' + brl(d.lucro) + '</td><td>' + pct(d.margem) + '</td><td>' + (d.roasFinanceiro ? d.roasFinanceiro.toFixed(2).replace('.',',') : '—') + '</td></tr>').join('') + '</tbody>';
  if (typeof Chart === 'undefined') {
    document.getElementById('alerts').innerHTML += '<div class="alert">Dados carregados, mas o Chart.js não carregou. Cards e tabela seguem funcionando.</div>';
    return;
  }
  const labels = data.daily.map(d => d.data.slice(5));
  dailyChart?.destroy();
  dailyChart = new Chart(document.getElementById('dailyChart'), { type:'bar', data:{ labels, datasets:[ {label:'Receita', data:data.daily.map(d=>d.receita), backgroundColor:'rgba(34,197,94,.7)'}, {label:'Gastos', data:data.daily.map(d=>d.despesa), backgroundColor:'rgba(239,68,68,.7)'}, {label:'Lucro', data:data.daily.map(d=>d.lucro), type:'line', borderColor:'#60a5fa', backgroundColor:'#60a5fa'} ]}, options:{ responsive:true, plugins:{legend:{labels:{color:'#e5e7eb'}}}, scales:{x:{ticks:{color:'#94a3b8'}}, y:{ticks:{color:'#94a3b8', callback:v=>compact(v)}}} } });
  categoryChart?.destroy();
  categoryChart = new Chart(document.getElementById('categoryChart'), { type:'doughnut', data:{ labels:data.categories.map(c=>c.categoria), datasets:[{ data:data.categories.map(c=>c.valor), backgroundColor:['#ef4444','#f59e0b','#60a5fa','#22c55e','#a78bfa'] }]}, options:{ plugins:{legend:{position:'bottom', labels:{color:'#e5e7eb'}}} } });
}
load().catch(err => {
  const alerts = document.getElementById('alerts');
  const message = '<div class="alert" style="background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.35);color:#fecaca"><b>Erro ao carregar dados:</b> ' + err.message + '</div>';
  if (alerts) alerts.innerHTML = message;
  else document.body.innerHTML = '<pre style="padding:20px;color:#fecaca">Erro: '+err.message+'</pre>';
  console.error(err);
});
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health') {
      return sendJson(res, { ok: true, service: 'abcmusic-bi', status: 'healthy' });
    }

    if (!requireAuth(req, res)) return;

    if (url.pathname === '/api/metrics') {
      const data = await loadMetrics(url.searchParams.get('force') === '1');
      return sendJson(res, data);
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage());
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`abcMusic BI rodando em http://0.0.0.0:${PORT}`);
});
