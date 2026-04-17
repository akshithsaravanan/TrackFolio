import { useState, useEffect } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from 'recharts'
import { getPortfolioHistory } from '../../api/client'
import { useHideValues } from '../../context/HideValuesContext'

const PERIODS = [
  { label: '1W',  value: '7d'  },
  { label: '1M',  value: '30d' },
  { label: '3M',  value: '90d' },
  { label: 'YTD', value: 'ytd' },
  { label: '1Y',  value: '1y'  },
]

export default function PortfolioChart({ currency = 'All' }) {
  const { mask, hidden } = useHideValues()
  const [period,   setPeriod]   = useState('30d')
  const [history,  setHistory]  = useState([])
  const [loading,  setLoading]  = useState(true)
  const [selected, setSelected] = useState(null)   // clicked data point

  // Format a value according to the active currency
  function fmtNative(v) {
    if (currency === 'INR') return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
    if (currency === 'AED') return `AED ${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  function fmtAxis(v) {
    if (currency === 'INR') return `₹${(v / 100000).toFixed(0)}L`
    if (currency === 'AED') return `AED${(v / 1000).toFixed(0)}k`
    return `$${(v / 1000).toFixed(0)}k`
  }

  useEffect(() => {
    setLoading(true)
    setSelected(null)
    getPortfolioHistory(period, currency)
      .then(data => setHistory(data.history || []))
      .finally(() => setLoading(false))
  }, [period, currency])

  if (loading) return (
    <div style={styles.box}>
      {/* Animated skeleton */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'20px', flexWrap:'wrap', gap:'12px' }}>
        <div>
          <div style={skel} className="skel" />
          <div style={{ ...skel, width:'180px', height:'28px', marginTop:'8px' }} className="skel" />
          <div style={{ ...skel, width:'120px', height:'14px', marginTop:'6px' }} className="skel" />
        </div>
        <div style={{ display:'flex', gap:'4px' }}>
          {[...Array(5)].map((_,i) => <div key={i} style={{ ...skel, width:'36px', height:'28px' }} className="skel" />)}
        </div>
      </div>
      <div style={{ ...skel, width:'100%', height:'240px' }} className="skel" />
      <style>{`
        @keyframes shimmer { 0%{opacity:.5} 50%{opacity:1} 100%{opacity:.5} }
        .skel { animation: shimmer 1.5s ease-in-out infinite; }
      `}</style>
    </div>
  )

  if (!history.length) return (
    <div style={styles.box}>
      <p style={{ color: 'var(--text-4)', fontSize: '14px' }}>No history data available.</p>
    </div>
  )

  // Aggregate daily data into weekly points for longer periods
  // For 7d: keep daily (only 7 points). For everything else: one point per week (last trading day of each week)
  function toWeekly(data) {
    if (period === '7d') return data   // daily is fine for 1 week
    const weeks = {}
    data.forEach(d => {
      const date = new Date(d.date)
      // ISO week key: year + week number
      const day  = date.getDay() // 0=Sun..6=Sat
      // Shift to Monday-start week
      const diff = (day === 0 ? -6 : 1) - day
      const mon  = new Date(date); mon.setDate(date.getDate() + diff)
      const key  = `${mon.getFullYear()}-W${String(Math.ceil(mon.getDate() / 7)).padStart(2,'0')}-${mon.getMonth()}`
      weeks[key] = d   // overwrite → last day of that week wins
    })
    return Object.values(weeks)
  }

  const chartData = toWeekly(history)
  const first = chartData[0]
  const last  = chartData[chartData.length - 1]
  const periodGain    = last.market_value - first.market_value
  const periodGainPct = ((periodGain / first.market_value) * 100).toFixed(2)
  const isPeriodGain  = periodGain >= 0

  // Format x-axis labels based on period
  function formatDate(dateStr) {
    const d = new Date(dateStr)
    if (period === '7d') return d.toLocaleDateString('en-GB', { weekday: 'short' })
    if (period === '1y') return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  }

  // Custom tooltip — shown on hover
  function CustomTooltip({ active, payload, label }) {
    if (!active || !payload?.length) return null
    const d = payload[0]?.payload
    if (!d) return null
    const gain    = d.market_value - d.cost_basis
    const gainPct = ((gain / d.cost_basis) * 100).toFixed(2)
    const isGain  = gain >= 0

    return (
      <div style={styles.tooltip}>
        <div style={styles.ttDate}>
          {new Date(label).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
        </div>
        <div style={styles.ttRow}>
          <span style={{ color: '#60a5fa' }}>● Market Value</span>
          <span style={{ color: 'var(--text-1)' }}>{mask(fmtNative(d.market_value))}</span>
        </div>
        <div style={styles.ttRow}>
          <span style={{ color: 'var(--text-4)' }}>─ Invested</span>
          <span style={{ color: 'var(--text-1)' }}>{mask(fmtNative(d.cost_basis))}</span>
        </div>
        <div style={{
          ...styles.ttRow,
          color: isGain ? '#4ade80' : '#f87171',
          borderTop: '1px solid var(--border-soft)',
          paddingTop: '6px',
          marginTop: '4px',
        }}>
          <span>Gain / Loss</span>
          <span>{mask(`${isGain ? '+' : ''}${fmtNative(Math.abs(gain))} (${gainPct}%)`)}</span>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.box}>

      {/* Header */}
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>Portfolio Value <span style={{ fontSize: '10px', fontWeight: 400, color: 'var(--text-4)', letterSpacing: '0.04em' }}>{currency === 'All' ? 'TOTAL · USD' : currency}</span></h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-1)', fontWeight: 700, fontSize: '22px', letterSpacing: '-0.5px' }}>
              {mask(fmtNative(last.market_value))}
            </span>
            <span style={{ color: isPeriodGain ? '#4ade80' : '#f87171', fontSize: '14px', fontWeight: 600 }}>
              {isPeriodGain ? '▲' : '▼'} {mask(`${isPeriodGain ? '+' : ''}${fmtNative(Math.abs(periodGain))} (${periodGainPct}%)`)}
            </span>
            <span style={{ color: 'var(--text-4)', fontSize: '12px' }}>this period</span>
          </div>
          {/* Legend */}
          <div style={{ display: 'flex', gap: '16px', marginTop: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-3)' }}>
              <div style={{ width: '20px', height: '2px', background: '#3b82f6', borderRadius: '2px' }} />
              Current Value
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-3)' }}>
              <div style={{ width: '20px', height: '2px', borderTop: '2px dashed #f59e0b' }} />
              Invested
            </div>
          </div>
        </div>

        {/* Period selector */}
        <div style={styles.periodBar}>
          {PERIODS.map(p => (
            <button
              key={p.value}
              style={{ ...styles.periodBtn, ...(period === p.value ? styles.periodBtnActive : {}) }}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart
          data={chartData}
          margin={{ top: 10, right: 10, left: 10, bottom: 0 }}
          onClick={(e) => e?.activePayload && setSelected(e.activePayload[0]?.payload)}
        >
          <defs>
            {/* Blue gradient under market value line */}
            <linearGradient id="gradValue" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
            </linearGradient>
            {/* Amber gradient under cost basis line */}
            <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#f59e0b" stopOpacity={0.12} />
              <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.0}  />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />

          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            tick={{ fill: 'var(--text-4)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--border-soft)' }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={(v) => hidden ? '•••' : fmtAxis(v)}
            tick={{ fill: 'var(--text-4)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={55}
          />

          <Tooltip content={<CustomTooltip />} />

          {/* Invested (cost basis) — amber, filled area, drawn first (behind) */}
          <Area
            type="monotone"
            dataKey="cost_basis"
            stroke="#f59e0b"
            strokeDasharray="5 3"
            strokeWidth={1.5}
            fill="url(#gradCost)"
            dot={false}
            activeDot={false}
            name="Invested"
          />

          {/* Market value — blue, filled area, drawn on top */}
          <Area
            type="monotone"
            dataKey="market_value"
            stroke="#3b82f6"
            strokeWidth={2}
            fill="url(#gradValue)"
            dot={false}
            activeDot={{ r: 5, fill: '#3b82f6', stroke: 'var(--bg-base)', strokeWidth: 2 }}
            name="Market Value"
          />
        </AreaChart>
      </ResponsiveContainer>

      {/* Clicked point detail */}
      {selected && (
        <div style={styles.selectedBar}>
          <span style={{ color: 'var(--text-3)' }}>
            {new Date(selected.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}
          </span>
          <span style={{ color: '#60a5fa' }}>
            Value: {mask(fmtNative(selected.market_value))}
          </span>
          <span style={{ color: 'var(--text-4)' }}>
            Invested: {mask(fmtNative(selected.cost_basis))}
          </span>
          <span style={{ color: selected.gain_loss >= 0 ? '#4ade80' : '#f87171' }}>
            {mask(`${selected.gain_loss >= 0 ? '+' : ''}${fmtNative(Math.abs(selected.gain_loss))} (${selected.gain_pct}%)`)}
          </span>
          <button style={styles.clearBtn} onClick={() => setSelected(null)}>✕</button>
        </div>
      )}

    </div>
  )
}

const styles = {
  box: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: '12px',
    padding: '24px',
    marginBottom: '24px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '20px',
    flexWrap: 'wrap',
    gap: '12px',
  },
  title: {
    color: 'var(--text-3)',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: 0,
  },
  periodBar: {
    display: 'flex',
    gap: '4px',
    background: 'var(--bg-base)',
    borderRadius: '8px',
    padding: '4px',
  },
  periodBtn: {
    padding: '5px 12px',
    background: 'transparent',
    border: 'none',
    borderRadius: '6px',
    color: 'var(--text-4)',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  periodBtnActive: {
    background: 'var(--bg-elevated)',
    color: 'var(--text-1)',
  },
  tooltip: {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    padding: '12px',
    fontSize: '13px',
    minWidth: '200px',
  },
  ttDate: { color: 'var(--text-2)', marginBottom: '8px', fontWeight: 600 },
  ttRow:  { display: 'flex', justifyContent: 'space-between', gap: '16px', marginBottom: '4px' },
  selectedBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '20px',
    background: 'var(--bg-base)',
    border: '1px solid var(--border-soft)',
    borderRadius: '8px',
    padding: '10px 16px',
    marginTop: '12px',
    fontSize: '13px',
    flexWrap: 'wrap',
  },
  clearBtn: {
    marginLeft: 'auto',
    background: 'none',
    border: 'none',
    color: 'var(--text-4)',
    cursor: 'pointer',
    fontSize: '14px',
  },
}

const skel = {
  background: 'var(--bg-elevated)',
  borderRadius: '6px',
  width: '100px',
  height: '14px',
}
