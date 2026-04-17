import { supabase } from '../lib/supabase'

// In production set VITE_API_URL to your deployed backend (e.g. https://your-app.railway.app)
// In local dev it falls back to the same host on port 8000 so LAN/mobile access works automatically
const BASE_URL = import.meta.env.VITE_API_URL ||
  `${window.location.protocol}//${window.location.hostname}:8000`

// ── Auth helper ───────────────────────────────────────────
// Gets the current session's JWT and returns it as an
// Authorization header object. Called before every request.

async function authHeaders() {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Not authenticated — please log in.')
  return { 'Authorization': `Bearer ${token}` }
}

// ── Safe JSON parser ──────────────────────────────────────
// Prevents blank-page crashes when the server returns an HTML
// error page (e.g. Railway restarting) instead of JSON.
// Also throws a clean error on non-2xx status codes.

async function safeJson(res) {
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { detail: text.slice(0, 200) } }
  if (!res.ok) throw new Error(body?.detail || `Server error ${res.status}`)
  return body
}

// ── Holdings ──────────────────────────────────────────────

export async function getHoldings() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/holdings`, { headers })
  return safeJson(res)
}

export async function addHolding(data) {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/holdings`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return safeJson(res)
}

export async function updateHolding(id, data) {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/holdings/${id}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return safeJson(res)
}

export async function deleteHolding(id) {
  const headers = await authHeaders()
  await fetch(`${BASE_URL}/holdings/${id}`, {
    method: 'DELETE',
    headers,
  })
}

// ── Brokers ───────────────────────────────────────────────

export async function getBrokers() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/brokers`, { headers })
  return safeJson(res)
}

export async function addBroker(data) {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/brokers`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return safeJson(res)
}

// ── Portfolio History ─────────────────────────────────────

export async function getPortfolioHistory(period = '30d', currency = 'All') {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/portfolio/history?period=${period}&currency=${encodeURIComponent(currency)}`, { headers })
  return safeJson(res)
}

// ── Sparklines ────────────────────────────────────────────

export async function getSparklines(tickers) {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/sparklines?tickers=${tickers.join(',')}`, { headers })
  return safeJson(res)
}

// ── AI Analytics ──────────────────────────────────────────

export async function getAIAnalytics() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/analytics/ai`, { headers })
  return safeJson(res)
}

// ── Ticker Search ─────────────────────────────────────────

export async function searchTicker(q) {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/search/ticker?q=${encodeURIComponent(q)}`, { headers })
  // Return empty array on any error — search failure must never crash the UI
  try {
    const data = await safeJson(res)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

// ── Ask AI ────────────────────────────────────────────────

export async function askAI(question) {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/analytics/ask`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  })
  return safeJson(res)
}

// ── Benchmark Comparison ──────────────────────────────────

export async function getBenchmark() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/analytics/benchmark`, { headers })
  return safeJson(res)
}

// ── CSV Import ────────────────────────────────────────────

export async function importCSV(brokerId, file, replace = false) {
  const headers = await authHeaders()   // no Content-Type — browser sets multipart boundary
  const formData = new FormData()
  formData.append('broker_id', brokerId)
  formData.append('file', file)
  formData.append('replace', replace ? 'true' : 'false')
  const res = await fetch(`${BASE_URL}/import/csv`, {
    method: 'POST',
    headers,
    body: formData,
  })
  return safeJson(res)
}

// ── Sectors ───────────────────────────────────────────────

export async function getSectors() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/analytics/sectors`, { headers })
  return safeJson(res)
}

// ── Market Indices ────────────────────────────────────────

export async function getMarketIndices() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/markets/indices`, { headers })
  return safeJson(res)
}

// ── 52-Week Range ─────────────────────────────────────────

export async function get52Week() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/analytics/52week`, { headers })
  return safeJson(res)
}

// ── FII / DII Flow ────────────────────────────────────────

export async function getFiiDii() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/markets/fiidii`, { headers })
  return safeJson(res)
}

// ── Transactions ──────────────────────────────────────────

export async function getTransactions() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/transactions`, { headers })
  return safeJson(res)
}

export async function addTransaction(data) {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/transactions`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return safeJson(res)
}

export async function updateTransaction(id, data) {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/transactions/${id}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return safeJson(res)
}

export async function deleteTransaction(id) {
  const headers = await authHeaders()
  await fetch(`${BASE_URL}/transactions/${id}`, { method: 'DELETE', headers })
}

export async function migrateHoldings(migrateDate) {
  const headers = await authHeaders()
  const url = migrateDate
    ? `${BASE_URL}/transactions/migrate?migrate_date=${migrateDate}`
    : `${BASE_URL}/transactions/migrate`
  const res = await fetch(url, { method: 'POST', headers })
  return safeJson(res)
}

export async function getRealizedPnl() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/analytics/realized`, { headers })
  return safeJson(res)
}

// ── Tax Report ────────────────────────────────────────────

export async function getTaxReport() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/analytics/tax`, { headers })
  return safeJson(res)
}

// ── FX History ────────────────────────────────────────────

export async function getFxHistory() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/analytics/fx-history`, { headers })
  return safeJson(res)
}

// ── Fundamentals ──────────────────────────────────────────

export async function getFundamentals() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/analytics/fundamentals`, { headers })
  return safeJson(res)
}

// ── Cache ─────────────────────────────────────────────────

export async function clearCache() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/admin/clear-cache`, { method: 'POST', headers })
  return safeJson(res)
}

// ── Holdings maintenance ──────────────────────────────────

export async function mergeDuplicateHoldings() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/holdings/merge-duplicates`, { method: 'POST', headers })
  return safeJson(res)
}

// ── Alerts ────────────────────────────────────────────────

export async function getAlerts() {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/alerts`, { headers })
  return safeJson(res)
}

export async function addAlert(data) {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/alerts`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return safeJson(res)
}

export async function deleteAlert(id) {
  const headers = await authHeaders()
  const res = await fetch(`${BASE_URL}/alerts/${id}`, { method: 'DELETE', headers })
  return safeJson(res)
}
