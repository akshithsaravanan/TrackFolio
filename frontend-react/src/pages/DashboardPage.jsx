import { useState, useEffect } from 'react'
import { getHoldings } from '../api/client'
import PortfolioChart from '../components/dashboard/PortfolioChart'
import { useHideValues } from '../context/HideValuesContext'

const CCY_COLORS = { USD: '#3b82f6', INR: '#f59e0b', AED: '#10b981' }

// Format a value in its native currency
function fmtNative(value, currency) {
  if (value == null) return '—'
  if (currency === 'INR') return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
  if (currency === 'AED') return `AED ${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function fmtUSD(v) {
  if (v == null) return '—'
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default function DashboardPage() {
  const { mask } = useHideValues()
  const [summary,   setSummary]   = useState(null)
  const [holdings,  setHoldings]  = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [ccyTab,    setCcyTab]    = useState('All')  // All | INR | USD | AED
  const [moversBy,  setMoversBy]  = useState('pct')  // 'pct' | 'value'
  const [isMobile,  setIsMobile]  = useState(() => window.innerWidth < 768)

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  function loadData() {
    return getHoldings()
      .then(data => {
        const h = data.holdings || []
        setSummary(data.summary || null)
        setHoldings(h)
        // Auto-select native currency if portfolio has only one currency
        const currencies = [...new Set(h.map(x => x.currency))]
        if (currencies.length === 1) setCcyTab(currencies[0])
      })
      .catch(() => setError('Could not connect to backend.'))
  }

  useEffect(() => {
    loadData().finally(() => setLoading(false))

    // Auto-refresh every 5 minutes when tab is visible
    const autoRefresh = localStorage.getItem('autoRefresh') !== 'false'
    if (!autoRefresh) return
    const interval = setInterval(() => {
      if (!document.hidden) loadData()
    }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  if (loading) return <p style={{ color: 'var(--text-2)' }}>Loading...</p>
  if (error)   return <p style={{ color: '#f87171' }}>{error}</p>
  if (!summary) return null

  // Available currencies in this portfolio
  const allCurrencies = [...new Set(holdings.map(h => h.currency))].sort()

  // Filter holdings by tab
  const filteredHoldings = ccyTab === 'All'
    ? holdings
    : holdings.filter(h => h.currency === ccyTab)

  // ── Summary numbers (per selected tab) ──────────────────
  const byCcyData = (summary.by_currency || [])
  const activeCcyRows = ccyTab === 'All' ? byCcyData : byCcyData.filter(c => c.currency === ccyTab)

  // Total value for the tab — in USD for "All", native for single currency
  const totalValueUSD    = activeCcyRows.reduce((s, c) => s + (c.market_value_usd || 0), 0)
  const totalGainUSD     = activeCcyRows.reduce((s, c) => s + (c.gain_loss_usd   || 0), 0)
  const totalInvestedUSD = totalValueUSD - totalGainUSD
  const totalGainPct     = totalInvestedUSD > 0 ? ((totalGainUSD / totalInvestedUSD) * 100) : 0
  const totalDailyUSD    = filteredHoldings.reduce((s, h) => s + (h.daily_change_usd || 0), 0)
  const count            = filteredHoldings.length

  // For single-currency tab: show native values
  const singleCcy = ccyTab !== 'All' ? ccyTab : null
  const ccyRow    = singleCcy ? byCcyData.find(c => c.currency === singleCcy) : null

  // Invested = sum of (qty × avg_buy_price) per holding — always in native currency
  const investedLocal = filteredHoldings.reduce(
    (s, h) => s + ((h.quantity || 0) * (h.avg_buy_price || 0)), 0)
  const investedUSD = filteredHoldings.reduce(
    (s, h) => s + (h.cost_basis_usd || 0), 0)

  const ccyValueLocal = ccyRow
    ? (ccyRow.market_value_local ?? ccyRow.market_value_usd ?? 0)
    : 0
  const ccyGainLocal = singleCcy
    ? ccyValueLocal - investedLocal
    : totalGainUSD

  const totalValueDisplay = singleCcy
    ? fmtNative(ccyValueLocal, singleCcy)
    : fmtUSD(totalValueUSD)
  const investedDisplay = singleCcy
    ? fmtNative(investedLocal, singleCcy)
    : fmtUSD(investedUSD)
  const totalGainDisplay = singleCcy
    ? `${ccyGainLocal >= 0 ? '+' : ''}${fmtNative(ccyGainLocal, singleCcy)}`
    : `${totalGainUSD >= 0 ? '+' : ''}${fmtUSD(totalGainUSD)}`
  // daily_change_local for INR/AED, fall back to daily_change_usd for USD
  const totalDailyLocal = filteredHoldings.reduce(
    (s, h) => s + (h.daily_change_local ?? h.daily_change_usd ?? 0), 0)
  const totalDailyDisplay = singleCcy
    ? `${totalDailyLocal >= 0 ? '+' : ''}${fmtNative(totalDailyLocal, singleCcy)}`
    : `${totalDailyUSD >= 0 ? '+' : ''}${fmtUSD(totalDailyUSD)}`

  // ── Top movers — split gainers / losers ──────────────────
  const _moverPool = [...filteredHoldings].filter(h =>
    moversBy === 'pct' ? h.daily_change_pct != null : h.daily_change_usd != null
  )
  const gainers = _moverPool
    .filter(h => (moversBy === 'pct' ? h.daily_change_pct : h.daily_change_usd) > 0)
    .sort((a, b) => moversBy === 'pct'
      ? (b.daily_change_pct || 0) - (a.daily_change_pct || 0)
      : (b.daily_change_usd || 0) - (a.daily_change_usd || 0))
    .slice(0, 4)
  const losers = _moverPool
    .filter(h => (moversBy === 'pct' ? h.daily_change_pct : h.daily_change_usd) < 0)
    .sort((a, b) => moversBy === 'pct'
      ? (a.daily_change_pct || 0) - (b.daily_change_pct || 0)
      : (a.daily_change_usd || 0) - (b.daily_change_usd || 0))
    .slice(0, 4)
  const movers = [...gainers, ...losers]

  return (
    <div style={{ color: 'var(--text-1)' }}>

      {/* ── Currency tabs ──────────────────────────────────── */}
      {allCurrencies.length > 1 && (
        <div style={{ display: 'flex', gap: '6px', marginBottom: '20px', flexWrap: 'wrap' }}>
          {['All', ...allCurrencies].map(c => {
            const active = ccyTab === c
            const color  = CCY_COLORS[c] || 'var(--accent)'
            return (
              <button key={c} onClick={() => setCcyTab(c)} style={{
                padding: '6px 16px', borderRadius: '20px', fontSize: '13px',
                fontWeight: active ? 700 : 500, cursor: 'pointer',
                border: active ? `1px solid ${color}` : '1px solid var(--border)',
                background: active ? `${color}20` : 'transparent',
                color: active ? color : 'var(--text-3)',
                transition: 'all 0.15s',
              }}>{c}</button>
            )
          })}
        </div>
      )}

      {/* ── Summary cards ─────────────────────────────────── */}
      <div data-tour="summary-cards" style={styles.cards}>
        {/* Hero card — full width on mobile */}
        <div style={styles.heroCard}>
          <div style={styles.cardLabel}>{ccyTab === 'All' ? 'Portfolio Value' : `${ccyTab} Portfolio`}</div>
          <div className="card-value" style={{ fontSize: '30px', fontWeight: 800, color: 'var(--text-1)', letterSpacing: '-1px', margin: '4px 0' }}>
            {mask(totalValueDisplay)}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '6px' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              padding: '3px 10px', borderRadius: '20px',
              background: totalDailyUSD >= 0 ? 'rgba(52,211,153,0.12)' : 'rgba(251,113,133,0.12)',
              border: `1px solid ${totalDailyUSD >= 0 ? 'rgba(52,211,153,0.25)' : 'rgba(251,113,133,0.25)'}`,
              color: totalDailyUSD >= 0 ? 'var(--green)' : 'var(--red)',
              fontSize: '12px', fontWeight: 700,
            }}>
              {totalDailyUSD >= 0 ? '▲' : '▼'} {mask(totalDailyDisplay)} today
            </span>
          </div>
          {singleCcy && ccyRow && (
            <div style={{ ...styles.cardSub, marginTop: '6px' }}>{mask(`≈ ${fmtUSD(ccyRow.market_value_usd)}`)}</div>
          )}
          {!singleCcy && (
            <div style={styles.cardSub}>{count} holdings</div>
          )}
        </div>

        {/* 2×2 grid on mobile, individual cards on desktop */}
        <div style={styles.subCards}>
          <SummaryCard label="Invested"      value={mask(investedDisplay)}   sub="cost basis"   color="var(--text-2)" />
          <SummaryCard label="Overall Return" value={mask(totalGainDisplay)}  sub={`${totalGainUSD >= 0 ? '+' : ''}${totalGainPct.toFixed(2)}% since purchase`} color={totalGainUSD >= 0 ? 'var(--green)' : 'var(--red)'} />
          <SummaryCard label="Today's P&L"   value={mask(totalDailyDisplay)} sub={singleCcy && summary.fx_rates?.[singleCcy] ? `1 USD = ${singleCcy === 'INR' ? '₹' : 'AED '}${summary.fx_rates[singleCcy]}` : 'vs yesterday'} color={totalDailyUSD >= 0 ? 'var(--green)' : 'var(--red)'} />
          <SummaryCard label="Holdings"      value={String(count)}           sub={`${allCurrencies.join(' · ')}`} color="var(--accent)" />
        </div>
      </div>


      {/* ── Top movers — gainers / losers split ──────────── */}
      {movers.length > 0 && (
        <div style={styles.moversBox}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'16px' }}>
            <h3 style={{ ...styles.chartTitle, marginBottom:0 }}>Top Movers Today</h3>
            <div style={{ display:'flex', gap:'3px', background:'var(--bg-base)', borderRadius:'6px', padding:'2px' }}>
              {[['pct','%'],['value','$']].map(([key, label]) => (
                <button key={key} onClick={() => setMoversBy(key)} style={{
                  padding:'3px 10px', borderRadius:'5px', fontSize:'11px', fontWeight:600,
                  cursor:'pointer', border:'none',
                  background: moversBy === key ? 'var(--bg-elevated)' : 'transparent',
                  color: moversBy === key ? 'var(--text-1)' : 'var(--text-4)',
                  transition:'all 0.15s',
                }}>{label}</button>
              ))}
            </div>
          </div>

          <div className="movers-split" style={{ display:'grid', gap:'16px', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
            {/* Gainers */}
            <div>
              <div style={{ fontSize:'11px', fontWeight:700, color:'#4ade80', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:'8px', display:'flex', alignItems:'center', gap:'5px' }}>
                ▲ Gainers
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:'6px' }}>
                {gainers.length === 0
                  ? <div style={{ color:'var(--text-4)', fontSize:'12px', padding:'12px 0' }}>No gainers today</div>
                  : gainers.map(h => <MoverRow key={h.id} h={h} moversBy={moversBy} />)
                }
              </div>
            </div>
            {/* Losers */}
            <div>
              <div style={{ fontSize:'11px', fontWeight:700, color:'#f87171', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:'8px', display:'flex', alignItems:'center', gap:'5px' }}>
                ▼ Losers
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:'6px' }}>
                {losers.length === 0
                  ? <div style={{ color:'var(--text-4)', fontSize:'12px', padding:'12px 0' }}>No losers today</div>
                  : losers.map(h => <MoverRow key={h.id} h={h} moversBy={moversBy} />)
                }
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Portfolio progression chart — filtered by active currency tab ── */}
      <PortfolioChart currency={ccyTab} />

      <style>{`
        @media (min-width: 769px) {
          [data-tour="summary-cards"] { grid-template-columns: 1fr !important; }
          [data-tour="summary-cards"] > div:last-child { grid-template-columns: repeat(4, 1fr) !important; }
        }
      `}</style>
    </div>
  )
}


function MoverRow({ h, moversBy }) {
  const up  = (h.daily_change_pct || 0) >= 0
  const pct = (h.daily_change_pct || 0).toFixed(2)
  const nativeChange = h.currency !== 'USD'
    ? fmtNative(Math.abs(h.daily_change_local || 0), h.currency)
    : fmtUSD(Math.abs(h.daily_change_usd || 0))
  const sign = up ? '+' : '−'
  const color = up ? '#4ade80' : '#f87171'
  const ticker = h.ticker.replace('.NS','').replace('.BO','').replace('.AE','')
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
      padding:'8px 12px', borderRadius:'8px', background:'var(--bg-base)',
      border:`1px solid ${color}20` }}>
      <div>
        <div style={{ fontWeight:700, fontSize:'13px', color:'var(--text-1)' }}>{ticker}</div>
        <div style={{ fontSize:'10px', color:'var(--text-4)', marginTop:'1px' }}>
          {fmtNative(h.current_price_local, h.currency)}
        </div>
      </div>
      <div style={{ textAlign:'right' }}>
        <div style={{ color, fontWeight:700, fontSize:'13px' }}>
          {moversBy === 'pct' ? `${sign}${pct}%` : `${sign}${nativeChange}`}
        </div>
        <div style={{ color:'var(--text-4)', fontSize:'10px', marginTop:'1px' }}>
          {moversBy === 'pct' ? `${sign}${nativeChange}` : `${sign}${pct}%`}
        </div>
      </div>
    </div>
  )
}

function SummaryCard({ label, value, sub, color }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardLabel}>{label}</div>
      <div className="card-value" style={{ ...styles.cardValue, color }}>{value}</div>
      <div style={styles.cardSub}>{sub}</div>
    </div>
  )
}

const SH = '0 1px 2px rgba(0,0,0,0.5), 0 8px 28px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.03) inset'

const styles = {
  // Outer wrapper: hero full-width + subcard grid below on mobile; all 5 in a row on desktop
  cards: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: '12px',
    marginBottom: '24px',
  },
  heroCard: {
    background: 'var(--bg-card)', borderRadius: '14px',
    padding: '22px 24px', boxShadow: SH, border: 'none',
  },
  // 2×2 on mobile, 4-col on desktop (handled via media query class)
  subCards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '12px',
  },
  card:  { background: 'var(--bg-card)', borderRadius: '14px', padding: '18px 20px', boxShadow: SH, border: 'none' },
  cardLabel: { color: 'var(--text-4)', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' },
  cardValue: { fontSize: '20px', fontWeight: 800, marginBottom: '4px', letterSpacing: '-0.5px' },
  cardSub:   { color: 'var(--text-4)', fontSize: '11px' },
  chartTitle: { color: 'var(--text-3)', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '12px' },
  moversBox:  { background: 'var(--bg-card)', borderRadius: '14px', padding: '20px', boxShadow: SH, border: 'none' },
}
