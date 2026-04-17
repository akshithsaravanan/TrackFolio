import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { getHoldings, deleteHolding, addTransaction, getTransactions, deleteTransaction, clearCache } from '../api/client'
import HoldingModal  from '../components/holdings/HoldingModal'
import BrokerModal   from '../components/holdings/BrokerModal'
import CSVImportModal from '../components/holdings/CSVImportModal'
import { useHideValues } from '../context/HideValuesContext'

// ── Flag helper ──────────────────────────────────────────
function getFlag(ticker, currency) {
  if (currency === 'INR' || ticker.endsWith('.NS') || ticker.endsWith('.BO')) return '🇮🇳'
  if (currency === 'AED' || ticker.endsWith('.AE') || ticker.includes('EMAAR')) return '🇦🇪'
  return '🇺🇸'
}

// ── 7-day trend badge (replaces sparkline) ───────────────
function TrendBadge({ data, currency }) {
  if (!data || data.length < 2) return <span style={{ color: 'var(--text-4)', fontSize: '11px' }}>—</span>
  const first = data[0], last = data[data.length - 1]
  const pct = ((last - first) / first * 100)
  const up  = pct >= 0
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '3px',
      padding: '3px 8px', borderRadius: '6px',
      background: up ? '#4ade8015' : '#f8717115',
      border: `1px solid ${up ? '#4ade8030' : '#f8717130'}`,
      fontSize: '11px', fontWeight: 700,
      color: up ? '#4ade80' : '#f87171',
      whiteSpace: 'nowrap',
    }}>
      {up ? '▲' : '▼'} {up ? '+' : ''}{pct.toFixed(1)}%
      <span style={{ fontWeight: 400, opacity: 0.7, marginLeft: '2px' }}>7d</span>
    </div>
  )
}

// ── Currency filter pill ─────────────────────────────────
function CurrencyFilter({ value, onChange, currencies }) {
  return (
    <div style={{ display: 'flex', gap: '6px' }}>
      {['All', ...currencies].map(c => (
        <button key={c} onClick={() => onChange(c)} style={{
          padding: '5px 12px', borderRadius: '20px', fontSize: '12px',
          fontWeight: value === c ? 600 : 400, cursor: 'pointer',
          border: '1px solid var(--border)',
          background: value === c ? 'var(--accent)' : 'transparent',
          color: value === c ? '#fff' : 'var(--text-3)',
          transition: 'all 0.15s',
        }}>{c}</button>
      ))}
    </div>
  )
}

// ── Format helpers ───────────────────────────────────────
function fmtLocal(price, currency) {
  if (price == null) return '—'
  if (currency === 'INR') return `₹${price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (currency === 'AED') return `AED ${price.toFixed(2)}`
  return `$${price.toFixed(2)}`
}
function fmtUSD(v) { return v == null ? '—' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }

// ── FX gain calculation ──────────────────────────────────
// Total gain = stock gain + fx gain
// Stock gain (in USD) = (current_price_usd - avg_buy_price_usd) * qty
// FX gain = total gain USD - stock gain USD  (the rest is currency movement)
function calcFxGain(h) {
  if (!h.gain_loss_usd || !h.current_price_usd || !h.cost_basis_usd) return null
  const currentPriceUSD = h.current_price_usd
  const buyPriceUSD     = h.cost_basis_usd / h.quantity
  const stockGainUSD    = (currentPriceUSD - buyPriceUSD) * h.quantity
  const fxGainUSD       = h.gain_loss_usd - stockGainUSD
  if (Math.abs(fxGainUSD) < 0.01) return null
  return { stock: stockGainUSD, fx: fxGainUSD }
}

// ════════════════════════════════════════════════════════
// ── Sort state ───────────────────────────────────────────
const SORT_COLS = ['ticker','quantity','avg_buy_price','current_price_local','market_value_usd','gain_loss_usd','gain_loss_pct','daily_change_pct']

export default function HoldingsPage() {
  const { mask } = useHideValues()
  const [holdings,  setHoldings]  = useState([])
  const [summary,   setSummary]   = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [refreshing,setRefreshing]= useState(false)
  const [currency,  setCurrency]  = useState('All')
  const [sortCol,   setSortCol]   = useState('market_value_usd')
  const [sortAsc,   setSortAsc]   = useState(false)
  const [searchQ,   setSearchQ]   = useState('')

  // Show USD sub-line only when All or USD tab — computed once at component level
  const showUsdSub = currency === 'All' || currency === 'USD'

  const navigate = useNavigate()
  const [showModal,      setShowModal]      = useState(false)
  const [editHolding,    setEditHolding]    = useState(null)
  const [showBrokerModal,setShowBrokerModal]= useState(false)
  const [showCSVModal,   setShowCSVModal]   = useState(false)
  const [quickTrade,     setQuickTrade]     = useState(null)  // holding to log trade for
  const [qtForm,         setQtForm]         = useState({})
  const [qtSaving,       setQtSaving]       = useState(false)
  const [qtErr,          setQtErr]          = useState('')
  const [expandedBrokers,setExpandedBrokers]= useState(new Set())
  const [expandedRows,   setExpandedRows]   = useState(new Set())
  const [expandedTxns,   setExpandedTxns]   = useState(new Set())
  const [transactions,   setTransactions]   = useState([])
  const [isMobile,       setIsMobile]       = useState(() => window.innerWidth < 768)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const [mobileSortOpen, setMobileSortOpen] = useState(false)

  // Keep isMobile in sync with viewport width
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  function toggleBroker(name) {
    setExpandedBrokers(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function toggleRow(id) {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleSort(col) {
    if (sortCol === col) setSortAsc(v => !v)
    else { setSortCol(col); setSortAsc(false) }
  }

  function openMarket(ticker) {
    // Map .NS/.BO tickers to TradingView symbols and open in new tab
    let sym = ticker
    if (ticker.endsWith('.NS')) sym = `NSE:${ticker.replace('.NS','')}`
    else if (ticker.endsWith('.BO')) sym = `BSE:${ticker.replace('.BO','')}`
    else if (ticker.endsWith('.AE')) sym = `DFM:${ticker.replace('.AE','')}`
    window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`, '_blank')
  }

  useEffect(() => {
    loadHoldings()
    // Auto-refresh prices every 5 minutes when tab is visible
    const autoRefresh = localStorage.getItem('autoRefresh') !== 'false'
    if (!autoRefresh) return
    const interval = setInterval(() => {
      if (!document.hidden) silentReload()
    }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  async function loadHoldings() {
    setLoading(true); setError('')
    try {
      const [data, txns] = await Promise.all([
        getHoldings(),
        getTransactions().catch(() => []),
      ])
      const h = data.holdings || []
      setHoldings(h)
      setSummary(data.summary || null)
      // Auto-select native currency when portfolio has only one currency
      const currencies = [...new Set(h.map(x => x.currency))]
      if (currencies.length === 1) setCurrency(currencies[0])
      setTransactions(Array.isArray(txns) ? txns : [])
    } catch {
      setError('Could not connect to backend.')
    } finally { setLoading(false) }
  }

  // Silent reload — updates data without resetting UI state (expanded rows, scroll, etc.)
  async function silentReload() {
    try {
      const data = await getHoldings()
      setHoldings(data.holdings || [])
      setSummary(data.summary || null)
    } catch { /* ignore — stale data still visible */ }
  }

  function handleModalClose() { setShowModal(false); setEditHolding(null); silentReload() }

  async function refreshPrices() {
    setRefreshing(true)
    try {
      await clearCache()
      await loadHoldings()   // reload with fresh prices
    } finally {
      setRefreshing(false)
    }
  }

  function exportCSV() {
    const h = currency === 'All' ? holdings : holdings.filter(h => h.currency === currency)
    const headers = ['Ticker','Name','Currency','Asset Type','Qty','Avg Buy Price','Current Price','Market Value (USD)','P&L USD','P&L %','Daily P&L USD','Broker']
    const rows = h.map(x => [
      x.ticker, x.name || '', x.currency, x.asset_type,
      x.quantity, x.avg_buy_price,
      x.current_price_local ?? '', x.market_value_usd ?? '',
      x.gain_loss_usd ?? '', x.gain_loss_pct ?? '',
      x.daily_change_usd ?? '', x.broker_name || '',
    ])
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a'); a.href = url; a.download = 'holdings.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  async function saveQuickTrade() {
    if (!qtForm.quantity || Number(qtForm.quantity) <= 0) return setQtErr('Enter quantity')
    if (qtForm.price === '' || qtForm.price == null) return setQtErr('Enter price')
    if (!qtForm.trade_date) return setQtErr('Enter date')
    setQtErr(''); setQtSaving(true)
    try {
      await addTransaction({
        ticker:     quickTrade.ticker,
        name:       quickTrade.name || quickTrade.ticker,
        type:       qtForm.type || 'buy',
        quantity:   Number(qtForm.quantity),
        price:      Number(qtForm.price),
        currency:   quickTrade.currency,
        broker_id:  quickTrade.broker_id || null,
        trade_date: qtForm.trade_date,
        notes:      qtForm.notes || '',
      })
      setQuickTrade(null)
      setQtForm({})
      silentReload()
    } catch { setQtErr('Save failed') }
    finally { setQtSaving(false) }
  }

  function toggleTxns(id) {
    setExpandedTxns(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Currency filter + search
  const currencies = [...new Set(holdings.map(h => h.currency))].sort()
  const q = searchQ.toLowerCase().trim()
  const filtered = holdings
    .filter(h => currency === 'All' || h.currency === currency)
    .filter(h => !q || h.ticker.toLowerCase().includes(q) || (h.name||'').toLowerCase().includes(q) || (h.asset_type||'').toLowerCase().includes(q))

  // Group by broker
  const grouped = filtered.reduce((acc, h) => {
    if (!acc[h.broker_name]) acc[h.broker_name] = []
    acc[h.broker_name].push(h)
    return acc
  }, {})

  // Group transactions by ticker for inline view
  const txnsByTicker = transactions.reduce((acc, t) => {
    if (!acc[t.ticker]) acc[t.ticker] = []
    acc[t.ticker].push(t)
    return acc
  }, {})

  const totalUSD = currency === 'All'
    ? (summary?.total_market_value_usd || 0)
    : filtered.reduce((s, h) => s + (h.market_value_usd || 0), 0)

  // Broker allocation (for compact bar)
  const byBroker = Object.values(
    filtered.reduce((acc, h) => {
      const key = h.broker_name || 'Unknown'
      if (!acc[key]) acc[key] = { name: key, value: 0, localValue: 0, currency: h.currency }
      acc[key].value      += h.market_value_usd   || 0
      acc[key].localValue += h.market_value_local || 0
      return acc
    }, {})
  ).sort((a, b) => b.value - a.value)

  // Expand / collapse all
  const brokerNames   = Object.keys(grouped)
  const allExpanded   = brokerNames.length > 0 && brokerNames.every(n => expandedBrokers.has(n))
  function toggleExpandAll() {
    setExpandedBrokers(allExpanded ? new Set() : new Set(brokerNames))
  }

  return (
    <div style={{ color: 'var(--text-1)', display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, marginBottom: '4px', paddingLeft: '12px', borderLeft: '3px solid var(--accent)' }}>Holdings</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-2)', fontSize: '14px' }}>
              Total&nbsp;<strong style={{ color: 'var(--text-1)' }}>{mask(fmtUSD(totalUSD))}</strong>
            </span>
            {summary?.prices_as_of && (
              <span style={{ color: 'var(--text-4)', fontSize: '12px' }}>
                📡 {formatTS(summary.prices_as_of)} UTC
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button style={btn2} onClick={refreshPrices} disabled={refreshing}>
            {refreshing ? '↻…' : '↻ Refresh'}
          </button>
          <button style={btn2} onClick={toggleExpandAll} title={allExpanded ? 'Collapse all brokers' : 'Expand all brokers'}>
            {allExpanded ? '⊟ Collapse' : '⊞ Expand'}
          </button>
          {/* Desktop buttons */}
          {!isMobile && <>
            <button style={btn2} onClick={exportCSV}>↓ CSV</button>
            <button style={btn2} onClick={() => navigate('/transactions')}>⇄ All Trades</button>
            <button style={btn2} onClick={() => setShowBrokerModal(true)}>+ Broker</button>
            <button style={btn2} onClick={() => setShowCSVModal(true)}>⬆ Import</button>
          </>}
          {/* Mobile ⋯ menu */}
          {isMobile && (
            <div style={{ position: 'relative' }}>
              <button style={btn2} onClick={() => setShowMobileMenu(m => !m)}>⋯</button>
              {showMobileMenu && (
                <div style={{
                  position: 'absolute', right: 0, top: '36px', zIndex: 500,
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  borderRadius: '10px', padding: '6px', minWidth: '160px',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                  display: 'flex', flexDirection: 'column', gap: '4px',
                }}>
                  {[
                    { label: '↓ Export CSV',    action: () => { exportCSV(); setShowMobileMenu(false) } },
                    { label: '⇄ All Trades',    action: () => { navigate('/transactions'); setShowMobileMenu(false) } },
                    { label: '+ Add Broker',    action: () => { setShowBrokerModal(true); setShowMobileMenu(false) } },
                    { label: '⬆ Import CSV',   action: () => { setShowCSVModal(true); setShowMobileMenu(false) } },
                  ].map(item => (
                    <button key={item.label} onClick={item.action} style={{
                      padding: '9px 14px', borderRadius: '7px',
                      border: 'none', background: 'transparent',
                      color: 'var(--text-2)', fontSize: '13px', fontWeight: 500,
                      cursor: 'pointer', textAlign: 'left',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => e.target.style.background = 'var(--bg-base)'}
                    onMouseLeave={e => e.target.style.background = 'transparent'}
                    >{item.label}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button style={btn1} onClick={() => { setEditHolding(null); setShowModal(true) }}>+ Add</button>
        </div>
      </div>

      {/* ── Search + Currency filter + Mobile sort ── */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
          placeholder="Search ticker, name…"
          style={{ padding: '9px 12px', borderRadius: '8px', border: '1px solid var(--border)',
            background: 'var(--bg-input)', color: 'var(--text-1)', fontSize: '13px',
            outline: 'none', flex: '1 1 160px', minWidth: '140px', maxWidth: isMobile ? '100%' : '280px' }}
        />
        {currencies.length > 1 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <CurrencyFilter value={currency} onChange={setCurrency} currencies={currencies} />
          </div>
        )}
        {/* Mobile sort button */}
        {isMobile && (
          <div style={{ position: 'relative', marginLeft: 'auto' }}>
            <button style={{ ...btn2, display: 'flex', alignItems: 'center', gap: '5px',
              color: sortCol !== 'market_value_usd' ? 'var(--accent)' : 'var(--text-3)',
              borderColor: sortCol !== 'market_value_usd' ? 'var(--accent)' : 'var(--border)' }}
              onClick={() => setMobileSortOpen(o => !o)}>
              ⇅ Sort{sortCol !== 'market_value_usd' ? ' ●' : ''}
            </button>
            {mobileSortOpen && (
              <div style={{ position: 'absolute', right: 0, top: '38px', zIndex: 500,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: '10px', padding: '6px', minWidth: '180px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {[
                  { col: 'market_value_usd',  label: 'Value',           icon: '$' },
                  { col: 'gain_loss_pct',      label: 'Total Gain %',    icon: '%' },
                  { col: 'daily_change_usd',   label: "Today's Change",  icon: '↕' },
                  { col: 'ticker',             label: 'Ticker A→Z',      icon: 'Az' },
                ].map(opt => (
                  <button key={opt.col} onClick={() => { handleSort(opt.col); setExpandedBrokers(new Set(brokerNames)); setMobileSortOpen(false) }} style={{
                    padding: '9px 14px', borderRadius: '7px', border: 'none',
                    background: sortCol === opt.col ? 'var(--accent-glow)' : 'transparent',
                    color: sortCol === opt.col ? 'var(--accent)' : 'var(--text-2)',
                    fontSize: '13px', fontWeight: sortCol === opt.col ? 600 : 400,
                    cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '10px',
                  }}>
                    <span style={{ fontSize: '11px', opacity: 0.6, minWidth: '16px' }}>{opt.icon}</span>
                    {opt.label}
                    {sortCol === opt.col && <span style={{ marginLeft: 'auto' }}>{sortAsc ? '↑' : '↓'}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Summary cards + Broker donut tile ── */}
      {summary?.by_currency?.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
          {(currency === 'All' ? summary.by_currency : summary.by_currency.filter(c => c.currency === currency))
            .map(c => {
              const isGain = (c.gain_loss_usd || 0) >= 0
              const fx     = summary.fx_rates?.[c.currency]
              const isINR  = c.currency === 'INR', isAED = c.currency === 'AED'
              const primary = isINR ? `₹${(c.market_value_local||0).toLocaleString('en-IN',{maximumFractionDigits:0})}`
                            : isAED ? `AED ${(c.market_value_local||0).toLocaleString('en-US',{maximumFractionDigits:0})}`
                            : fmtUSD(c.market_value_usd)
              const gainColor = isGain ? 'rgba(52,211,153,0.6)' : 'rgba(251,113,133,0.6)'
              return (
                <div key={c.currency} style={{ ...card, borderLeft: `3px solid ${gainColor}` }}>
                  <div style={{ color: 'var(--text-4)', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
                    {c.currency} Portfolio
                  </div>
                  <div style={{ color: 'var(--text-1)', fontSize: '20px', fontWeight: 700 }}>{mask(primary)}</div>
                  {(!isINR && !isAED) || !showUsdSub ? null : (
                    <div style={{ color: 'var(--text-4)', fontSize: '12px' }}>≈ {mask(fmtUSD(c.market_value_usd))}</div>
                  )}
                  {fx && <div style={{ color: 'var(--text-4)', fontSize: '11px' }}>1 USD = {isINR?'₹':isAED?'AED ':''}{fx}</div>}
                  <div style={{ color: isGain ? 'var(--green)' : 'var(--red)', fontSize: '13px', marginTop: '4px', fontWeight: 600 }}>
                    {isGain?'▲':'▼'} {isGain?'+':''}{mask(`${(c.gain_loss_usd||0).toFixed(2)} (${(c.gain_loss_pct||0).toFixed(1)}%)`)}
                  </div>
                  <div style={{ color: 'var(--text-4)', fontSize: '11px' }}>{c.count} holdings</div>
                </div>
              )
            })}
          {/* Broker donut tile — 4th card in the grid */}
          {!loading && byBroker.length > 1 && (
            <BrokerDonutCard brokers={byBroker} totalUSD={totalUSD} mask={mask} />
          )}
        </div>
      )}

      {loading && <p style={{ color: 'var(--text-3)' }}>Loading holdings...</p>}
      {error   && <p style={{ color: 'var(--red)', background: '#450a0a', padding: '12px', borderRadius: '8px' }}>{error}</p>}

      {/* ── Broker groups (collapsible) ── */}
      {!loading && !error && Object.entries(grouped).map(([broker, items]) => {
        const isOpen      = expandedBrokers.has(broker)
        const brokerCcy   = items[0]?.currency || 'USD'
        const isUSD       = brokerCcy === 'USD'
        const totalMV_USD = items.reduce((s,h) => s+(h.market_value_usd||0),0)
        const totalMV_loc = items.reduce((s,h) => s+(h.market_value_local||0),0)
        const totalGL_USD = items.reduce((s,h) => s+(h.gain_loss_usd||0),0)
        const totalGL_loc = items.reduce((s,h) => s+(h.gain_loss_local||0),0)
        const dailyUSD    = items.reduce((s,h) => s+(h.daily_change_usd||0),0)
        const dailyLoc    = items.reduce((s,h) => s+(h.daily_change_local||0),0)
        const dailyDisplay = isUSD ? fmtUSD(dailyUSD) : fmtLocal(dailyLoc, brokerCcy)
        const glDisplay    = isUSD ? fmtUSD(totalGL_USD) : fmtLocal(totalGL_loc, brokerCcy)
        const glVal        = isUSD ? totalGL_USD : totalGL_loc

        const sortedItems = [...items].sort((a, b) => {
          const av = a[sortCol], bv = b[sortCol]
          if (av == null && bv == null) return 0
          if (av == null) return 1
          if (bv == null) return -1
          if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av)
          return sortAsc ? av - bv : bv - av
        })

        const SortTh = ({ col, label, right }) => {
          const active = sortCol === col
          return (
            <th onClick={() => handleSort(col)} style={{
              padding: '8px 12px', textAlign: right ? 'right' : 'left', fontSize: '11px',
              color: active ? 'var(--accent)' : 'var(--text-3)',
              fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
              whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none',
            }}>
              {label}{active ? (sortAsc ? ' ↑' : ' ↓') : ''}
            </th>
          )
        }

        return (
          <div key={broker} style={{ borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--border)' }}>

            {/* ── Clickable broker header (collapses/expands group) ── */}
            <div
              onClick={() => toggleBroker(broker)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 18px', background: 'var(--bg-elevated)', cursor: 'pointer',
                userSelect: 'none', transition: 'background 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.background='var(--bg-base)'}
              onMouseLeave={e => e.currentTarget.style.background='var(--bg-elevated)'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ color: 'var(--text-3)', fontSize: '16px', transition: 'transform 0.2s',
                  transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }}>▶</span>
                <div>
                  <span style={{ fontWeight: 600, color: 'var(--text-1)', fontSize: '14px' }}>{broker}</span>
                  <span style={{ marginLeft: '8px', fontSize: '12px', color: 'var(--text-4)' }}>{items.length} holding{items.length!==1?'s':''}</span>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700, color: 'var(--text-1)', fontSize: '15px' }}>
                  {mask(isUSD ? fmtUSD(totalMV_USD) : fmtLocal(totalMV_loc, brokerCcy))}
                </div>
                <div style={{ fontSize: '12px', fontWeight: 500, display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <span style={{ color: glVal>=0 ? 'var(--green)' : 'var(--red)' }}>
                    P&L: {glVal>=0?'+':''}{mask(glDisplay)}
                  </span>
                  <span style={{ color: 'var(--text-4)' }}>·</span>
                  <span style={{ color: (isUSD?dailyUSD:dailyLoc)>=0 ? 'var(--green)' : 'var(--red)' }}>
                    Today: {(isUSD?dailyUSD:dailyLoc)>=0?'+':''}{mask(dailyDisplay)}
                  </span>
                </div>
              </div>
            </div>

            {/* ── Table (only shown when group is open) ── */}
            {isOpen && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--bg-surface)', fontSize: '13px', minWidth: isMobile ? '320px' : '900px' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-elevated)', borderBottom: '2px solid var(--accent)' }}>
                      <SortTh col="ticker"              label="Holding" />
                      {!isMobile && <SortTh col="quantity"          label="Qty" right />}
                      {!isMobile && <SortTh col="avg_buy_price"     label="Avg Buy" right />}
                      {!isMobile && <SortTh col="current_price_local" label="Current" right />}
                      {!isMobile && <SortTh col="cost_basis_usd" label="Bought" right />}
                      <SortTh col="market_value_usd"  label="Value" right />
                      <SortTh col="gain_loss_usd"     label="P&L" right />
                      {!isMobile && <SortTh col="daily_change_usd"  label="Today" right />}
                      <th style={{ width: '32px' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedItems.map(h => {
                      const isOpen_r = expandedRows.has(h.id)
                      const isUSDh   = h.currency === 'USD'
                      const ogain    = h.gain_loss_usd || 0
                      const ogainPct = h.gain_loss_pct || 0
                      const daily    = h.daily_change_usd
                      const dailyPct = h.daily_change_pct
                      const fxSplit  = calcFxGain(h)
                      const ticker   = h.ticker.replace('.NS','').replace('.BO','').replace('.AE','')

                      return (
                        <React.Fragment key={h.id}>
                          {/* ── Collapsed summary row ── */}
                          <tr
                            onClick={() => toggleRow(h.id)}
                            style={{ borderTop: '1px solid var(--border-soft)', cursor: 'pointer',
                              background: isOpen_r ? 'var(--bg-elevated)' : 'transparent',
                              transition: 'background 0.1s' }}
                            onMouseEnter={e => { if(!isOpen_r) e.currentTarget.style.background='var(--bg-elevated)' }}
                            onMouseLeave={e => { if(!isOpen_r) e.currentTarget.style.background='transparent' }}
                          >
                            {/* Holding: ticker + qty×avg→current */}
                            <td style={{ padding: '10px 12px', color: 'var(--text-2)', verticalAlign: 'middle' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <span style={{ fontWeight: 700, color: 'var(--text-1)', fontSize: '13px' }}>{ticker}</span>
                                <a
                                  href={h.currency === 'INR'
                                    ? `https://www.screener.in/company/${ticker}/`
                                    : h.currency === 'AED'
                                      ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(h.ticker)}`
                                      : `https://finance.yahoo.com/quote/${h.ticker}/`}
                                  target="_blank" rel="noreferrer"
                                  onClick={e => e.stopPropagation()}
                                  style={{ fontSize: '10px', color: 'var(--accent)', opacity: 0.7, lineHeight: 1, textDecoration: 'none' }}
                                >↗</a>
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--text-4)', marginTop: '2px' }}>
                                {h.quantity} × {fmtLocal(h.avg_buy_price, h.currency)} → {mask(fmtLocal(h.current_price_local, h.currency))}
                              </div>
                            </td>

                            {/* Qty */}
                            {!isMobile && (
                              <td style={{ padding: '10px 12px', textAlign: 'right', verticalAlign: 'middle', color: 'var(--text-2)', fontSize: '13px' }}>
                                {h.quantity}
                              </td>
                            )}

                            {/* Avg Buy */}
                            {!isMobile && (
                              <td style={{ padding: '10px 12px', textAlign: 'right', verticalAlign: 'middle', color: 'var(--text-2)', fontSize: '13px' }}>
                                {mask(fmtLocal(h.avg_buy_price, h.currency))}
                              </td>
                            )}

                            {/* Current Price */}
                            {!isMobile && (
                              <td style={{ padding: '10px 12px', textAlign: 'right', verticalAlign: 'middle', color: 'var(--text-1)', fontWeight: 600, fontSize: '13px' }}>
                                {mask(fmtLocal(h.current_price_local, h.currency))}
                              </td>
                            )}

                            {/* Bought (cost basis) */}
                            {!isMobile && (
                              <td style={{ padding: '10px 12px', textAlign: 'right', verticalAlign: 'middle', color: 'var(--text-3)', fontSize: '13px' }}>
                                {mask(fmtLocal(h.quantity * h.avg_buy_price, h.currency))}
                              </td>
                            )}

                            {/* Market value */}
                            <td style={{ padding: '10px 12px', textAlign: 'right', verticalAlign: 'middle' }}>
                              <div style={{ fontWeight: 600, color: 'var(--text-1)', fontSize: '13px' }}>
                                {mask(isUSDh ? fmtUSD(h.market_value_usd) : fmtLocal(h.market_value_local, h.currency))}
                              </div>
                              {/* Today's change — shown on mobile only */}
                              {isMobile && (() => {
                                const dLocal = h.daily_change_local
                                const dUSD   = h.daily_change_usd
                                const dVal   = isUSDh ? dUSD : (dLocal ?? dUSD)
                                if (dVal == null) return null
                                const dAbs   = isUSDh ? fmtUSD(Math.abs(dUSD)) : fmtLocal(Math.abs(dLocal ?? dUSD), h.currency)
                                const dPct   = dailyPct
                                return (
                                  <div style={{ fontSize: '10px', fontWeight: 600, marginTop: '2px',
                                    color: dVal >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                    {dVal >= 0 ? '▲' : '▼'} {mask(dAbs)}
                                    {dPct != null && <span style={{ opacity: 0.75 }}> ({Math.abs(dPct).toFixed(1)}%)</span>}
                                  </div>
                                )
                              })()}
                            </td>

                            {/* Overall P&L */}
                            <td style={{ padding: '10px 12px', textAlign: 'right', verticalAlign: 'middle',
                              color: ogain>=0 ? 'var(--green)' : 'var(--red)' }}>
                              <div style={{ fontWeight: 600, fontSize: '13px' }}>
                                {ogain>=0?'+':''}{mask(isUSDh ? fmtUSD(ogain) : fmtLocal(h.gain_loss_local, h.currency))}
                              </div>
                              <div style={{ fontSize: '10px', opacity: 0.8 }}>({ogainPct.toFixed(1)}%)</div>
                            </td>

                            {/* Daily P&L — hidden on mobile */}
                            {!isMobile && (
                              <td style={{ padding: '10px 12px', textAlign: 'right', verticalAlign: 'middle',
                                color: (daily||0)>=0 ? 'var(--green)' : 'var(--red)' }}>
                                {daily != null
                                  ? <>
                                      <div style={{ fontWeight: 600, fontSize: '13px' }}>
                                        {daily>=0?'+':''}{mask(isUSDh ? fmtUSD(daily) : fmtLocal(h.daily_change_local, h.currency))}
                                      </div>
                                      <div style={{ fontSize: '10px', opacity: 0.8 }}>({(dailyPct||0).toFixed(2)}%)</div>
                                    </>
                                  : <span style={{ color: 'var(--text-4)' }}>—</span>}
                              </td>
                            )}

                            {/* Expand chevron */}
                            <td style={{ padding: '10px 8px', textAlign: 'center', verticalAlign: 'middle' }}>
                              <span style={{ color: 'var(--text-4)', fontSize: '12px', transition: 'transform 0.2s',
                                display: 'inline-block', transform: isOpen_r ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                            </td>
                          </tr>

                          {/* ── Expanded detail row (actions + extras) ── */}
                          {isOpen_r && (
                            <tr key={`${h.id}-detail`}>
                              <td colSpan={isMobile ? 5 : 9} style={{ padding: 0 }}>
                                <div style={{ background: 'var(--bg-base)', borderBottom: '1px solid var(--border-soft)',
                                  padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>

                                  {/* Mobile-only: cost basis */}
                                  {isMobile && (
                                    <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                                      <div style={detailItem}>
                                        <div style={detailLabel}>Bought</div>
                                        <div style={detailVal}>{mask(fmtLocal(h.quantity * h.avg_buy_price, h.currency))}</div>
                                      </div>
                                    </div>
                                  )}

                                  {/* FX split + notes */}
                                  {((fxSplit && localStorage.getItem('showFxSplit') !== 'false') || h.notes) && (
                                    <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                                      {fxSplit && localStorage.getItem('showFxSplit') !== 'false' && (
                                        <div style={detailItem}>
                                          <div style={detailLabel}>FX Split (USD)</div>
                                          <div style={{ fontSize: '12px' }}>
                                            <span style={{ color: fxSplit.stock>=0?'var(--green)':'var(--red)' }}>
                                              Stock {fxSplit.stock>=0?'+':''}{fxSplit.stock.toFixed(0)}
                                            </span>
                                            <span style={{ color: 'var(--text-4)', margin: '0 4px' }}>·</span>
                                            <span style={{ color: fxSplit.fx>=0?'var(--green)':'var(--red)' }}>
                                              FX {fxSplit.fx>=0?'+':''}{fxSplit.fx.toFixed(0)}
                                            </span>
                                          </div>
                                        </div>
                                      )}
                                      {h.notes && (
                                        <div style={{ ...detailItem, flex: '1 1 200px' }}>
                                          <div style={detailLabel}>Notes</div>
                                          <div style={{ fontSize: '12px', color: 'var(--text-3)', fontStyle: 'italic' }}>{h.notes}</div>
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {/* Action buttons */}
                                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}
                                    onClick={e => e.stopPropagation()}>
                                    <button style={logBtn} onClick={() => {
                                      const today = new Date().toISOString().slice(0,10)
                                      setQtForm({ type:'buy', quantity: '', price: h.current_price_local ?? '', trade_date: today, notes:'' })
                                      setQtErr('')
                                      setQuickTrade(h)
                                    }}>📝 Log Trade</button>
                                    <button style={editBtn} onClick={() => { setEditHolding(h); setShowModal(true) }}>✏ Edit</button>
                                    <button style={delBtn}  onClick={async () => {
                                      if (!confirm('Delete this holding?')) return
                                      // Optimistic: remove instantly from UI
                                      setHoldings(prev => prev.filter(x => x.id !== h.id))
                                      setExpandedRows(prev => { const n = new Set(prev); n.delete(h.id); return n })
                                      try { await deleteHolding(h.id); silentReload() }
                                      catch { loadHoldings() } // revert on error
                                    }}>🗑 Delete</button>
                                    <button style={{ ...editBtn, color:'var(--accent)', borderColor:'rgba(99,102,241,0.3)' }}
                                      onClick={() => openMarket(h.ticker)}>↗ Chart</button>
                                  </div>

                                  {/* ── Inline transactions ── */}
                                  {(() => {
                                    const htxns = (txnsByTicker[h.ticker] || []).sort((a,b) => new Date(b.trade_date) - new Date(a.trade_date))
                                    const showTxns = expandedTxns.has(h.id)
                                    if (htxns.length === 0) return null
                                    return (
                                      <div onClick={e => e.stopPropagation()}>
                                        <button
                                          onClick={() => toggleTxns(h.id)}
                                          style={{ background:'none', border:'none', cursor:'pointer', padding:'2px 0',
                                            color:'var(--text-3)', fontSize:'12px', fontWeight:600,
                                            display:'flex', alignItems:'center', gap:'4px' }}>
                                          <span style={{ transition:'transform 0.2s', display:'inline-block',
                                            transform: showTxns ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                                          Transactions ({htxns.length})
                                        </button>
                                        {showTxns && (
                                          <div style={{ marginTop:'8px', borderRadius:'8px', overflow:'hidden',
                                            border:'1px solid var(--border-soft)' }}>
                                            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'12px' }}>
                                              <thead>
                                                <tr style={{ background:'var(--bg-elevated)' }}>
                                                  <th style={txnTh}>Date</th>
                                                  <th style={txnTh}>Type</th>
                                                  <th style={{ ...txnTh, textAlign:'right' }}>Qty</th>
                                                  <th style={{ ...txnTh, textAlign:'right' }}>Price</th>
                                                  <th style={{ ...txnTh, textAlign:'right' }}>Value</th>
                                                  {!isMobile && <th style={txnTh}>Notes</th>}
                                                  <th style={{ width:'28px' }}></th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {htxns.map(t => {
                                                  const typeColor = t.type==='buy' ? '#4ade80' : t.type==='sell' ? '#f87171' : '#60a5fa'
                                                  return (
                                                    <tr key={t.id} style={{ borderTop:'1px solid var(--border-soft)' }}>
                                                      <td style={txnTd}>{t.trade_date}</td>
                                                      <td style={txnTd}>
                                                        <span style={{ color:typeColor, fontWeight:700, textTransform:'uppercase', fontSize:'10px',
                                                          background:`${typeColor}18`, padding:'2px 6px', borderRadius:'4px' }}>
                                                          {t.type}
                                                        </span>
                                                      </td>
                                                      <td style={{ ...txnTd, textAlign:'right' }}>{t.quantity}</td>
                                                      <td style={{ ...txnTd, textAlign:'right' }}>{fmtLocal(t.price, h.currency)}</td>
                                                      <td style={{ ...txnTd, textAlign:'right', fontWeight:600 }}>
                                                        {fmtLocal(t.quantity * t.price, h.currency)}
                                                      </td>
                                                      {!isMobile && <td style={{ ...txnTd, color:'var(--text-4)', fontStyle:'italic', maxWidth:'120px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.notes || '—'}</td>}
                                                      <td style={{ padding:'6px 8px', textAlign:'center' }}>
                                                        <button
                                                          onClick={async () => {
                                                            if (!confirm('Delete this transaction?')) return
                                                            try {
                                                              await deleteTransaction(t.id)
                                                              setTransactions(prev => prev.filter(x => x.id !== t.id))
                                                              silentReload()
                                                            } catch { alert('Delete failed') }
                                                          }}
                                                          style={{ background:'none', border:'none', cursor:'pointer', color:'var(--red)', fontSize:'12px', padding:'2px 4px' }}>
                                                          ✕
                                                        </button>
                                                      </td>
                                                    </tr>
                                                  )
                                                })}
                                              </tbody>
                                            </table>
                                          </div>
                                        )}
                                      </div>
                                    )
                                  })()}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-4)' }}>
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>📭</div>
          <div style={{ marginBottom: '16px' }}>No holdings yet.</div>
          <button style={btn1} onClick={() => setShowModal(true)}>+ Add your first holding</button>
        </div>
      )}

      {/* Modals */}
      {showModal       && <HoldingModal   holding={editHolding} onClose={handleModalClose} />}
      {showBrokerModal && <BrokerModal    onClose={() => { setShowBrokerModal(false); loadHoldings() }} />}
      {showCSVModal    && <CSVImportModal onClose={() => { setShowCSVModal(false);    loadHoldings() }} />}

      {/* Quick-trade modal */}
      {quickTrade && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:'16px' }}>
          <div style={{ background:'var(--bg-elevated)', borderRadius:'14px', padding:'26px', width:'100%', maxWidth:'400px', border:'1px solid var(--border)', boxShadow:'0 20px 60px rgba(0,0,0,0.4)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'18px' }}>
              <div>
                <div style={{ fontWeight:700, fontSize:'15px', color:'var(--text-1)' }}>Log Trade — {quickTrade.ticker}</div>
                <div style={{ fontSize:'12px', color:'var(--text-3)', marginTop:'2px' }}>{quickTrade.name} · {quickTrade.currency}</div>
              </div>
              <button onClick={() => setQuickTrade(null)} style={{ background:'none', border:'none', color:'var(--text-3)', fontSize:'20px', cursor:'pointer' }}>×</button>
            </div>
            {/* Type */}
            <div style={{ display:'flex', gap:'8px', marginBottom:'14px' }}>
              {['buy','sell','dividend'].map(t => (
                <button key={t} onClick={() => setQtForm(f => ({...f, type:t}))} style={{
                  flex:1, padding:'7px', borderRadius:'7px', fontSize:'12px', fontWeight: qtForm.type===t ? 700 : 400,
                  cursor:'pointer', border:'1px solid',
                  borderColor: qtForm.type===t ? (t==='buy'?'#4ade80':t==='sell'?'#f87171':'#60a5fa') : 'var(--border)',
                  background: qtForm.type===t ? (t==='buy'?'#4ade8020':t==='sell'?'#f8717120':'#60a5fa20') : 'transparent',
                  color: qtForm.type===t ? (t==='buy'?'#4ade80':t==='sell'?'#f87171':'#60a5fa') : 'var(--text-3)',
                  textTransform:'uppercase', letterSpacing:'0.04em',
                }}>{t}</button>
              ))}
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px', marginBottom:'12px' }}>
              <div>
                <div style={qtLabel}>Quantity</div>
                <input style={qtInput} type="number" min="0" value={qtForm.quantity} placeholder="100"
                  onChange={e => setQtForm(f => ({...f, quantity:e.target.value}))} />
              </div>
              <div>
                <div style={qtLabel}>Price ({quickTrade.currency})</div>
                <input style={qtInput} type="number" min="0" step="0.01" value={qtForm.price}
                  onChange={e => setQtForm(f => ({...f, price:e.target.value}))} />
              </div>
              <div>
                <div style={qtLabel}>Date</div>
                <input style={qtInput} type="date" value={qtForm.trade_date}
                  onChange={e => setQtForm(f => ({...f, trade_date:e.target.value}))} />
              </div>
              <div>
                <div style={qtLabel}>Notes</div>
                <input style={qtInput} value={qtForm.notes||''} placeholder="Optional"
                  onChange={e => setQtForm(f => ({...f, notes:e.target.value}))} />
              </div>
            </div>
            {qtErr && <div style={{ color:'#f87171', fontSize:'12px', marginBottom:'10px' }}>{qtErr}</div>}
            <div style={{ display:'flex', gap:'10px', justifyContent:'flex-end' }}>
              <button onClick={() => setQuickTrade(null)} style={{ padding:'8px 18px', borderRadius:'8px', border:'1px solid var(--border)', background:'transparent', color:'var(--text-2)', cursor:'pointer', fontSize:'13px' }}>Cancel</button>
              <button onClick={saveQuickTrade} disabled={qtSaving} style={{ padding:'8px 18px', borderRadius:'8px', border:'none', background:'var(--accent)', color:'#fff', cursor:'pointer', fontSize:'13px', fontWeight:600, opacity:qtSaving?.7:1 }}>
                {qtSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatTS(ts) {
  if (!ts) return ''
  return new Date(ts.replace(' ','T')+'Z').toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false})
}

const card    = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)', borderRadius: '12px', padding: '16px 18px', boxShadow: 'var(--shadow)' }
const td      = { padding: '11px 14px', color: 'var(--text-2)', verticalAlign: 'middle' }
const btn1    = { padding: '9px 18px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }
const btn2    = { padding: '9px 16px', background: 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }
const editBtn = { padding: '4px 10px', background: 'transparent', color: 'var(--accent)', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }
const delBtn  = { padding: '4px 8px',  background: 'transparent', color: 'var(--red)',    border: '1px solid var(--border)', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }
const logBtn  = { padding: '4px 10px', background: 'transparent', color: '#a78bfa',       border: '1px solid rgba(167,139,250,0.3)', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }
const qtLabel    = { fontSize:'11px', color:'var(--text-3)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:'4px' }
const qtInput    = { width:'100%', padding:'7px 9px', borderRadius:'6px', fontSize:'13px', border:'1px solid var(--border)', background:'var(--bg-base)', color:'var(--text-1)', outline:'none', boxSizing:'border-box' }
const detailItem = { display:'flex', flexDirection:'column', gap:'2px', minWidth:'80px' }
const detailLabel= { fontSize:'10px', color:'var(--text-4)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em' }
const detailVal  = { fontSize:'13px', color:'var(--text-1)', fontWeight:600 }
const txnTh      = { padding:'6px 10px', textAlign:'left', fontSize:'10px', color:'var(--text-4)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em', whiteSpace:'nowrap' }
const txnTd      = { padding:'7px 10px', color:'var(--text-2)', fontSize:'12px', verticalAlign:'middle' }

// ── Broker donut tile ────────────────────────────────────────────────────────
const BROKER_COLORS = ['#3b82f6','#f59e0b','#10b981','#8b5cf6','#ef4444','#06b6d4','#ec4899']

function MiniDonut({ brokers, size = 80 }) {
  const total = brokers.reduce((s, b) => s + b.value, 0)
  if (total <= 0) return null
  const r  = 28
  const cx = size / 2
  const cy = size / 2
  const sw = 13
  const circ = 2 * Math.PI * r
  let cum = 0
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      {brokers.map((b, i) => {
        const pct    = b.value / total
        const segLen = pct * circ
        const offset = -(cum * circ) + circ * 0.25  // start from top
        cum += pct
        return (
          <circle key={b.name}
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke={BROKER_COLORS[i % BROKER_COLORS.length]}
            strokeWidth={sw}
            strokeDasharray={`${segLen - 1.5} ${circ - segLen + 1.5}`}
            strokeDashoffset={offset}
          />
        )
      })}
      {/* Centre label: number of brokers */}
      <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle"
        fill="var(--text-3)" fontSize="11" fontWeight="700">
        {brokers.length}
      </text>
      <text x={cx} y={cy + 13} textAnchor="middle" dominantBaseline="middle"
        fill="var(--text-4)" fontSize="8">
        brokers
      </text>
    </svg>
  )
}

function BrokerDonutCard({ brokers, totalUSD, mask }) {
  if (!brokers.length || totalUSD <= 0) return null
  const top = brokers.slice(0, 6)
  return (
    <div style={{ ...card, borderLeft: '3px solid #64748b', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ color: 'var(--text-4)', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        By Broker
      </div>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <MiniDonut brokers={top} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1, minWidth: 0 }}>
          {top.map((b, i) => {
            const pct = ((b.value / totalUSD) * 100).toFixed(0)
            const dispVal = b.currency === 'USD' || !b.localValue
              ? `$${b.value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
              : b.currency === 'INR'
                ? `₹${b.localValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
                : `AED ${b.localValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
            return (
              <div key={b.name} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', minWidth: 0 }}>
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: BROKER_COLORS[i % BROKER_COLORS.length], flexShrink: 0 }} />
                <span style={{ color: 'var(--text-2)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {b.name.length > 9 ? b.name.slice(0, 8) + '…' : b.name}
                </span>
                <span style={{ color: 'var(--text-3)', fontWeight: 700, flexShrink: 0 }}>{pct}%</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
