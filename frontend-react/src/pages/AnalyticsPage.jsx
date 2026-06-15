import { useState, useEffect } from 'react'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts'
import { getHoldings, getPortfolioHistory, getBenchmark, getSectors } from '../api/client'
import { useHideValues } from '../context/HideValuesContext'

const COLORS = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#ec4899','#84cc16']

// ── Native currency formatter ─────────────────────────────────
function fmtNative(value, currency) {
  if (value == null) return '—'
  if (currency === 'INR') return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
  if (currency === 'AED') return `AED ${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

// ── Benchmark horizontal bar ──────────────────────────────────
function BenchmarkRow({ label, value, maxAbs, bold }) {
  const [w, setW] = useState(0)
  const pct = maxAbs > 0 ? (Math.abs(value) / maxAbs) * 85 : 0
  useEffect(() => { const t = setTimeout(() => setW(pct), 300); return () => clearTimeout(t) }, [pct])
  const color = value >= 0 ? '#4ade80' : '#f87171'
  return (
    <div style={{ marginBottom:'14px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'5px', alignItems:'center' }}>
        <span style={{ color: bold ? 'var(--text-1)' : 'var(--text-2)', fontSize:'13px', fontWeight: bold ? 700 : 400 }}>
          {label}
        </span>
        <span style={{ color, fontWeight:700, fontSize:'14px' }}>
          {value >= 0 ? '+' : ''}{value.toFixed(1)}%
        </span>
      </div>
      <div style={{ height:'8px', background:'var(--bg-base)', borderRadius:'4px', overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${w}%`, background:color, borderRadius:'4px',
          transition:'width 1.2s ease-out', opacity: bold ? 1 : 0.65 }} />
      </div>
    </div>
  )
}

// ── Small helpers ────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  return (
    <div style={card}>
      <div style={{ color:'var(--text-4)', fontSize:'11px', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:'2px' }}>{label}</div>
      <div style={{ color: color || 'var(--text-1)', fontSize:'22px', fontWeight:700, margin:'6px 0 2px' }}>{value}</div>
      {sub && <div style={{ color:'var(--text-4)', fontSize:'12px' }}>{sub}</div>}
    </div>
  )
}

// ── Allocation Charts (tabbed: By Holding | By Asset Type | By Currency) ──
const CCY_COLORS = { USD: '#3b82f6', INR: '#f59e0b', AED: '#10b981' }

function AllocationCharts({ pieByHolding, byAssetType, bySector, summary, totalValue, singleCcy }) {
  const [tab, setTab] = useState('holding')

  const byCcy = (summary?.by_currency || []).map(c => ({
    name: c.currency,
    value: c.market_value_usd,
    pct: totalValue > 0 ? c.market_value_usd / totalValue * 100 : 0,
    localValue: c.market_value_local,
  }))

  // For holding/assettype tabs: show native value when a single currency is filtered
  const useNative = !!singleCcy && tab !== 'currency'

  const tabs = [
    { key: 'holding',   label: 'By Holding'    },
    { key: 'assettype', label: 'By Asset Type'  },
    { key: 'sector',    label: 'By Sector'      },
    { key: 'currency',  label: 'By Currency'    },
  ]

  let pieData, colors
  if (tab === 'holding')        { pieData = pieByHolding; colors = COLORS }
  else if (tab === 'assettype') { pieData = byAssetType;  colors = COLORS }
  else if (tab === 'sector')    { pieData = bySector;     colors = COLORS }
  else                          { pieData = byCcy; colors = byCcy.map(c => CCY_COLORS[c.name] || '#64748b') }

  return (
    <div style={{ ...card }}>
      {/* Tab strip */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'16px', flexWrap:'wrap', gap:'8px' }}>
        <div style={{ fontSize:'12px', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.05em' }}>
          Portfolio Allocation
        </div>
        <div className="alloc-tabs">
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              padding:'4px 10px', borderRadius:'6px', fontSize:'12px', fontWeight:500, cursor:'pointer', border:'none',
              background: tab === t.key ? 'var(--bg-elevated)' : 'transparent',
              color: tab === t.key ? 'var(--text-1)' : 'var(--text-4)',
              transition:'all 0.15s', whiteSpace:'nowrap', flexShrink:0,
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      <div className="alloc-chart-grid">
        {/* Donut */}
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie data={pieData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" paddingAngle={2}>
              {pieData.map((_, i) => (
                <Cell key={i} fill={Array.isArray(colors) ? colors[i] || COLORS[i % COLORS.length] : COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const d = payload[0]
              const nativeVal = useNative && d.payload.localValue != null
                ? fmtNative(d.payload.localValue, singleCcy)
                : tab === 'currency' && d.payload.localValue != null
                  ? fmtNative(d.payload.localValue, d.payload.name)
                  : `$${Number(d.value).toLocaleString('en-US',{ maximumFractionDigits:0 })}`
              return (
                <div style={{ background:'var(--bg-elevated)', border:'1px solid var(--border)', borderRadius:'8px', padding:'10px 14px', fontSize:'13px' }}>
                  <div style={{ color:'var(--text-1)', fontWeight:600 }}>{d.name}</div>
                  <div style={{ color:'var(--text-2)' }}>{nativeVal}</div>
                  <div style={{ color:'var(--text-3)' }}>{d.payload.pct?.toFixed(1)}%</div>
                </div>
              )
            }} />
          </PieChart>
        </ResponsiveContainer>

        {/* Legend */}
        <div style={{ display:'flex', flexDirection:'column', gap:'7px' }}>
          {pieData.map((d, i) => {
            const color = Array.isArray(colors) ? colors[i] || COLORS[i % COLORS.length] : COLORS[i % COLORS.length]
            // Show native when single currency is filtered, or always native for By Currency tab
            const valDisplay = useNative && d.localValue != null
              ? fmtNative(d.localValue, singleCcy)
              : tab === 'currency' && d.localValue != null
                ? fmtNative(d.localValue, d.name)
                : `$${(d.value||0).toLocaleString('en-US',{ maximumFractionDigits:0 })}`
            return (
              <div key={d.name} style={{ display:'flex', alignItems:'center', gap:'8px', fontSize:'12px' }}>
                <div style={{ width:9, height:9, borderRadius:'50%', background:color, flexShrink:0 }} />
                <span style={{ flex:1, color:'var(--text-2)', fontWeight:500 }}>{d.name}</span>
                <span style={{ color:'var(--text-3)', fontSize:'11px' }}>{d.pct?.toFixed(1)}%</span>
                <span style={{ color:'var(--text-1)', textAlign:'right', fontSize:'12px', flexShrink:0 }}>{valDisplay}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}


// ── Rebalancing Card (compact grid) ──────────────────────
function RebalanceCard({ holdings, totalValue, singleCcy }) {
  const sorted = [...holdings]
    .filter(h => (h.market_value_usd || 0) > 0)
    .sort((a, b) => (b.market_value_usd || 0) - (a.market_value_usd || 0))

  const makeTargets = (rows) =>
    Object.fromEntries(rows.map(h => [
      h.id,
      totalValue > 0 ? parseFloat((h.market_value_usd / totalValue * 100).toFixed(1)) : 0
    ]))

  const [targets, setTargets] = useState(() => makeTargets(sorted))

  if (totalValue === 0 || sorted.length === 0) return null

  const targetSum = sorted.reduce((s, h) => s + Number(targets[h.id] || 0), 0)
  const sumOk     = Math.abs(targetSum - 100) <= 1

  return (
    <div style={{ background:'var(--bg-card)', borderRadius:'12px', padding:'20px', border:'1px solid var(--border)', boxShadow:'var(--shadow)' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'6px', flexWrap:'wrap', gap:'8px' }}>
        <div style={{ fontSize:'12px', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.05em' }}>
          Target Allocation &amp; Rebalancing
        </div>
        <div style={{ display:'flex', gap:'8px', alignItems:'center', flexWrap:'wrap' }}>
          <span style={{ fontSize:'12px', color: sumOk ? '#4ade80' : '#f59e0b' }}>
            Sum: {targetSum.toFixed(1)}% {sumOk ? '✓' : '⚠ adjust to 100%'}
          </span>
          <button onClick={() => setTargets(makeTargets(sorted))} style={{
            fontSize:'11px', padding:'3px 10px', borderRadius:'6px', cursor:'pointer',
            border:'1px solid var(--border)', background:'var(--bg-base)', color:'var(--text-3)'
          }}>Reset</button>
          <button onClick={() => {
            const rows = sorted.map(h => {
              const cur = totalValue > 0 ? (h.market_value_usd / totalValue * 100) : 0
              const tgt = Number(targets[h.id] || 0)
              const diff = tgt - cur
              const amt = Math.abs(diff / 100 * totalValue)
              const ticker = h.ticker.replace('.NS','').replace('.BO','').replace('.AE','')
              return [ticker, cur.toFixed(1)+'%', tgt.toFixed(1)+'%', (diff>=0?'+':'')+diff.toFixed(1)+'%',
                Math.abs(diff) > 1 ? (diff > 0 ? 'BUY' : 'SELL') : 'OK',
                Math.abs(diff) > 1 ? '$'+amt.toFixed(0) : '']
            })
            const csv = [['Ticker','Current %','Target %','Diff','Action','Amount (USD)'], ...rows]
              .map(r => r.map(v => `"${v}"`).join(',')).join('\n')
            const a = document.createElement('a')
            a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }))
            a.download = 'rebalancing.csv'; a.click()
          }} style={{
            fontSize:'11px', padding:'3px 10px', borderRadius:'6px', cursor:'pointer',
            border:'1px solid var(--border)', background:'var(--bg-base)', color:'var(--text-3)'
          }}>↓ Export CSV</button>
        </div>
      </div>
      <p style={{ color:'var(--text-3)', fontSize:'12px', marginBottom:'16px' }}>
        Edit target % for each holding. BUY / SELL amounts shown when off-target by more than 1%.
      </p>

      {/* Table layout — scrollable after ~12 rows */}
      <div className="rebalance-scroll" style={{ maxHeight:'460px', overflowY:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'13px' }}>
          <thead>
            <tr style={{ position:'sticky', top:0, background:'var(--bg-elevated)', zIndex:1 }}>
              <th style={{ padding:'8px 10px', textAlign:'left',   fontSize:'11px', color:'var(--text-4)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em' }}>Ticker</th>
              <th style={{ padding:'8px 10px', textAlign:'right',  fontSize:'11px', color:'var(--text-4)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em' }}>Value</th>
              <th style={{ padding:'8px 10px', textAlign:'right',  fontSize:'11px', color:'var(--text-4)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em', minWidth:'80px' }}>Current</th>
              <th style={{ padding:'8px 10px', textAlign:'center', fontSize:'11px', color:'var(--text-4)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em', minWidth:'100px' }}>Target %</th>
              <th style={{ padding:'8px 10px', textAlign:'right',  fontSize:'11px', color:'var(--text-4)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em' }}>Diff</th>
              <th style={{ padding:'8px 10px', textAlign:'center', fontSize:'11px', color:'var(--text-4)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em' }}>Action</th>
            </tr>
          </thead>
          <tbody>
        {sorted.map(h => {
          const currentPct = totalValue > 0 ? h.market_value_usd / totalValue * 100 : 0
          const targetPct  = Number(targets[h.id] || 0)
          const diff       = targetPct - currentPct
          const diffUSD    = diff / 100 * totalValue
          const ticker     = h.ticker.replace('.NS','').replace('.BO','').replace('.AE','')
          const offTarget  = Math.abs(diff) > 1
          const valDisplay = singleCcy
            ? fmtNative(h.market_value_local || 0, singleCcy)
            : `$${(h.market_value_usd || 0).toLocaleString('en-US',{maximumFractionDigits:0})}`
          const actionAmt = singleCcy && h.market_value_usd > 0
            ? fmtNative(Math.abs(diffUSD / h.market_value_usd * (h.market_value_local || 0)), singleCcy)
            : `$${Math.abs(diffUSD).toLocaleString('en-US',{maximumFractionDigits:0})}`

          return (
            <tr key={h.id} style={{ borderTop:'1px solid var(--border-soft)',
              background: offTarget ? (diff>0 ? 'rgba(74,222,128,0.04)' : 'rgba(248,113,113,0.04)') : 'transparent' }}>
              <td style={{ padding:'8px 10px', fontWeight:600, color:'var(--text-1)' }}>
                {ticker}
                <div style={{ fontSize:'10px', color:'var(--text-4)', marginTop:'1px' }}>
                  <div style={{ width:`${Math.min(100, currentPct) * 0.6}px`, height:'2px', background:'var(--accent)', borderRadius:'1px', marginTop:'3px' }} />
                </div>
              </td>
              <td style={{ padding:'8px 10px', textAlign:'right', fontSize:'12px', color:'var(--text-3)' }}>{valDisplay}</td>
              <td style={{ padding:'8px 10px', textAlign:'right', fontWeight:600, color:'var(--text-1)' }}>{currentPct.toFixed(1)}%</td>
              <td style={{ padding:'6px 10px', textAlign:'center' }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'4px' }}>
                  <input
                    type="number" min="0" max="100" step="0.5"
                    value={targets[h.id] ?? ''}
                    onChange={e => setTargets(prev => ({ ...prev, [h.id]: e.target.value }))}
                    style={{
                      width:'56px', padding:'3px 6px', borderRadius:'4px', fontSize:'12px',
                      textAlign:'center', border:'1px solid var(--border)',
                      background:'var(--bg-elevated)', color:'var(--text-1)', outline:'none',
                    }}
                  />
                  <span style={{ fontSize:'11px', color:'var(--text-4)' }}>%</span>
                </div>
              </td>
              <td style={{ padding:'8px 10px', textAlign:'right', fontWeight:600, fontSize:'12px',
                color: diff > 0 ? '#4ade80' : diff < 0 ? '#f87171' : 'var(--text-4)' }}>
                {diff !== 0 ? `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%` : '—'}
              </td>
              <td style={{ padding:'8px 10px', textAlign:'center' }}>
                {offTarget ? (
                  <span style={{ fontSize:'11px', fontWeight:700,
                    color: diff > 0 ? '#4ade80' : '#f87171' }}>
                    {diff > 0 ? '▲ BUY' : '▼ SELL'} {actionAmt}
                  </span>
                ) : <span style={{ fontSize:'11px', color:'var(--text-4)' }}>✓ OK</span>}
              </td>
            </tr>
          )
        })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop:'10px', fontSize:'11px', color:'var(--text-4)', borderTop:'1px solid var(--border-soft)', paddingTop:'8px' }}>
        ▲ BUY = underweight · ▼ SELL = overweight · Diff &gt; 1% triggers action · Amounts are approximate.
      </div>
    </div>
  )
}


// ── Concentration Bubbles ─────────────────────────────────
function ConcentrationHeatmap({ holdings, totalValue }) {
  const [tooltip, setTooltip] = useState(null)

  const sorted = [...holdings]
    .filter(h => (h.market_value_usd || 0) > 0)
    .sort((a, b) => (b.market_value_usd || 0) - (a.market_value_usd || 0))

  if (!sorted.length) return null

  // Colour by gain/loss — green shades up, red shades down
  const gainColor = pct =>
    pct > 20  ? '#15803d' :
    pct > 10  ? '#16a34a' :
    pct > 3   ? '#22c55e' :
    pct > 0   ? '#4ade80' :
    pct > -5  ? '#f87171' :
    pct > -15 ? '#dc2626' :
                '#991b1b'

  const borderColor = pct => pct >= 0
    ? 'rgba(74,222,128,0.25)'
    : 'rgba(248,113,113,0.25)'

  return (
    <div style={{ background:'var(--bg-card)', borderRadius:'14px', padding:'20px', boxShadow:'var(--shadow)', border:'none', position:'relative' }}>
      <div style={{ fontSize:'11px', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:'4px' }}>
        Concentration
      </div>
      <p style={{ fontSize:'11px', color:'var(--text-4)', margin:'0 0 16px' }}>
        Bubble size = weight · Colour = unrealised P&amp;L · Tap for details
      </p>

      <div style={{ display:'flex', flexWrap:'wrap', gap:'8px', alignItems:'center' }}>
        {sorted.map(h => {
          const pct     = totalValue > 0 ? h.market_value_usd / totalValue * 100 : 0
          const gainPct = h.gain_loss_pct || 0
          const ticker  = h.ticker.replace('.NS','').replace('.BO','').replace('.AE','')
          const textPnl = `${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%`
          // Bubble diameter: scale by sqrt of pct for better visual balance
          const dia = Math.max(40, Math.min(130, Math.sqrt(pct) * 28))
          const fontSize = Math.max(8, Math.min(13, dia / 5.5))

          return (
            <div
              key={h.id}
              onMouseEnter={() => setTooltip(h.id)}
              onMouseLeave={() => setTooltip(null)}
              onClick={() => setTooltip(t => t === h.id ? null : h.id)}
              style={{
                width:`${dia}px`, height:`${dia}px`,
                borderRadius:'50%',
                background: gainColor(gainPct),
                border:`1.5px solid ${borderColor(gainPct)}`,
                display:'flex', flexDirection:'column',
                alignItems:'center', justifyContent:'center',
                cursor:'pointer',
                position:'relative',
                transition:'transform 0.15s, box-shadow 0.15s',
                boxShadow: tooltip === h.id
                  ? `0 0 0 2px ${gainPct >= 0 ? 'rgba(74,222,128,0.5)' : 'rgba(248,113,113,0.5)'}, 0 4px 16px rgba(0,0,0,0.4)`
                  : '0 2px 8px rgba(0,0,0,0.3)',
                transform: tooltip === h.id ? 'scale(1.08)' : 'scale(1)',
              }}
            >
              <span style={{ fontSize, fontWeight:700, color:'#fff', lineHeight:1.1, textAlign:'center', padding:'0 2px' }}>
                {ticker}
              </span>
              {dia > 55 && (
                <span style={{ fontSize: Math.max(7, fontSize - 2), color:'rgba(255,255,255,0.75)', lineHeight:1.2 }}>
                  {pct.toFixed(1)}%
                </span>
              )}

              {/* Tooltip on hover/tap */}
              {tooltip === h.id && (
                <div style={{
                  position:'absolute', bottom:`${dia/2 + 10}px`, left:'50%',
                  transform:'translateX(-50%)',
                  background:'var(--bg-elevated)', border:'1px solid var(--border)',
                  borderRadius:'8px', padding:'8px 12px',
                  fontSize:'11px', color:'var(--text-1)', zIndex:10,
                  whiteSpace:'nowrap', boxShadow:'0 4px 20px rgba(0,0,0,0.5)',
                  pointerEvents:'none',
                }}>
                  <div style={{ fontWeight:700, marginBottom:'3px' }}>{ticker}</div>
                  <div style={{ color:'var(--text-3)' }}>Weight: <b style={{ color:'var(--text-1)' }}>{pct.toFixed(2)}%</b></div>
                  <div style={{ color: gainPct >= 0 ? 'var(--green)' : 'var(--red)' }}>P&L: <b>{textPnl}</b></div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div style={{ display:'flex', gap:'12px', marginTop:'14px', flexWrap:'wrap' }}>
        {[
          { c:'#22c55e', l:'Gain' },
          { c:'#f87171', l:'Loss' },
          { c:'#15803d', l:'Strong gain' },
          { c:'#991b1b', l:'Heavy loss'  },
        ].map(({ c, l }) => (
          <div key={l} style={{ display:'flex', alignItems:'center', gap:'5px' }}>
            <div style={{ width:9, height:9, borderRadius:'50%', background:c }} />
            <span style={{ fontSize:'10px', color:'var(--text-4)' }}>{l}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Holding Age Analysis ──────────────────────────────────
function HoldingAgeCard({ holdings }) {
  const today = new Date()

  const BUCKETS = [
    { label:'< 3 months',  min:0,    max:90,       color:'#f59e0b' },
    { label:'3–12 months', min:90,   max:365,      color:'#3b82f6' },
    { label:'1–3 years',   min:365,  max:1095,     color:'#8b5cf6' },
    { label:'3+ years',    min:1095, max:Infinity,  color:'#10b981' },
  ]

  // Use effective_purchase_date (backend resolves: manual date OR earliest BUY transaction)
  const rows = []
  holdings.forEach(h => {
    const dateStr = h.effective_purchase_date || h.purchase_date
    if (!dateStr) return
    const ageDays = Math.floor((today - new Date(dateStr)) / 86400000)
    if (ageDays < 0) return   // future date — skip
    rows.push({ ...h, ageDays, _dateStr: dateStr })
  })
  rows.sort((a, b) => (a.ageDays || 0) - (b.ageDays || 0))

  const totalVal = rows.reduce((s, h) => s + (h.market_value_usd || 0), 0)

  const bucketStats = BUCKETS.map(b => {
    const hs  = rows.filter(h => h.ageDays >= b.min && h.ageDays < b.max)
    const val = hs.reduce((s, h) => s + (h.market_value_usd || 0), 0)
    return { ...b, count: hs.length, val, pct: totalVal > 0 ? val / totalVal * 100 : 0 }
  }).filter(b => b.count > 0)

  const noDates = holdings.filter(h => !h.effective_purchase_date && !h.purchase_date).length

  function ageStr(days) {
    if (days < 30)   return `${days}d`
    if (days < 365)  return `${Math.floor(days/30)}m ${days%30}d`
    const y = Math.floor(days/365), m = Math.floor((days%365)/30)
    return m > 0 ? `${y}y ${m}m` : `${y}y`
  }

  return (
    <div style={{ background:'var(--bg-card)', borderRadius:'12px', padding:'20px', border:'1px solid var(--border)', boxShadow:'var(--shadow)' }}>
      <div style={{ fontSize:'12px', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'6px' }}>
        📅 Holding Age Analysis
      </div>
      <p style={{ fontSize:'12px', color:'var(--text-4)', margin:'0 0 14px' }}>
        Holdings &gt;1 year typically qualify for long-term capital gains (LTCG) treatment.
        Dates auto-filled from your earliest recorded BUY transaction per stock.
        {noDates > 0 && <span style={{ color:'#f59e0b' }}> · {noDates} holding{noDates>1?'s':''} have no date yet — add a BUY transaction or edit the holding to set one.</span>}
      </p>

      {/* Bucket summary cards */}
      {bucketStats.length > 0 && (
        <div style={{ display:'flex', gap:'8px', marginBottom:'16px', flexWrap:'wrap' }}>
          {bucketStats.map(b => (
            <div key={b.label} style={{
              flex:'1', minWidth:'90px', textAlign:'center',
              background:'var(--bg-base)', borderRadius:'8px', padding:'10px 8px',
              borderTop:`3px solid ${b.color}`,
            }}>
              <div style={{ fontSize:'22px', fontWeight:700, color:b.color }}>{b.count}</div>
              <div style={{ fontSize:'11px', color:'var(--text-3)', margin:'2px 0' }}>{b.label}</div>
              <div style={{ fontSize:'11px', color:'var(--text-4)' }}>
                ${(b.val/1000).toFixed(0)}k · {b.pct.toFixed(0)}%
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      {rows.length > 0 ? (
        <div style={{ maxHeight:'300px', overflowY:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'12px' }}>
            <thead>
              <tr style={{ position:'sticky', top:0, background:'var(--bg-elevated)', zIndex:1 }}>
                <th style={{ padding:'6px 10px', color:'var(--text-4)', fontWeight:600, textAlign:'left',  fontSize:'12px' }}>Holding</th>
                <th style={{ padding:'6px 10px', color:'var(--text-4)', fontWeight:600, textAlign:'right', fontSize:'12px' }}>Bought</th>
                <th style={{ padding:'6px 10px', color:'var(--text-4)', fontWeight:600, textAlign:'right', fontSize:'12px' }}>Age</th>
                <th style={{ padding:'6px 10px', color:'var(--text-4)', fontWeight:600, textAlign:'right', fontSize:'12px' }}>Value</th>
                <th style={{ padding:'6px 10px', color:'var(--text-4)', fontWeight:600, textAlign:'center',fontSize:'12px' }}>Tax Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(h => {
                const ticker    = h.ticker.replace('.NS','').replace('.BO','').replace('.AE','')
                const isLTCG    = h.ageDays >= 365
                const fromTxn   = !h.purchase_date && !!h.effective_purchase_date
                return (
                  <tr key={h.id} style={{ borderTop:'1px solid var(--border-soft)' }}>
                    <td style={{ padding:'8px 10px', color:'var(--text-2)' }}>
                      <span style={{ fontWeight:600, color:'var(--text-1)' }}>{ticker}</span>
                      <div style={{ fontSize:'10px', color:'var(--text-4)' }}>{h.name}</div>
                    </td>
                    <td style={{ padding:'8px 10px', color:'var(--text-3)', textAlign:'right' }}>
                      {h._dateStr}
                      {fromTxn && <div style={{ fontSize:'9px', color:'var(--text-4)' }}>from txn</div>}
                    </td>
                    <td style={{ padding:'8px 10px', color:'var(--text-2)', textAlign:'right', fontWeight:600 }}>
                      {ageStr(h.ageDays)}
                    </td>
                    <td style={{ padding:'8px 10px', color:'var(--text-2)', textAlign:'right' }}>
                      ${((h.market_value_usd||0)/1000).toFixed(1)}k
                    </td>
                    <td style={{ padding:'8px 10px', textAlign:'center' }}>
                      <span style={{
                        padding:'2px 7px', borderRadius:'4px', fontSize:'10px', fontWeight:700,
                        background: isLTCG ? 'rgba(20,83,45,0.6)'  : 'rgba(124,45,18,0.6)',
                        color:      isLTCG ? '#4ade80'              : '#fb923c',
                      }}>
                        {isLTCG ? 'LTCG' : 'STCG'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ color:'var(--text-4)', fontSize:'13px', textAlign:'center', padding:'24px' }}>
          No purchase dates recorded yet. Edit your holdings to add them.
        </div>
      )}
    </div>
  )
}


// ════════════════════════════════════════════════════════════
//  PAGE
// ════════════════════════════════════════════════════════════
export default function AnalyticsPage() {
  const { mask } = useHideValues()
  const [holdings,  setHoldings]  = useState([])
  const [summary,   setSummary]   = useState(null)
  const [history,   setHistory]   = useState([])
  const [benchmark, setBenchmark] = useState({})
  const [loading,   setLoading]   = useState(true)
  const [currency,  setCurrency]  = useState('All')
  const [sectors,   setSectors]   = useState({})
  const [activeTab,    setActiveTab]    = useState('overview')
  const [histLoading,  setHistLoading]  = useState(true)

  useEffect(() => {
    // Holdings blocks the page — fast (DB query)
    getHoldings()
      .then(d => { setHoldings(d.holdings || []); setSummary(d.summary || null) })
      .catch(() => {})
      .finally(() => setLoading(false))

    // Background loads — won't block the UI
    getPortfolioHistory('1y')
      .then(d => { setHistory(d.history || []) })
      .catch(() => {})
      .finally(() => setHistLoading(false))

    getBenchmark().then(d => setBenchmark(d       || {})).catch(() => {})
    getSectors().then(d   => setSectors(d.sectors || {})).catch(() => {})
  }, [])


  if (loading) return <div style={{ color:'var(--text-3)', padding:'40px' }}>Loading analytics...</div>
  if (!holdings.length) return (
    <div style={{ color:'var(--text-3)', padding:'60px', textAlign:'center' }}>
      <div style={{ fontSize:'32px', fontWeight:700, color:'var(--accent)', marginBottom:'12px' }}>—</div>
      <div>No holdings yet. Add holdings to see analytics.</div>
    </div>
  )

  // ── Currency filter ──────────────────────────────
  const currencies = [...new Set(holdings.map(h => h.currency))].sort()
  const filteredH  = currency === 'All' ? holdings : holdings.filter(h => h.currency === currency)

  // ── Metrics ──────────────────────────────────────
  const totalValue = currency === 'All'
    ? (summary?.total_market_value_usd || 0)
    : filteredH.reduce((s, h) => s + (h.market_value_usd || 0), 0)
  const totalCost  = currency === 'All'
    ? (summary?.total_cost_basis_usd || 0)
    : filteredH.reduce((s, h) => s + (h.cost_basis_usd || 0), 0)
  const totalGain    = totalValue - totalCost
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost * 100) : 0
  const todayGain    = filteredH.reduce((s, h) => s + (h.daily_change_usd || 0), 0)

  // Native currency totals (for single-currency tab)
  const singleCcy       = currency !== 'All' ? currency : null
  const totalValueNat   = filteredH.reduce((s, h) => s + (h.market_value_local || 0), 0)
  const totalGainNat    = filteredH.reduce((s, h) => s + (h.gain_loss_local   || 0), 0)
  const totalCostNat    = totalValueNat - totalGainNat
  const todayGainNat    = filteredH.reduce((s, h) => s + (h.daily_change_local || 0), 0)
  // Display helpers
  const displayValue    = singleCcy ? fmtNative(totalValueNat, singleCcy) : `$${totalValue.toLocaleString('en-US',{ maximumFractionDigits:0 })}`
  const displayCost     = singleCcy ? fmtNative(totalCostNat,  singleCcy) : `$${totalCost.toLocaleString('en-US',{ maximumFractionDigits:0 })}`
  const displayGain     = singleCcy
    ? `${totalGainNat>=0?'+':''}${fmtNative(Math.abs(totalGainNat), singleCcy)}`
    : `${totalGain>=0?'+':''}$${Math.abs(totalGain).toLocaleString('en-US',{ maximumFractionDigits:0 })}`
  const displayToday    = singleCcy
    ? `${todayGainNat>=0?'+':''}${fmtNative(Math.abs(todayGainNat), singleCcy)}`
    : `${todayGain>=0?'+':''}$${Math.abs(todayGain).toFixed(0)}`

  // Gainers / losers
  const withPnl  = filteredH.filter(h => h.gain_loss_pct != null)
  const gainers  = [...withPnl].filter(h => h.gain_loss_pct > 0).sort((a, b) => b.gain_loss_pct - a.gain_loss_pct).slice(0, 5)
  const losers   = [...withPnl].filter(h => h.gain_loss_pct < 0).sort((a, b) => a.gain_loss_pct - b.gain_loss_pct).slice(0, 5)

  // CAGR from 1y history
  let cagr = null, portfolioReturn = null
  if (history.length >= 30) {
    const fv = history[0]?.market_value, lv = history[history.length - 1]?.market_value
    const yrs = history.length / 252
    if (fv > 0 && yrs > 0) cagr = ((Math.pow(lv / fv, 1 / yrs) - 1) * 100).toFixed(1)
    if (fv > 0) portfolioReturn = parseFloat(((lv - fv) / fv * 100).toFixed(2))
  }

  // Concentration
  const byValue  = [...filteredH].filter(h => h.market_value_usd).sort((a, b) => b.market_value_usd - a.market_value_usd)
  const top3pct  = byValue.slice(0, 3).reduce((s, h) => s + (h.market_value_usd / totalValue * 100), 0)

  // Pie data — by holding
  const top8          = byValue.slice(0, 8)
  const othersVal     = byValue.slice(8).reduce((s, h) => s + (h.market_value_usd   || 0), 0)
  const othersValLoc  = byValue.slice(8).reduce((s, h) => s + (h.market_value_local || 0), 0)
  const pieByHolding  = [
    ...top8.map(h => ({
      name:       h.ticker.replace('.NS','').replace('.BO','').replace('.AE',''),
      value:      h.market_value_usd,
      localValue: h.market_value_local,
      pct:        totalValue > 0 ? h.market_value_usd / totalValue * 100 : 0,
    })),
    ...(othersVal > 0 ? [{ name: 'Others', value: othersVal, localValue: othersValLoc, pct: othersVal / totalValue * 100 }] : []),
  ]

  // Pie data — by asset type
  const byAssetType = Object.values(
    filteredH.reduce((acc, h) => {
      const type = h.asset_type || 'Other'
      if (!acc[type]) acc[type] = { name: type, value: 0, localValue: 0 }
      acc[type].value      += h.market_value_usd   || 0
      acc[type].localValue += h.market_value_local || 0
      return acc
    }, {})
  ).map(a => ({ ...a, pct: totalValue > 0 ? a.value / totalValue * 100 : 0 }))
    .sort((a, b) => b.value - a.value)

  // Pie data — by sector (uses sectors prop from backend)
  const bySector = Object.values(
    filteredH.reduce((acc, h) => {
      const sec = sectors[h.ticker]?.sector || 'Unknown'
      if (!acc[sec]) acc[sec] = { name: sec, value: 0, localValue: 0 }
      acc[sec].value      += h.market_value_usd   || 0
      acc[sec].localValue += h.market_value_local || 0
      return acc
    }, {})
  ).map(a => ({ ...a, pct: totalValue > 0 ? a.value / totalValue * 100 : 0 }))
    .sort((a, b) => b.value - a.value)

  // Bar chart top 10 by abs P&L — include native values for single-ccy display
  const barData = [...filteredH]
    .filter(h => h.gain_loss_usd != null)
    .sort((a, b) => Math.abs(b.gain_loss_usd) - Math.abs(a.gain_loss_usd))
    .slice(0, 10)
    .map(h => ({
      ticker:     h.ticker.replace('.NS','').replace('.BO','').replace('.AE',''),
      value:      singleCcy ? (h.gain_loss_local ?? h.gain_loss_usd) : h.gain_loss_usd,
      pct:        h.gain_loss_pct,
      currency:   h.currency,
    }))

  // Benchmark rows (portfolio + indices)
  const bmRows = []
  if (portfolioReturn !== null) bmRows.push({ label: 'Your Portfolio', value: portfolioReturn, bold: true })
  Object.entries(benchmark).forEach(([k, v]) => bmRows.push({ label: k, value: v, bold: false }))
  const maxAbs = bmRows.length ? Math.max(...bmRows.map(r => Math.abs(r.value))) : 1

  return (
    <div style={{ color:'var(--text-1)', display:'flex', flexDirection:'column', gap:'20px' }}>

      {/* ── Header ── */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:'12px' }}>
        <div>
          <h2 style={{ fontSize:'22px', fontWeight:700, marginBottom:'4px' }}>Analytics</h2>
          <p style={{ color:'var(--text-3)', fontSize:'13px' }}>{filteredH.length} holdings · Portfolio deep-dive</p>
        </div>
        {currencies.length > 1 && (
          <div style={{ display:'flex', gap:'6px', flexWrap:'wrap' }}>
            {['All', ...currencies].map(c => (
              <button key={c} onClick={() => setCurrency(c)} style={{
                padding:'6px 14px', borderRadius:'20px', fontSize:'12px',
                fontWeight: currency === c ? 600 : 400, cursor:'pointer',
                border:'1px solid var(--border)',
                background: currency === c ? 'var(--accent)' : 'transparent',
                color: currency === c ? '#fff' : 'var(--text-3)',
                transition:'all 0.15s',
              }}>{c}</button>
            ))}
          </div>
        )}
      </div>

      {/* ── Tab strip ── */}
      <div className="analytics-tabs" style={{ display:'flex', gap:'2px', background:'var(--bg-elevated)', borderRadius:'10px', padding:'4px', border:'1px solid var(--border)' }}>
        {[
          { key:'overview',   label:'Overview'   },
          { key:'allocation', label:'Allocation'  },
        ].map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} className="tab-btn" style={{
            flex:1, padding:'8px 4px', borderRadius:'7px', fontSize:'13px',
            fontWeight: activeTab === t.key ? 600 : 400,
            cursor:'pointer', border:'none',
            background: activeTab === t.key ? 'var(--bg-card)' : 'transparent',
            color: activeTab === t.key ? 'var(--text-1)' : 'var(--text-4)',
            transition:'all 0.15s',
            boxShadow: activeTab === t.key ? 'var(--shadow)' : 'none',
            whiteSpace:'nowrap',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ════════════════════════════════════════
          OVERVIEW TAB
      ════════════════════════════════════════ */}
      {activeTab === 'overview' && (<>

        {/* Summary cards */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:'12px' }}>
          <StatCard label="Total Value"    value={mask(displayValue)} sub={`${filteredH.length} holdings`} />
          <StatCard label="Total Invested" value={mask(displayCost)} />
          <StatCard label="Overall P&L"
            value={mask(displayGain)}
            sub={`${totalGainPct>=0?'+':''}${totalGainPct.toFixed(2)}%`}
            color={totalGain >= 0 ? '#4ade80' : '#f87171'} />
          <StatCard label="Today's P&L"
            value={mask(displayToday)}
            color={todayGain >= 0 ? '#4ade80' : '#f87171'} />
          {cagr && <StatCard label="1Y Ann. Return" value={`${cagr}%`} sub="est. CAGR" color="#60a5fa" />}
          <StatCard label="Concentration" value={`${top3pct.toFixed(0)}%`} sub="Top 3 holdings"
            color={top3pct > 60 ? '#f59e0b' : '#4ade80'} />
        </div>

        {/* Benchmark comparison */}
        {!histLoading && bmRows.length >= 2 ? (
          <div style={card}>
            <div style={cardTitle}>1-Year Performance vs Benchmarks</div>
            <div style={{ maxWidth:'520px' }}>
              {bmRows.map(r => (
                <BenchmarkRow key={r.label} label={r.label} value={r.value} maxAbs={maxAbs} bold={r.bold} />
              ))}
            </div>
            {bmRows.length >= 2 && portfolioReturn !== null && (
              <div style={{ marginTop:'8px', fontSize:'12px', color:'var(--text-3)' }}>
                {portfolioReturn > (benchmark['Nifty 50'] ?? -Infinity) && portfolioReturn > (benchmark['S&P 500'] ?? -Infinity)
                  ? 'Outperforming all benchmarks over 1 year'
                  : portfolioReturn > (benchmark['Nifty 50'] ?? -Infinity) || portfolioReturn > (benchmark['S&P 500'] ?? -Infinity)
                  ? '⚡ Outperforming some benchmarks'
                  : '⚠️ Underperforming benchmarks — review allocation'}
              </div>
            )}
          </div>
        ) : null}

        {/* P&L bar chart */}
        <div style={card}>
          <div style={cardTitle}>Gain / Loss by Holding {singleCcy ? `(${singleCcy})` : '(USD)'}</div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={barData} margin={{ top:8, right:16, left:0, bottom:0 }} barCategoryGap="30%">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
              <XAxis dataKey="ticker" tick={{ fill:'var(--text-3)', fontSize:11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill:'var(--text-3)', fontSize:11 }} axisLine={false} tickLine={false}
                tickFormatter={v => singleCcy === 'INR' ? `₹${(v/1000).toFixed(0)}k`
                                : singleCcy === 'AED'  ? `AED ${(v/1000).toFixed(0)}k`
                                : `$${(v/1000).toFixed(0)}k`} />
              <Tooltip
                cursor={{ fill:'rgba(128,128,128,0.06)' }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload
                  const dispVal = singleCcy
                    ? `${d.value >= 0 ? '+' : ''}${fmtNative(Math.abs(d.value), singleCcy)}`
                    : `${d.value >= 0 ? '+' : ''}$${Math.abs(d.value).toLocaleString('en-US',{ maximumFractionDigits:0 })}`
                  return (
                    <div style={{ background:'var(--bg-elevated)', border:'1px solid var(--border)', borderRadius:'8px', padding:'10px 14px', fontSize:'13px' }}>
                      <div style={{ color:'var(--text-1)', fontWeight:600, marginBottom:'4px' }}>{d.ticker}</div>
                      <div style={{ color: d.value >= 0 ? '#4ade80' : '#f87171' }}>{dispVal}</div>
                      <div style={{ color:'var(--text-3)' }}>{d.pct?.toFixed(1)}%</div>
                    </div>
                  )
                }}
              />
              <Bar dataKey="value" radius={[4,4,0,0]}>
                {barData.map((entry, i) => (
                  <Cell key={i} fill={entry.value >= 0 ? '#4ade80' : '#f87171'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Top movers — stacks to 1 col on mobile */}
        <div className="movers-split" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'16px' }}>
          <div style={card}>
            <div style={cardTitle}>Top Gainers</div>
            {gainers.length === 0
              ? <div style={{ color:'var(--text-4)', fontSize:'13px' }}>No gainers yet</div>
              : <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'13px' }}>
                  <thead><tr>
                    <th style={th}>Stock</th>
                    <th style={{ ...th, textAlign:'right' }}>Value</th>
                    <th style={{ ...th, textAlign:'right' }}>P&L</th>
                    <th style={{ ...th, textAlign:'right' }}>Gain%</th>
                  </tr></thead>
                  <tbody>
                    {gainers.map(h => {
                      const valDisp = singleCcy
                        ? fmtNative(h.market_value_local, singleCcy)
                        : `$${(h.market_value_usd||0).toLocaleString('en-US',{ maximumFractionDigits:0 })}`
                      const plDisp = singleCcy
                        ? `+${fmtNative(h.gain_loss_local, singleCcy)}`
                        : `+$${(h.gain_loss_usd||0).toLocaleString('en-US',{ maximumFractionDigits:0 })}`
                      // mask applied below at render
                      return (
                        <tr key={h.id} style={{ borderTop:'1px solid var(--border-soft)' }}>
                          <td style={td}><strong style={{ color:'var(--text-1)' }}>{h.ticker.replace('.NS','').replace('.BO','').replace('.AE','')}</strong>
                            <div style={{ fontSize:'11px', color:'var(--text-4)' }}>{h.currency}</div></td>
                          <td style={{ ...td, textAlign:'right' }}>{mask(valDisp)}</td>
                          <td style={{ ...td, textAlign:'right', color:'#4ade80' }}>{mask(plDisp)}</td>
                          <td style={{ ...td, textAlign:'right', color:'#4ade80' }}>+{h.gain_loss_pct?.toFixed(1)}%</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
            }
          </div>

          <div style={card}>
            <div style={cardTitle}>Top Losers</div>
            {losers.length === 0
              ? <div style={{ color:'var(--text-4)', fontSize:'13px' }}>No losers — all positions are in profit.</div>
              : <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'13px' }}>
                  <thead><tr>
                    <th style={th}>Stock</th>
                    <th style={{ ...th, textAlign:'right' }}>Value</th>
                    <th style={{ ...th, textAlign:'right' }}>P&L</th>
                    <th style={{ ...th, textAlign:'right' }}>Loss%</th>
                  </tr></thead>
                  <tbody>
                    {losers.map(h => {
                      const valDisp = singleCcy
                        ? fmtNative(h.market_value_local, singleCcy)
                        : `$${(h.market_value_usd||0).toLocaleString('en-US',{ maximumFractionDigits:0 })}`
                      const plDisp = singleCcy
                        ? fmtNative(h.gain_loss_local, singleCcy)
                        : `$${(h.gain_loss_usd||0).toLocaleString('en-US',{ maximumFractionDigits:0 })}`
                      return (
                        <tr key={h.id} style={{ borderTop:'1px solid var(--border-soft)' }}>
                          <td style={td}><strong style={{ color:'var(--text-1)' }}>{h.ticker.replace('.NS','').replace('.BO','').replace('.AE','')}</strong>
                            <div style={{ fontSize:'11px', color:'var(--text-4)' }}>{h.currency}</div></td>
                          <td style={{ ...td, textAlign:'right' }}>{mask(valDisp)}</td>
                          <td style={{ ...td, textAlign:'right', color:'#f87171' }}>{mask(plDisp)}</td>
                          <td style={{ ...td, textAlign:'right', color:'#f87171' }}>{h.gain_loss_pct?.toFixed(1)}%</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
            }
          </div>
        </div>

      </>)}

      {/* ════════════════════════════════════════
          ALLOCATION TAB
      ════════════════════════════════════════ */}
      {activeTab === 'allocation' && (<>

        <AllocationCharts
          pieByHolding={pieByHolding}
          byAssetType={byAssetType}
          bySector={bySector}
          summary={summary}
          totalValue={totalValue}
          singleCcy={singleCcy}
        />

        {/* Concentration Heatmap — directly after allocation chart */}
        <ConcentrationHeatmap holdings={filteredH} totalValue={totalValue} />

        {/* Rebalance table — after heatmap */}
        <RebalanceCard holdings={filteredH} totalValue={totalValue} singleCcy={singleCcy} />

      </>)}

    </div>
  )
}

const SH   = '0 1px 2px rgba(0,0,0,0.5), 0 8px 28px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.03) inset'
const card = { background:'var(--bg-card)', borderRadius:'14px', padding:'20px', border:'none', boxShadow:SH }
const cardTitle = {
  fontSize:'11px', fontWeight:700, color:'var(--text-3)',
  textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:'14px',
  display:'flex', alignItems:'center', gap:'8px',
}
const th        = { padding:'6px 10px', color:'var(--text-4)', fontWeight:600, textAlign:'left', fontSize:'12px' }
const td        = { padding:'8px 10px', color:'var(--text-2)' }
