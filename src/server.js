import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const CSV_URL = process.env.GOOGLE_SHEETS_CSV_URL || 'https://docs.google.com/spreadsheets/d/1chGv3wblDy9_4-OFZ2nEMzR_ipfotyXWbBi1-iDG1Uo/gviz/tq?tqx=out:csv&sheet=Transa%C3%A7%C3%B5es';
const MONTHLY_REVENUE_TARGET = Number(process.env.MONTHLY_REVENUE_TARGET || 1500000);
const TARGET_MARGIN = Number(process.env.TARGET_MARGIN || 0.55);
const BI_USER = process.env.BI_USER || '';
const BI_PASSWORD = process.env.BI_PASSWORD || '';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);

let cache = { at: 0, transactions: null };

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

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
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

async function loadTransactions(force = false) {
  const now = Date.now();
  if (!force && cache.transactions && now - cache.at < CACHE_TTL_MS) return cache.transactions;

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
      categoria: String(row[idx.CATEGORIA] || '').trim() || 'Sem categoria',
      descricao: String(row[idx.DESCRICAO] || '').trim(),
      valor: parseMoneyPtBr(row[idx.VALOR]),
      id: idx.ID !== undefined ? String(row[idx.ID] || '').trim() : '',
    }))
    .filter((item) => item.data && item.tipo && item.valor !== 0)
    .sort((a, b) => a.data.localeCompare(b.data));

  cache = { at: now, transactions };
  return transactions;
}

function aggregateDaily(transactions) {
  const byDate = new Map();

  for (const item of transactions) {
    if (!byDate.has(item.data)) {
      byDate.set(item.data, {
        data: item.data,
        receita: 0,
        despesa: 0,
        lucro: 0,
        margem: null,
        roasFinanceiro: null,
        transacoes: 0,
      });
    }

    const day = byDate.get(item.data);

    if (/^receita/i.test(item.tipo)) day.receita += item.valor;
    if (/^despesa/i.test(item.tipo)) day.despesa += item.valor;

    day.transacoes += 1;
  }

  return Array.from(byDate.values())
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((day) => {
      day.lucro = day.receita - day.despesa;
      day.margem = day.receita > 0 ? day.lucro / day.receita : null;
      day.roasFinanceiro = day.despesa > 0 ? day.receita / day.despesa : null;
      return day;
    });
}

function aggregateTotals(daily) {
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

  return totals;
}

function aggregateCategories(transactions) {
  const byCategory = new Map();

  for (const item of transactions) {
    if (/^despesa/i.test(item.tipo)) {
      byCategory.set(item.categoria, (byCategory.get(item.categoria) || 0) + item.valor);
    }
  }

  return Array.from(byCategory.entries())
    .map(([categoria, valor]) => ({ categoria, valor }))
    .sort((a, b) => b.valor - a.valor);
}

function getDateRange(transactions, searchParams) {
  const dates = transactions.map((item) => item.data).filter(Boolean).sort();
  const minDate = dates[0] || null;
  const maxDate = dates.at(-1) || null;
  const requestedFrom = searchParams.get('from');
  const requestedTo = searchParams.get('to');

  const from = isIsoDate(requestedFrom) ? requestedFrom : minDate;
  const to = isIsoDate(requestedTo) ? requestedTo : maxDate;

  return { from, to, minDate, maxDate };
}

function filterTransactionsByDate(transactions, range) {
  return transactions.filter((item) => {
    if (range.from && item.data < range.from) return false;
    if (range.to && item.data > range.to) return false;
    return true;
  });
}

function buildProjection(totals, daily) {
  const latest = daily.at(-1) || null;
  if (!latest) return null;

  const [year, month, day] = latest.data.split('-').map(Number);
  const monthDays = new Date(year, month, 0).getDate();
  const remainingDays = Math.max(monthDays - day, 0);
  const remainingToTarget = MONTHLY_REVENUE_TARGET - totals.receita;

  return {
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

function buildComparisons(latest, allDaily) {
  if (!latest) return null;

  const latestDate = latest.data;
  const latestRevenue = latest.receita;
  const lastNDays = (n) => allDaily.filter((day) => day.data < latestDate && day.data >= dateAddDays(latestDate, -n));
  const yesterday = allDaily.find((day) => day.data === dateAddDays(latestDate, -1));
  const sameWeekdayLastWeek = allDaily.find((day) => day.data === dateAddDays(latestDate, -7));
  const avg7 = average(lastNDays(7).map((day) => day.receita));
  const avg14 = average(lastNDays(14).map((day) => day.receita));
  const avg30 = average(lastNDays(30).map((day) => day.receita));

  return {
    metric: 'receita_ultimo_dia_do_periodo',
    latestDate,
    latestRevenue,
    vsYesterday: yesterday ? { baselineDate: yesterday.data, baseline: yesterday.receita, delta: latestRevenue - yesterday.receita, deltaPct: compare(latestRevenue, yesterday.receita) } : null,
    vsSameWeekdayLastWeek: sameWeekdayLastWeek ? { baselineDate: sameWeekdayLastWeek.data, baseline: sameWeekdayLastWeek.receita, delta: latestRevenue - sameWeekdayLastWeek.receita, deltaPct: compare(latestRevenue, sameWeekdayLastWeek.receita) } : null,
    vsAvg7: avg7 !== null ? { baseline: avg7, delta: latestRevenue - avg7, deltaPct: compare(latestRevenue, avg7) } : null,
    vsAvg14: avg14 !== null ? { baseline: avg14, delta: latestRevenue - avg14, deltaPct: compare(latestRevenue, avg14) } : null,
    vsAvg30: avg30 !== null ? { baseline: avg30, delta: latestRevenue - avg30, deltaPct: compare(latestRevenue, avg30) } : null,
  };
}

function buildMetrics(transactions, searchParams) {
  const range = getDateRange(transactions, searchParams);
  const filteredTransactions = filterTransactionsByDate(transactions, range);
  const allDaily = aggregateDaily(transactions);
  const daily = aggregateDaily(filteredTransactions);
  const categories = aggregateCategories(filteredTransactions);
  const totals = aggregateTotals(daily);
  const latest = daily.at(-1) || null;
  const comparisons = buildComparisons(latest, allDaily);
  const projection = buildProjection(totals, daily);

  const alerts = [];

  if (!daily.length) {
    alerts.push({ level: 'warning', text: 'Nenhum dado encontrado para o período selecionado.' });
  }

  if (totals.margem !== null && totals.margem < TARGET_MARGIN) {
    alerts.push({ level: 'warning', text: `Margem do período abaixo da meta: ${(totals.margem * 100).toFixed(1)}% vs ${(TARGET_MARGIN * 100).toFixed(0)}%` });
  }

  if (projection && projection.neededPerRemainingCalendarDay > (latest?.receita || 0)) {
    alerts.push({ level: 'warning', text: `Receita do último dia abaixo do necessário/dia para bater meta: ${brl(latest?.receita || 0)} vs ${brl(projection.neededPerRemainingCalendarDay)}` });
  }

  if (comparisons?.vsYesterday?.deltaPct !== null && comparisons?.vsYesterday?.deltaPct < -0.1) {
    alerts.push({ level: 'danger', text: `Receita do último dia caiu ${(Math.abs(comparisons.vsYesterday.deltaPct) * 100).toFixed(1)}% vs dia anterior` });
  }

  return {
    updatedAt: new Date().toISOString(),
    source: { csvUrl: CSV_URL, sheet: 'Transações' },
    dateRange: {
      ...range,
      daysWithData: daily.length,
      availableDays: allDaily.length,
    },
    totals,
    latest,
    daily,
    categories,
    comparisons,
    projection,
    alerts,
    transactions: filteredTransactions,
  };
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
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7fb;
      --panel: #ffffff;
      --line: #e5e7eb;
      --text: #101828;
      --muted: #667085;
      --green: #039855;
      --red: #d92d20;
      --blue: #2563eb;
      --yellow: #b54708;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }

    main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 22px 14px 44px;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 14px;
      margin-bottom: 14px;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      letter-spacing: -0.04em;
    }

    .subtitle {
      color: var(--muted);
      margin-top: 4px;
      font-size: 13px;
    }

    .panel, .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05);
    }

    .panel { padding: 14px; }

    .toolbar {
      display: grid;
      grid-template-columns: 1fr 1fr auto auto;
      gap: 10px;
      align-items: end;
      margin-bottom: 14px;
    }

    label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 5px;
    }

    input {
      width: 100%;
      height: 40px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      color: var(--text);
      font: inherit;
    }

    button {
      height: 40px;
      border: 0;
      border-radius: 10px;
      padding: 0 13px;
      font-weight: 800;
      cursor: pointer;
      background: var(--blue);
      color: #fff;
    }

    button.secondary {
      background: #fff;
      color: var(--text);
      border: 1px solid var(--line);
    }

    .quick-filters {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }

    .quick-filters button {
      height: 34px;
      font-size: 13px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }

    .card {
      padding: 14px;
    }

    .label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 7px;
    }

    .value {
      font-size: 24px;
      font-weight: 900;
      letter-spacing: -0.04em;
      line-height: 1.1;
    }

    .small {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
    }

    .positive { color: var(--green); }
    .negative { color: var(--red); }
    .blue { color: var(--blue); }
    .yellow { color: var(--yellow); }
    .muted { color: var(--muted); }
    .section { margin-top: 12px; }

    .summary {
      display: grid;
      grid-template-columns: 1.15fr .85fr;
      gap: 10px;
    }

    .bars {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .bar-row {
      display: grid;
      grid-template-columns: 82px 1fr 92px;
      gap: 9px;
      align-items: center;
      font-size: 13px;
    }

    .bar-track {
      height: 10px;
      border-radius: 999px;
      background: #eef2f7;
      overflow: hidden;
    }

    .bar-fill {
      height: 100%;
      border-radius: 999px;
      background: var(--green);
    }

    .bar-fill.expense { background: var(--red); }

    .alerts {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .alert {
      padding: 10px 12px;
      border-radius: 10px;
      background: #fffaeb;
      border: 1px solid #fedf89;
      color: #93370d;
      font-size: 13px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    th, td {
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      text-align: right;
      white-space: nowrap;
    }

    th:first-child, td:first-child,
    th:nth-child(2), td:nth-child(2) {
      text-align: left;
    }

    th {
      color: var(--muted);
      font-weight: 800;
      background: #f9fafb;
    }

    .table-wrap { overflow: auto; }

    @media (max-width: 900px) {
      header { flex-direction: column; }
      .toolbar { grid-template-columns: 1fr 1fr; }
      .grid { grid-template-columns: repeat(2, 1fr); }
      .summary { grid-template-columns: 1fr; }
    }

    @media (max-width: 560px) {
      main { padding: 14px 10px 34px; }
      h1 { font-size: 22px; }
      .toolbar { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
      .value { font-size: 22px; }
      .bar-row { grid-template-columns: 72px 1fr 86px; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>abcMusic BI</h1>
      <div class="subtitle" id="updated">Carregando dados...</div>
    </div>
    <button onclick="load(true)">Atualizar</button>
  </header>

  <section class="panel">
    <div class="toolbar">
      <div>
        <label for="fromDate">Data inicial</label>
        <input id="fromDate" type="date" />
      </div>
      <div>
        <label for="toDate">Data final</label>
        <input id="toDate" type="date" />
      </div>
      <button onclick="applyDateFilter()">Filtrar</button>
      <button class="secondary" onclick="clearDateFilter()">Ver tudo</button>
    </div>
    <div class="quick-filters">
      <button class="secondary" onclick="quickFilter(7)">Últimos 7 dias</button>
      <button class="secondary" onclick="quickFilter(14)">Últimos 14 dias</button>
      <button class="secondary" onclick="quickFilter(30)">Últimos 30 dias</button>
      <button class="secondary" onclick="currentMonth()">Mês atual</button>
    </div>
  </section>

  <section class="alerts section" id="alerts"></section>
  <section class="grid section" id="cards"></section>

  <section class="summary section">
    <div class="card">
      <div class="label">Receita e gastos por dia</div>
      <div class="bars" id="dailyBars"></div>
    </div>
    <div class="card">
      <div class="label">Resumo rápido</div>
      <div id="quickSummary" class="muted"></div>
    </div>
  </section>

  <section class="card section">
    <div class="label">Despesas por categoria</div>
    <div class="table-wrap"><table id="categoryTable"></table></div>
  </section>

  <section class="card section">
    <div class="label">Tabela diária</div>
    <div class="table-wrap"><table id="dailyTable"></table></div>
  </section>
</main>
<script>
const brl = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
const pct = (value) => value == null ? '—' : new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value * 100) + '%';
const fmtNumber = (value, digits = 2) => value == null ? '—' : Number(value).toFixed(digits).replace('.', ',');
let lastData = null;

function metricCard(label, value, cls = '', small = '') {
  return '<div class="card"><div class="label">' + label + '</div><div class="value ' + cls + '">' + value + '</div>' + (small ? '<div class="small">' + small + '</div>' : '') + '</div>';
}

function comparisonLine(label, item) {
  if (!item) return '<div>' + label + ': sem histórico suficiente</div>';
  const cls = item.delta >= 0 ? 'positive' : 'negative';
  return '<div>' + label + ': <b>' + brl(item.baseline) + '</b> → <span class="' + cls + '">' + brl(item.delta) + ' (' + pct(item.deltaPct) + ')</span></div>';
}

function buildApiUrl(force = false) {
  const params = new URLSearchParams();
  const from = document.getElementById('fromDate').value;
  const to = document.getElementById('toDate').value;

  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (force) params.set('force', '1');

  const query = params.toString();
  return '/api/metrics' + (query ? '?' + query : '');
}

function setInputsFromData(data) {
  const fromInput = document.getElementById('fromDate');
  const toInput = document.getElementById('toDate');

  fromInput.min = data.dateRange.minDate || '';
  fromInput.max = data.dateRange.maxDate || '';
  toInput.min = data.dateRange.minDate || '';
  toInput.max = data.dateRange.maxDate || '';

  if (!fromInput.value) fromInput.value = data.dateRange.from || '';
  if (!toInput.value) toInput.value = data.dateRange.to || '';
}

function renderCards(data) {
  const days = data.dateRange.daysWithData || 0;
  const avgRevenue = days ? data.totals.receita / days : 0;
  const avgExpense = days ? data.totals.despesa / days : 0;

  document.getElementById('cards').innerHTML = [
    metricCard('Receita', brl(data.totals.receita), 'positive', 'Média/dia: ' + brl(avgRevenue)),
    metricCard('Gastos', brl(data.totals.despesa), 'negative', 'Média/dia: ' + brl(avgExpense)),
    metricCard('Lucro', brl(data.totals.lucro), data.totals.lucro >= 0 ? 'positive' : 'negative'),
    metricCard('Margem', pct(data.totals.margem), data.totals.margem >= 0.55 ? 'positive' : 'yellow'),
    metricCard('ROAS financeiro', fmtNumber(data.totals.roasFinanceiro), 'blue'),
    metricCard('Dias com dados', String(days), 'blue'),
    metricCard('Última receita', brl(data.latest?.receita || 0), 'positive', data.latest?.data || '—'),
    metricCard('Necessário/dia meta', brl(data.projection?.neededPerRemainingCalendarDay || 0), 'yellow')
  ].join('');
}

function renderAlerts(data) {
  document.getElementById('alerts').innerHTML = data.alerts.length
    ? data.alerts.map((alert) => '<div class="alert">' + alert.text + '</div>').join('')
    : '<div class="alert" style="background:#ecfdf3;border-color:#abefc6;color:#067647">Sem alertas críticos no período selecionado.</div>';
}

function renderDailyBars(data) {
  const days = data.daily.slice(-18);
  const maxValue = Math.max(1, ...days.map((day) => Math.max(day.receita, day.despesa)));

  document.getElementById('dailyBars').innerHTML = days.length
    ? days.map((day) => {
        const receitaWidth = Math.max(3, Math.round((day.receita / maxValue) * 100));
        const despesaWidth = Math.max(3, Math.round((day.despesa / maxValue) * 100));

        return '<div>' +
          '<div class="bar-row"><b>' + day.data.slice(5) + '</b><div class="bar-track"><div class="bar-fill" style="width:' + receitaWidth + '%"></div></div><span class="positive">' + brl(day.receita) + '</span></div>' +
          '<div class="bar-row"><span class="muted">gasto</span><div class="bar-track"><div class="bar-fill expense" style="width:' + despesaWidth + '%"></div></div><span class="negative">' + brl(day.despesa) + '</span></div>' +
        '</div>';
      }).join('')
    : '<div class="muted">Sem dados para exibir.</div>';
}

function renderQuickSummary(data) {
  document.getElementById('quickSummary').innerHTML = [
    '<div><b>Período:</b> ' + (data.dateRange.from || '—') + ' até ' + (data.dateRange.to || '—') + '</div>',
    '<div><b>Transações:</b> ' + data.totals.transacoes + '</div>',
    '<div><b>Meta mensal:</b> ' + brl(data.projection?.monthlyRevenueTarget || 0) + '</div>',
    '<div><b>Projeção:</b> ' + brl(data.projection?.projectedRevenueByFilledDays || 0) + '</div>',
    '<br>',
    comparisonLine('Vs ontem', data.comparisons?.vsYesterday),
    comparisonLine('Vs mesmo dia semana passada', data.comparisons?.vsSameWeekdayLastWeek),
    comparisonLine('Vs média 7d', data.comparisons?.vsAvg7),
    comparisonLine('Vs média 14d', data.comparisons?.vsAvg14),
    comparisonLine('Vs média 30d', data.comparisons?.vsAvg30)
  ].join('');
}

function renderTables(data) {
  document.getElementById('categoryTable').innerHTML = '<thead><tr><th>Categoria</th><th>Valor</th><th>% dos gastos</th></tr></thead><tbody>' +
    (data.categories.length ? data.categories.map((item) => {
      const share = data.totals.despesa > 0 ? item.valor / data.totals.despesa : null;
      return '<tr><td>' + item.categoria + '</td><td class="negative">' + brl(item.valor) + '</td><td>' + pct(share) + '</td></tr>';
    }).join('') : '<tr><td colspan="3">Sem despesas no período.</td></tr>') +
    '</tbody>';

  document.getElementById('dailyTable').innerHTML = '<thead><tr><th>Data</th><th>Transações</th><th>Receita</th><th>Gastos</th><th>Lucro</th><th>Margem</th><th>ROAS</th></tr></thead><tbody>' +
    (data.daily.length ? data.daily.map((day) => '<tr><td>' + day.data + '</td><td>' + day.transacoes + '</td><td class="positive">' + brl(day.receita) + '</td><td class="negative">' + brl(day.despesa) + '</td><td class="' + (day.lucro >= 0 ? 'positive' : 'negative') + '">' + brl(day.lucro) + '</td><td>' + pct(day.margem) + '</td><td>' + fmtNumber(day.roasFinanceiro) + '</td></tr>').join('') : '<tr><td colspan="7">Sem dados no período selecionado.</td></tr>') +
    '</tbody>';
}

async function load(force = false) {
  const response = await fetch(buildApiUrl(force));
  const data = await response.json();

  if (!response.ok) throw new Error(data.error || 'Erro ao carregar dados');

  lastData = data;
  setInputsFromData(data);

  document.getElementById('updated').textContent = 'Atualizado em ' + new Date(data.updatedAt).toLocaleString('pt-BR') + ' • Fonte: Google Sheets / Transações';

  renderAlerts(data);
  renderCards(data);
  renderDailyBars(data);
  renderQuickSummary(data);
  renderTables(data);
}

function applyDateFilter() {
  load(false).catch(showError);
}

function clearDateFilter() {
  document.getElementById('fromDate').value = '';
  document.getElementById('toDate').value = '';
  load(false).catch(showError);
}

function quickFilter(days) {
  if (!lastData?.dateRange?.maxDate) return;

  const maxDate = lastData.dateRange.maxDate;
  const end = new Date(maxDate + 'T00:00:00Z');
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);

  document.getElementById('fromDate').value = start.toISOString().slice(0, 10);
  document.getElementById('toDate').value = maxDate;
  load(false).catch(showError);
}

function currentMonth() {
  if (!lastData?.dateRange?.maxDate) return;

  const maxDate = lastData.dateRange.maxDate;
  document.getElementById('fromDate').value = maxDate.slice(0, 8) + '01';
  document.getElementById('toDate').value = maxDate;
  load(false).catch(showError);
}

function showError(error) {
  const alerts = document.getElementById('alerts');
  const message = '<div class="alert" style="background:#fef3f2;border-color:#fecdca;color:#b42318"><b>Erro ao carregar dados:</b> ' + error.message + '</div>';

  if (alerts) alerts.innerHTML = message;
  else document.body.innerHTML = '<pre style="padding:20px;color:#b42318">Erro: ' + error.message + '</pre>';

  console.error(error);
}

load(false).catch(showError);
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
      const transactions = await loadTransactions(url.searchParams.get('force') === '1');
      const data = buildMetrics(transactions, url.searchParams);
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
