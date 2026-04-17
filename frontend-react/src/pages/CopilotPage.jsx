import { useState, useEffect, useMemo } from 'react'
import { getHoldings, getAIAnalytics, askAI } from '../api/client'

// ── Action metadata ────────────────────────────────────────────
const ACT = {
  BUY:    { label: 'BUY MORE', color: '#4ade80', bg: 'linear-gradient(135deg,#4ade8014,#4ade8006)', border: '#4ade8035', icon: '↑' },
  HOLD:   { label: 'HOLD',     color: '#60a5fa', bg: 'linear-gradient(135deg,#60a5fa14,#60a5fa06)', border: '#60a5fa35', icon: '→' },
  REDUCE: { label: 'REDUCE',   color: '#f59e0b', bg: 'linear-gradient(135deg,#f59e0b14,#f59e0b06)', border: '#f59e0b35', icon: '↓' },
  WATCH:  { label: 'WATCH',    color: '#a78bfa', bg: 'linear-gradient(135deg,#a78bfa14,#a78bfa06)', border: '#a78bfa35', icon: '◎' },
}

const SCORE_META = {
  diversification: { label: 'Diversification', color: '#38bdf8', icon: '🌍' },
  momentum:        { label: 'Momentum',         color: '#4ade80', icon: '⚡' },
  risk:            { label: 'Risk Profile',      color: '#f59e0b', icon: '⚠' },
  value:           { label: 'Value Quality',     color: '#a78bfa', icon: '📈' },
}

const SCORE_LABELS = s => s >= 75 ? 'Strong' : s >= 60 ? 'Good' : s >= 40 ? 'Moderate' : 'Weak'

const ASK_CHIPS = [
  ["What's my biggest risk right now?",       '⚠️'],
  ['Which holding has the best momentum?',    '📈'],
  ['Am I over-concentrated in any sector?',   '⚖️'],
  ['What should I do with my weakest stock?', '✂️'],
  ["How's my portfolio doing today?",         '📊'],
  ['Which stock has the worst risk-reward?',  '🎯'],
]

const FOLLOW_UP_MAP = {
  'trim':        ['What should I buy with the proceeds?', 'Show me diversification options'],
  'score':       ['What is the single biggest improvement?', 'How does my risk compare to the market?'],
  'concentrated':['Which sector am I overweight in?',  'Suggest a diversification plan'],
  'improve':     ['Which action has the highest impact?', 'What is a safe rebalance strategy?'],
}

function getFollowUps(question) {
  const q = question.toLowerCase()
  if (q.includes('trim'))         return FOLLOW_UP_MAP.trim
  if (q.includes('score'))        return FOLLOW_UP_MAP.score
  if (q.includes('concentrated')) return FOLLOW_UP_MAP.concentrated
  if (q.includes('improve'))      return FOLLOW_UP_MAP.improve
  return ['Tell me more', 'What should I do next?']
}

// ── Option B: Thick-stroke full-circle progress ring ─────────
function Gauge({ score }) {
  const SIZE   = 156
  const STROKE = 13
  const R      = (SIZE - STROKE) / 2
  const CX     = SIZE / 2
  const CY     = SIZE / 2
  const CIRC   = 2 * Math.PI * R

  const [offset, setOffset] = useState(CIRC)
  const [shown,  setShown]  = useState(0)

  useEffect(() => {
    setOffset(CIRC); setShown(0)
    const t1 = setTimeout(() => setOffset(CIRC - (score / 100) * CIRC), 150)
    let f = 0
    const t2 = setInterval(() => {
      f++; setShown(f >= 60 ? score : Math.round((score / 60) * f))
      if (f >= 60) clearInterval(t2)
    }, 20)
    return () => { clearTimeout(t1); clearInterval(t2) }
  }, [score, CIRC])

  const color = score >= 75 ? '#4ade80' : score >= 50 ? '#f59e0b' : '#f87171'
  const label = score >= 75 ? 'STRONG' : score >= 50 ? 'FAIR' : 'WEAK'

  return (
    <div style={{ position: 'relative', width: SIZE, height: SIZE, flexShrink: 0 }}>
      <svg width={SIZE} height={SIZE}>
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
        <circle cx={CX} cy={CY} r={R} fill="none" stroke={color} strokeWidth={STROKE}
          strokeLinecap="round" strokeDasharray={CIRC} strokeDashoffset={offset}
          transform={`rotate(-90 ${CX} ${CY})`}
          style={{ transition: 'stroke-dashoffset 1.4s cubic-bezier(0.4,0,0.2,1)', filter: `drop-shadow(0 0 6px ${color}70)` }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        <span style={{ fontSize: '34px', fontWeight: 800, lineHeight: 1, color }}>{shown}</span>
        <span style={{ fontSize: '9px', color: 'var(--text-4)', marginTop: '2px', letterSpacing: '0.04em' }}>/ 100</span>
        <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', color, marginTop: '4px', background: `${color}18`, padding: '2px 7px', borderRadius: '6px' }}>{label}</span>
      </div>
    </div>
  )
}

// ── Animated score bar ────────────────────────────────────────
function ScoreBar({ scoreKey, score }) {
  const meta = SCORE_META[scoreKey] || { label: scoreKey, color: '#60a5fa', icon: '' }
  const [w, setW] = useState(0)
  useEffect(() => { const t = setTimeout(() => setW(score), 350); return () => clearTimeout(t) }, [score])
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
        <span style={{ color: 'var(--text-2)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span>{meta.icon}</span>{meta.label}
        </span>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-4)', fontSize: '10px' }}>{SCORE_LABELS(score)}</span>
          <span style={{ color: meta.color, fontWeight: 700, fontSize: '12px' }}>{score}</span>
        </div>
      </div>
      <div style={{ height: '5px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${w}%`, background: meta.color, borderRadius: '3px', boxShadow: `0 0 7px ${meta.color}50`, transition: 'width 1.2s cubic-bezier(0.4,0,0.2,1)' }} />
      </div>
    </div>
  )
}

// ── Native currency formatter ─────────────────────────────────
function fmtNative(value, currency) {
  if (value == null) return '—'
  if (currency === 'INR') return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
  if (currency === 'AED') return `AED ${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

// ── Action card ───────────────────────────────────────────────
function ActionCard({ ticker, action, reason, impact, holding }) {
  const meta  = ACT[action] || ACT.HOLD
  const isPos = (holding?.gain_loss_pct || 0) >= 0
  const impactColor = impact === 'High' ? '#f87171' : impact === 'Medium' ? '#f59e0b' : '#60a5fa'
  // Show value in the holding's native currency
  const valDisplay = holding
    ? holding.currency !== 'USD'
      ? fmtNative(holding.market_value_local, holding.currency)
      : fmtNative(holding.market_value_usd, 'USD')
    : null
  return (
    <div style={{ background: meta.bg, border: `1px solid ${meta.border}`, borderRadius: '12px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '9px', transition: 'transform 0.15s, box-shadow 0.15s' }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 6px 20px ${meta.color}25` }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = '' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '13px', color: meta.color, fontWeight: 800 }}>{meta.icon}</span>
          <span style={{ fontSize: '10px', fontWeight: 800, color: meta.color, background: `${meta.color}20`, padding: '2px 7px', borderRadius: '4px', letterSpacing: '0.05em' }}>{meta.label}</span>
        </div>
        {impact && (
          <span style={{ fontSize: '9px', fontWeight: 700, color: impactColor, background: `${impactColor}18`, padding: '2px 7px', borderRadius: '4px', letterSpacing: '0.04em' }}>
            {impact} impact
          </span>
        )}
      </div>
      <div>
        <div style={{ fontSize: '19px', fontWeight: 800, color: 'var(--text-1)', letterSpacing: '-0.5px' }}>
          {ticker.replace('.NS','').replace('.BO','').replace('.AE','')}
        </div>
        {holding && (
          <div style={{ display: 'flex', gap: '8px', marginTop: '3px', fontSize: '11px', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-3)' }}>{valDisplay}</span>
            {holding.currency !== 'USD' && (
              <span style={{ color: 'var(--text-4)', fontSize: '10px' }}>≈${(holding.market_value_usd || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
            )}
            <span style={{ color: isPos ? '#4ade80' : '#f87171', fontWeight: 600 }}>{isPos ? '+' : ''}{(holding.gain_loss_pct || 0).toFixed(1)}%</span>
          </div>
        )}
      </div>
      <div style={{ color: 'var(--text-3)', fontSize: '11px', lineHeight: 1.5, borderTop: '1px solid var(--border-soft)', paddingTop: '7px' }}>{reason}</div>
    </div>
  )
}

// ── What-if result row ────────────────────────────────────────
function WhatIfRow({ label, value, color, description }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px', borderRadius: '8px', background: 'var(--bg-base)', border: '1px solid var(--border-soft)' }}>
      <div>
        <div style={{ fontSize: '11px', color: 'var(--text-2)', fontWeight: 600 }}>{label}</div>
        {description && <div style={{ fontSize: '10px', color: 'var(--text-4)', marginTop: '2px' }}>{description}</div>}
      </div>
      <span style={{ fontSize: '15px', fontWeight: 800, color, background: `${color}18`, padding: '3px 10px', borderRadius: '6px' }}>
        {value}
      </span>
    </div>
  )
}

// ── Stat tile ─────────────────────────────────────────────────
function StatTile({ label, value, color }) {
  return (
    <div style={{ background: 'var(--bg-base)', borderRadius: '8px', padding: '8px 10px', border: '1px solid var(--border-soft)' }}>
      <div style={{ fontSize: '9px', color: 'var(--text-4)', marginBottom: '3px', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '12px', fontWeight: 700, color }}>{value}</div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
//  PAGE
// ════════════════════════════════════════════════════════════════
const SESSION_KEY = 'copilot_ai_data'

export default function CopilotPage() {
  const [holdings,      setHoldings]      = useState([])
  const [summary,       setSummary]       = useState(null)
  const [pageLoading,   setPageLoading]   = useState(true)
  const [aiData,        setAiData]        = useState(() => {
    // Restore persisted analysis from session storage
    try { const s = sessionStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null } catch { return null }
  })
  const [aiLoading,     setAiLoading]     = useState(false)
  const [aiError,       setAiError]       = useState('')
  const [actFilter,     setActFilter]     = useState('ALL')
  const [showAllActs,   setShowAllActs]   = useState(false)
  const [askQ,          setAskQ]          = useState('')
  const [askA,          setAskA]          = useState('')
  const [askLoading,    setAskLoading]    = useState(false)
  const [followUps,     setFollowUps]     = useState([])
  const [ccyFilter,     setCcyFilter]     = useState('All')  // for Top Opportunity / Risk / Actions
  const [whatIfCcy,     setWhatIfCcy]     = useState('USD')  // display currency for What-If

  // What-if sliders
  const [trimPct,        setTrimPct]        = useState(10)
  const [correctionPct,  setCorrectionPct]  = useState(15)
  const [equalWeight,    setEqualWeight]    = useState(false)

  useEffect(() => {
    getHoldings().then(d => {
      setHoldings(d.holdings || [])
      setSummary(d.summary || null)
    }).finally(() => setPageLoading(false))
  }, [])

  async function runAnalysis() {
    setAiLoading(true); setAiError('')
    try {
      const data = await getAIAnalytics()
      if (data.detail) throw new Error(data.detail)
      if (typeof data.insights === 'object') {
        setAiData(data.insights)
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(data.insights))
      } else throw new Error(data.insights || 'Unexpected response format')
    } catch (err) { setAiError(err.message) }
    finally { setAiLoading(false) }
  }

  function downloadEqualWeightCSV() {
    if (holdings.length === 0) return
    const perStock  = totalValue / holdings.length
    const rows      = [...holdings]
      .sort((a, b) => (b.market_value_usd || 0) - (a.market_value_usd || 0))
      .map(h => {
        const mv        = h.market_value_usd || 0
        const weight    = totalValue > 0 ? (mv / totalValue * 100) : 0
        const diff      = perStock - mv
        const action    = diff > 0 ? 'BUY' : diff < -50 ? 'SELL' : 'HOLD'
        return [
          h.ticker,
          h.name || h.ticker,
          h.currency,
          mv.toFixed(2),
          weight.toFixed(1) + '%',
          perStock.toFixed(2),
          (100 / holdings.length).toFixed(1) + '%',
          diff.toFixed(2),
          action,
        ]
      })
    const header = ['Ticker','Name','Currency','Current Value (USD)','Current Weight','Target Value (USD)','Target Weight','Buy/Sell Amount (USD)','Action']
    const csv    = [header, ...rows].map(r => r.join(',')).join('\n')
    const blob   = new Blob([csv], { type: 'text/csv' })
    const url    = URL.createObjectURL(blob)
    const a      = document.createElement('a')
    a.href = url; a.download = `equal_weight_rebalance_${new Date().toISOString().slice(0,10)}.csv`
    a.click(); URL.revokeObjectURL(url)
  }

  async function handleAsk(q) {
    const question = q || askQ
    if (!question.trim()) return
    setAskQ(question); setAskLoading(true); setAskA(''); setFollowUps([])
    try {
      const data = await askAI(question)
      if (data.detail) throw new Error(data.detail)
      setAskA(data.answer || 'No answer returned.')
      setFollowUps(getFollowUps(question))
    } catch (err) { setAskA(`Error: ${err.message}`) }
    finally { setAskLoading(false) }
  }

  // ── Derived values ────────────────────────────────────────
  const holdingMap = useMemo(
    () => holdings.reduce((m, h) => { m[h.ticker] = h; return m }, {}), [holdings])

  // ── Currency filter ───────────────────────────────────────
  const allCurrencies = useMemo(() => [...new Set(holdings.map(h => h.currency))].sort(), [holdings])

  const ccyFilteredHoldings = useMemo(() =>
    ccyFilter === 'All' ? holdings : holdings.filter(h => h.currency === ccyFilter),
    [holdings, ccyFilter])

  // Recompute star + risk picks for selected currency bucket
  const displayStarTicker = useMemo(() => {
    if (ccyFilter === 'All') return aiData?.star_pick
    const sorted = [...ccyFilteredHoldings].filter(h => h.gain_loss_pct != null)
      .sort((a, b) => (b.gain_loss_pct || 0) - (a.gain_loss_pct || 0))
    return sorted[0]?.ticker ?? null
  }, [ccyFilter, ccyFilteredHoldings, aiData])

  const displayRiskTicker = useMemo(() => {
    if (ccyFilter === 'All') return aiData?.top_risk?.ticker
    const sorted = [...ccyFilteredHoldings].filter(h => h.gain_loss_pct != null)
      .sort((a, b) => (a.gain_loss_pct || 0) - (b.gain_loss_pct || 0))
    return sorted[0]?.ticker ?? null
  }, [ccyFilter, ccyFilteredHoldings, aiData])

  const starHolding = displayStarTicker ? holdingMap[displayStarTicker] : null
  const riskHolding = displayRiskTicker ? holdingMap[displayRiskTicker] : null

  // All actions enriched with holding data; filter by currency tab
  const actionsWithData = useMemo(() => {
    const all = (aiData?.actions || []).map(a => ({ ...a, holding: holdingMap[a.ticker] }))
    return ccyFilter === 'All' ? all : all.filter(a => a.holding?.currency === ccyFilter)
  }, [aiData, holdingMap, ccyFilter])

  // Sort by impact: High first
  const sortedActions = useMemo(() => [...actionsWithData].sort((a, b) => {
    const order = { High: 0, Medium: 1, Low: 2 }
    return (order[a.impact] ?? 2) - (order[b.impact] ?? 2)
  }), [actionsWithData])

  const filteredActions = useMemo(() =>
    actFilter === 'ALL' ? sortedActions : sortedActions.filter(a => a.action === actFilter),
    [sortedActions, actFilter])

  const topActions = filteredActions.slice(0, 4)

  const actionCounts = useMemo(() =>
    actionsWithData.reduce((acc, a) => { acc[a.action] = (acc[a.action] || 0) + 1; return acc }, {}),
    [actionsWithData])

  const contributors = useMemo(() =>
    [...ccyFilteredHoldings].filter(h => (h.gain_loss_usd || 0) > 0).sort((a, b) => b.gain_loss_usd - a.gain_loss_usd).slice(0, 4),
    [ccyFilteredHoldings])
  const detractors = useMemo(() =>
    [...ccyFilteredHoldings].filter(h => (h.gain_loss_usd || 0) < 0).sort((a, b) => a.gain_loss_usd - b.gain_loss_usd).slice(0, 4),
    [ccyFilteredHoldings])

  // ── What-if calcs ─────────────────────────────────────────
  const totalValue = useMemo(() => holdings.reduce((s, h) => s + (h.market_value_usd || 0), 0), [holdings])
  const totalCost  = useMemo(() => holdings.reduce((s, h) => s + (h.cost_basis_usd   || 0), 0), [holdings])
  const currentPnL = totalValue - totalCost

  const whatIfTrim = useMemo(() => {
    const sorted   = [...holdings].sort((a, b) => (a.gain_loss_pct || 0) - (b.gain_loss_pct || 0))
    const cutoff   = Math.floor(sorted.length * (trimPct / 100))
    const remaining = sorted.slice(cutoff)
    const newValue  = remaining.reduce((s, h) => s + (h.market_value_usd || 0), 0)
    const newCost   = remaining.reduce((s, h) => s + (h.cost_basis_usd   || 0), 0)
    const newPnL    = newValue - newCost
    // Heuristic: removing worst performers improves risk score ~2pts per 5% trimmed
    const scoreBoost = Math.round((trimPct / 5) * 2)
    return { pnl: newPnL, delta: newPnL - currentPnL, count: cutoff, scoreBoost }
  }, [holdings, trimPct, currentPnL])

  const whatIfCorrection = useMemo(() => {
    const newValue = totalValue * (1 - correctionPct / 100)
    const newPnL   = newValue - totalCost
    // Heuristic: large correction would hurt momentum score
    const scoreDelta = -Math.round(correctionPct / 5) * 3
    return { value: newValue, pnl: newPnL, delta: newPnL - currentPnL, scoreDelta }
  }, [totalValue, totalCost, correctionPct, currentPnL])

  const whatIfEqual = useMemo(() => {
    if (!equalWeight || holdings.length === 0) return null
    const perStock = totalValue / holdings.length
    const newPnL   = holdings.reduce((s, h) => s + (perStock - (h.cost_basis_usd || 0)), 0)
    // Heuristic: equal weight improves diversification
    const scoreBoost = 6
    return { value: totalValue, pnl: newPnL, delta: newPnL - currentPnL, scoreBoost }
  }, [holdings, equalWeight, totalValue, currentPnL])

  const baseScore = aiData?.health_score ?? null

  if (pageLoading) return (
    <div style={{ color: 'var(--text-3)', padding: '60px', textAlign: 'center', fontSize: '14px' }}>Loading portfolio…</div>
  )

  const score      = aiData?.health_score ?? 0
  const scoreColor = score >= 75 ? '#4ade80' : score >= 50 ? '#f59e0b' : '#f87171'
  const plainSummary = aiData?.plain_summary

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', color: 'var(--text-1)' }}>

      {/* ════ HERO — SCORE + WHY THIS SCORE SIDE BY SIDE ════ */}
      <div className={aiData ? 'copilot-hero' : ''} style={aiData ? {} : { display: 'grid', gap: '16px' }}>

        {/* Left — Score card */}
        <div style={{ ...card, position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse at top right, #8b5cf608 0%, transparent 65%)' }} />

          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: 32, height: 32, borderRadius: '9px', background: 'linear-gradient(135deg,#8b5cf6,#3b82f6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', boxShadow: '0 2px 10px rgba(139,92,246,0.4)' }}>✦</div>
              <div>
                <div style={{ fontWeight: 800, fontSize: '16px', letterSpacing: '-0.3px' }}>Insights</div>
                <div style={{ fontSize: '10px', color: 'var(--text-4)' }}>AI Portfolio Copilot</div>
              </div>
            </div>
            <button onClick={runAnalysis} disabled={aiLoading} style={{
              padding: '8px 18px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
              cursor: aiLoading ? 'default' : 'pointer', border: 'none',
              background: aiLoading ? 'var(--bg-elevated)' : 'linear-gradient(135deg,#8b5cf6,#3b82f6)',
              color: '#fff', opacity: aiLoading ? 0.7 : 1,
              boxShadow: aiLoading ? 'none' : '0 3px 12px rgba(139,92,246,0.4)',
              transition: 'all 0.2s',
            }}>
              {aiLoading ? '⏳ Analysing…' : aiData ? '↻ Re-run' : '✦ Analyse'}
            </button>
          </div>

          {aiData ? (
            <>
              {/* Gauge + verdict row */}
              <div style={{ display: 'flex', gap: '20px', alignItems: 'center', marginBottom: '16px' }}>
                <Gauge score={score} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
                    <span style={{ fontSize: '18px', fontWeight: 800, color: scoreColor }}>{aiData.health_label}</span>
                    {aiData.confidence && (
                      <span style={{ fontSize: '10px', background: 'var(--bg-elevated)', color: 'var(--text-3)', padding: '2px 8px', borderRadius: '10px', border: '1px solid var(--border-soft)' }}>
                        {aiData.confidence}% confidence
                      </span>
                    )}
                  </div>
                  <div style={{ color: 'var(--text-2)', fontSize: '12px', lineHeight: 1.6, fontStyle: 'italic' }}>
                    "{aiData.verdict}"
                  </div>
                </div>
              </div>

              {/* Score breakdown — inline under gauge */}
              {aiData.scores && (
                <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: '14px' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-4)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: '10px' }}>Score Breakdown</div>
                  {Object.keys(SCORE_META).map(k => (
                    <ScoreBar key={k} scoreKey={k} score={aiData.scores[k] ?? 0} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '32px 16px' }}>
              <div style={{ width: 56, height: 56, borderRadius: '16px', margin: '0 auto 16px', background: 'linear-gradient(135deg,#8b5cf620,#3b82f620)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' }}>✦</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-1)', marginBottom: '6px' }}>Ready to analyse</div>
              <div style={{ color: 'var(--text-3)', fontSize: '13px', lineHeight: 1.6 }}>
                {aiLoading ? 'Analyzing your portfolio…' : `Get AI health score and signals for your ${holdings.length} holdings`}
              </div>
            </div>
          )}

          {aiError && (
            <div style={{ marginTop: '12px', color: '#f87171', fontSize: '12px', background: '#f8717112', border: '1px solid #f8717130', borderRadius: '8px', padding: '9px 12px' }}>
              ⚠ {aiError}
            </div>
          )}
        </div>

        {/* Right — Why This Score + Portfolio DNA stacked */}
        {aiData && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* Why This Score */}
            {aiData.score_reasons && (
              <div style={card}>
                <div style={sectionLabel}>Why This Score?</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
                  {(aiData.score_reasons.positives || []).map((p, i) => (
                    <div key={i} style={{ display: 'flex', gap: '10px', fontSize: '13px', lineHeight: 1.55, alignItems: 'flex-start' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#4ade80', flexShrink: 0, marginTop: '5px', boxShadow: '0 0 5px #4ade8060' }} />
                      <span style={{ color: 'var(--text-2)' }}>{p}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid var(--border-soft)', paddingTop: '12px' }}>
                  {(aiData.score_reasons.negatives || []).map((n, i) => (
                    <div key={i} style={{ display: 'flex', gap: '10px', fontSize: '13px', lineHeight: 1.55, alignItems: 'flex-start' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f87171', flexShrink: 0, marginTop: '5px', boxShadow: '0 0 5px #f8717160' }} />
                      <span style={{ color: 'var(--text-2)' }}>{n}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Portfolio DNA — fills empty space in right column */}
            {aiData.portfolio_dna && (
              <div style={{ ...card, border: '1px solid #a78bfa25', background: 'linear-gradient(135deg, var(--bg-card), #a78bfa05)', flex: 1 }}>
                <div style={sectionLabel}>🧬 Portfolio DNA</div>
                <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-1)', marginBottom: '2px' }}>
                  {aiData.portfolio_dna.type}
                </div>
                <div style={{ fontSize: '12px', color: '#a78bfa', fontWeight: 600, fontStyle: 'italic', marginBottom: '14px' }}>
                  "{aiData.portfolio_dna.personality}"
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {(aiData.portfolio_dna.breakdown || []).map((b, i) => (
                    <div key={i} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '10px', padding: '10px 14px', textAlign: 'center', flex: 1, minWidth: '70px' }}>
                      <div style={{ fontSize: '18px', marginBottom: '4px' }}>{b.icon}</div>
                      <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-1)' }}>{b.pct}%</div>
                      <div style={{ fontSize: '10px', color: 'var(--text-3)', marginTop: '2px' }}>{b.label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-4)', textAlign: 'right', marginTop: '14px' }}>
                  For informational use only · Not financial advice
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ════ AI ACTION CENTER ════ */}
      {aiData && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
            <div style={sectionLabel}>AI Action Center</div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {[
                { key: 'ALL',    label: `All (${actionsWithData.length})`,                                        color: 'var(--accent)' },
                { key: 'BUY',    label: `↑ BUY${actionCounts.BUY    ? ` · ${actionCounts.BUY}`    : ''}`,        color: ACT.BUY.color    },
                { key: 'HOLD',   label: `→ HOLD${actionCounts.HOLD   ? ` · ${actionCounts.HOLD}`   : ''}`,       color: ACT.HOLD.color   },
                { key: 'REDUCE', label: `↓ REDUCE${actionCounts.REDUCE ? ` · ${actionCounts.REDUCE}` : ''}`,     color: ACT.REDUCE.color },
                { key: 'WATCH',  label: `◎ WATCH${actionCounts.WATCH  ? ` · ${actionCounts.WATCH}`  : ''}`,      color: ACT.WATCH.color  },
              ].map(f => {
                const active = actFilter === f.key
                return (
                  <button key={f.key} onClick={() => { setActFilter(f.key); setShowAllActs(false) }} style={{
                    padding: '4px 11px', borderRadius: '14px', fontSize: '11px', fontWeight: active ? 700 : 500,
                    cursor: 'pointer', border: active ? `1px solid ${f.color}` : '1px solid var(--border)',
                    background: active ? `${f.color}20` : 'transparent',
                    color: active ? f.color : 'var(--text-3)', transition: 'all 0.15s',
                  }}>{f.label}</button>
                )
              })}
            </div>
          </div>

          {filteredActions.length === 0 ? (
            <div style={{ color: 'var(--text-4)', fontSize: '13px', padding: '8px 0' }}>No {actFilter === 'ALL' ? '' : actFilter} signals.</div>
          ) : (
            <>
              {/* Top picks strip */}
              {!showAllActs && filteredActions.length > 4 && (
                <div style={{ fontSize: '10px', color: 'var(--text-4)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '8px' }}>
                  Top {topActions.length} by impact
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
                {(showAllActs ? filteredActions : topActions).map(a => (
                  <ActionCard key={a.ticker} ticker={a.ticker} action={a.action}
                    reason={a.reason} impact={a.impact} holding={a.holding} />
                ))}
              </div>
              {filteredActions.length > 4 && (
                <button onClick={() => setShowAllActs(v => !v)} style={{
                  marginTop: '12px', width: '100%', padding: '8px', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-3)', fontSize: '12px', cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#8b5cf6'; e.currentTarget.style.color = '#a78bfa' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-3)' }}
                >
                  {showAllActs ? `▲ Show top 4 only` : `▼ Show all ${filteredActions.length} signals`}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* ════ THREE-COLUMN ROW: Opportunity | Risk | Performance ════ */}
      {aiData && (
        <div>
          {/* Currency filter tabs */}
          {allCurrencies.length > 1 && (
            <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', color: 'var(--text-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: '4px' }}>View by:</span>
              {['All', ...allCurrencies].map(c => {
                const CCY_COLORS = { USD: '#3b82f6', INR: '#f59e0b', AED: '#10b981' }
                const color = CCY_COLORS[c] || 'var(--accent)'
                const active = ccyFilter === c
                return (
                  <button key={c} onClick={() => { setCcyFilter(c); setActFilter('ALL'); setShowAllActs(false) }} style={{
                    padding: '4px 14px', borderRadius: '16px', fontSize: '12px',
                    fontWeight: active ? 700 : 500, cursor: 'pointer',
                    border: active ? `1px solid ${color}` : '1px solid var(--border)',
                    background: active ? `${color}20` : 'transparent',
                    color: active ? color : 'var(--text-3)', transition: 'all 0.15s',
                  }}>{c}</button>
                )
              })}
            </div>
          )}
        <div className="copilot-3col">

          {/* Top Opportunity */}
          {(() => {
            // Only show AI tech breakdown for the overall pick; for currency-filtered, just show the holding
            const tech = ccyFilter === 'All' ? aiData.star_pick_tech : null
            const rsiColor = tech?.rsi != null
              ? (tech.rsi >= 45 && tech.rsi <= 65 ? '#4ade80' : tech.rsi > 75 ? '#f87171' : '#f59e0b')
              : 'var(--text-3)'
            return (
              <div style={{ ...card, border: '1px solid #4ade8030', background: 'linear-gradient(160deg, var(--bg-card) 55%, #4ade8006)' }}>
                <div style={sectionLabel}>⭐ Top Opportunity{ccyFilter !== 'All' ? ` · ${ccyFilter}` : ''}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '10px' }}>
                  <div style={{ fontSize: '26px', fontWeight: 800, color: 'var(--text-1)', letterSpacing: '-1px' }}>
                    {displayStarTicker?.replace('.NS','').replace('.BO','').replace('.AE','')}
                  </div>
                  {tech?.score != null && (
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#4ade80', background: '#4ade8018', padding: '2px 8px', borderRadius: '6px' }}>
                      Tech {tech.score.toFixed(0)}/100
                    </div>
                  )}
                </div>

                {/* Tech signal pills */}
                {tech && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '12px' }}>
                    {tech.ret_30d != null && (
                      <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px',
                        background: tech.ret_30d >= 0 ? '#4ade8018' : '#f8717118',
                        color: tech.ret_30d >= 0 ? '#4ade80' : '#f87171', fontWeight: 600 }}>
                        30d {tech.ret_30d >= 0 ? '+' : ''}{tech.ret_30d.toFixed(1)}%
                      </span>
                    )}
                    {tech.ret_90d != null && (
                      <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px',
                        background: tech.ret_90d >= 0 ? '#4ade8018' : '#f8717118',
                        color: tech.ret_90d >= 0 ? '#4ade80' : '#f87171', fontWeight: 600 }}>
                        90d {tech.ret_90d >= 0 ? '+' : ''}{tech.ret_90d.toFixed(1)}%
                      </span>
                    )}
                    {tech.ma_signal && (
                      <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px',
                        background: tech.ma_signal.includes('above') ? '#3b82f618' : '#f8717118',
                        color: tech.ma_signal.includes('above') ? '#60a5fa' : '#f87171', fontWeight: 600 }}>
                        {tech.ma_signal}
                      </span>
                    )}
                    {tech.rsi != null && (
                      <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px',
                        background: `${rsiColor}18`, color: rsiColor, fontWeight: 600 }}>
                        RSI {tech.rsi.toFixed(0)}
                      </span>
                    )}
                    {tech.vol != null && (
                      <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '6px',
                        background: 'var(--bg-elevated)', color: 'var(--text-3)', fontWeight: 600 }}>
                        Vol {tech.vol.toFixed(1)}%
                      </span>
                    )}
                  </div>
                )}

                {starHolding && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px', marginBottom: '12px' }}>
                    <StatTile label="Market Value"
                      value={starHolding.currency !== 'USD'
                        ? fmtNative(starHolding.market_value_local, starHolding.currency)
                        : `$${(starHolding.market_value_usd || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
                      color="var(--text-1)" />
                    <StatTile label="Overall Return"
                      value={`${(starHolding.gain_loss_pct || 0) >= 0 ? '+' : ''}${(starHolding.gain_loss_pct || 0).toFixed(1)}%`}
                      color={(starHolding.gain_loss_pct || 0) >= 0 ? '#4ade80' : '#f87171'} />
                  </div>
                )}

                <div style={{ color: 'var(--text-4)', fontSize: '11px', lineHeight: 1.6, borderTop: '1px solid var(--border-soft)', paddingTop: '10px' }}>
                  {ccyFilter === 'All'
                    ? `Score = 60% technical momentum + 40% overall return.${tech?.overall_return != null ? ` Overall: ${tech.overall_return >= 0 ? '+' : ''}${tech.overall_return.toFixed(1)}%.` : ''}`
                    : `Best performer in ${ccyFilter} holdings by overall return%.`}
                </div>
              </div>
            )
          })()}

          {/* Top Risk */}
          {displayRiskTicker && (
            <div style={{ ...card, border: '1px solid #f8717130', background: 'linear-gradient(160deg, var(--bg-card) 55%, #f8717106)' }}>
              <div style={sectionLabel}>⚠ Top Risk{ccyFilter !== 'All' ? ` · ${ccyFilter}` : ''}</div>
              <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--text-1)', letterSpacing: '-1px', marginBottom: '6px' }}>
                {displayRiskTicker.replace('.NS','').replace('.BO','').replace('.AE','')}
              </div>
              {riskHolding && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px', marginBottom: '12px' }}>
                  <StatTile label="Market Value"
                    value={riskHolding.currency !== 'USD'
                      ? fmtNative(riskHolding.market_value_local, riskHolding.currency)
                      : `$${(riskHolding.market_value_usd || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
                    color="var(--text-1)" />
                  <StatTile label="Return"
                    value={`${(riskHolding.gain_loss_pct || 0) >= 0 ? '+' : ''}${(riskHolding.gain_loss_pct || 0).toFixed(1)}%`}
                    color={(riskHolding.gain_loss_pct || 0) >= 0 ? '#4ade80' : '#f87171'} />
                </div>
              )}
              {/* Show AI reasons only for overall (All) pick; for currency-filtered just show the holding data */}
              {ccyFilter === 'All' && aiData.top_risk && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: aiData.top_risk.consequence ? '12px' : 0 }}>
                    {(aiData.top_risk.reasons || []).map((r, i) => (
                      <div key={i} style={{ display: 'flex', gap: '8px', fontSize: '12px', color: 'var(--text-2)', lineHeight: 1.5 }}>
                        <span style={{ color: '#f87171', flexShrink: 0, fontWeight: 800 }}>✗</span>{r}
                      </div>
                    ))}
                  </div>
                  {(aiData.top_risk.consequence || []).length > 0 && (
                    <div style={{ borderTop: '1px solid #f8717120', paddingTop: '10px', marginTop: '8px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: '#f87171', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '7px' }}>If unchanged:</div>
                      {aiData.top_risk.consequence.map((c, i) => (
                        <div key={i} style={{ display: 'flex', gap: '7px', fontSize: '11px', color: 'var(--text-3)', lineHeight: 1.5, marginBottom: '4px' }}>
                          <span style={{ color: '#f59e0b', flexShrink: 0 }}>→</span>{c}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {ccyFilter !== 'All' && riskHolding && (
                <div style={{ fontSize: '11px', color: 'var(--text-4)', borderTop: '1px solid var(--border-soft)', paddingTop: '10px' }}>
                  Worst performer in {ccyFilter} holdings by overall return%.
                </div>
              )}
            </div>
          )}

          {/* Performance Drivers */}
          <div style={card}>
            <div style={sectionLabel}>Performance Drivers</div>
            {contributors.length > 0 && (
              <>
                <div style={{ fontSize: '10px', color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>Top Contributors</div>
                {contributors.map(h => (
                  <div key={h.ticker} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ color: 'var(--text-1)', fontWeight: 700, fontSize: '12px' }}>{h.ticker}</span>
                    <div style={{ display: 'flex', gap: '8px', fontSize: '11px' }}>
                      <span style={{ color: '#4ade80', fontWeight: 700 }}>+${(h.gain_loss_usd || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                      <span style={{ color: 'var(--text-4)' }}>{(h.gain_loss_pct || 0).toFixed(1)}%</span>
                    </div>
                  </div>
                ))}
              </>
            )}
            {detractors.length > 0 && (
              <>
                <div style={{ fontSize: '10px', color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '10px 0 8px', borderTop: '1px solid var(--border-soft)', paddingTop: '10px' }}>Top Detractors</div>
                {detractors.map(h => (
                  <div key={h.ticker} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ color: 'var(--text-1)', fontWeight: 700, fontSize: '12px' }}>{h.ticker}</span>
                    <div style={{ display: 'flex', gap: '8px', fontSize: '11px' }}>
                      <span style={{ color: '#f87171', fontWeight: 700 }}>${(h.gain_loss_usd || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                      <span style={{ color: 'var(--text-4)' }}>{(h.gain_loss_pct || 0).toFixed(1)}%</span>
                    </div>
                  </div>
                ))}
              </>
            )}
            {contributors.length === 0 && detractors.length === 0 && (
              <div style={{ color: 'var(--text-4)', fontSize: '13px' }}>No P&L data available.</div>
            )}
          </div>
        </div>
        </div>
      )}

      {/* ════ EXPLAIN IT SIMPLY — structured ════ */}
      {aiData && plainSummary && typeof plainSummary === 'object' && (
        <div style={{ ...card, border: '1px solid #3b82f625', background: 'linear-gradient(135deg, var(--bg-card), #3b82f604)' }}>
          <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
            <div style={{ width: 36, height: 36, borderRadius: '10px', flexShrink: 0, background: 'linear-gradient(135deg,#3b82f620,#8b5cf620)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px' }}>💬</div>
            <div style={{ flex: 1 }}>
              <div style={{ ...sectionLabel, marginBottom: '12px' }}>Explain It Simply</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', marginBottom: '12px' }}>
                {(plainSummary.strong || []).length > 0 && (
                  <div style={{ background: '#4ade8010', border: '1px solid #4ade8025', borderRadius: '8px', padding: '10px 12px' }}>
                    <div style={{ fontSize: '10px', color: '#4ade80', fontWeight: 700, letterSpacing: '0.06em', marginBottom: '6px' }}>✔ STRONG</div>
                    {plainSummary.strong.map((s, i) => <div key={i} style={{ fontSize: '12px', color: 'var(--text-2)', marginBottom: '3px' }}>{s}</div>)}
                  </div>
                )}
                {(plainSummary.weak || []).length > 0 && (
                  <div style={{ background: '#f8717110', border: '1px solid #f8717125', borderRadius: '8px', padding: '10px 12px' }}>
                    <div style={{ fontSize: '10px', color: '#f87171', fontWeight: 700, letterSpacing: '0.06em', marginBottom: '6px' }}>⚠ WEAK</div>
                    {plainSummary.weak.map((w, i) => <div key={i} style={{ fontSize: '12px', color: 'var(--text-2)', marginBottom: '3px' }}>{w}</div>)}
                  </div>
                )}
                {(plainSummary.issues || []).length > 0 && (
                  <div style={{ background: '#f59e0b10', border: '1px solid #f59e0b25', borderRadius: '8px', padding: '10px 12px' }}>
                    <div style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 700, letterSpacing: '0.06em', marginBottom: '6px' }}>⚠ ISSUE</div>
                    {plainSummary.issues.map((iss, i) => <div key={i} style={{ fontSize: '12px', color: 'var(--text-2)', marginBottom: '3px' }}>{iss}</div>)}
                  </div>
                )}
              </div>
              {plainSummary.action && (
                <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', background: 'var(--bg-elevated)', borderRadius: '8px', padding: '10px 12px', border: '1px solid var(--border-soft)' }}>
                  <span style={{ fontSize: '14px' }}>👉</span>
                  <span style={{ fontSize: '13px', color: 'var(--text-1)', fontWeight: 600, lineHeight: 1.5 }}>{plainSummary.action}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Fallback: if AI returned plain_summary as string (old format) */}
      {aiData && plainSummary && typeof plainSummary === 'string' && (
        <div style={{ ...card, border: '1px solid #3b82f625' }}>
          <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
            <div style={{ fontSize: '20px' }}>💬</div>
            <div>
              <div style={{ ...sectionLabel, marginBottom: '8px' }}>Explain It Simply</div>
              <p style={{ color: 'var(--text-2)', fontSize: '14px', lineHeight: 1.8, margin: 0 }}>{plainSummary}</p>
            </div>
          </div>
        </div>
      )}

      {/* ════ WHAT-IF SIMULATOR ════ */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={sectionLabel}>What-If Simulator</div>
            <span style={{ fontSize: '10px', background: '#38bdf818', color: '#38bdf8', padding: '2px 8px', borderRadius: '8px', fontWeight: 700, letterSpacing: '0.04em' }}>LIVE</span>
          </div>
          {/* Currency display toggle */}
          <div style={{ display: 'flex', gap: '3px', background: 'var(--bg-base)', borderRadius: '6px', padding: '2px' }}>
            {['USD', ...allCurrencies.filter(c => c !== 'USD')].map(c => (
              <button key={c} onClick={() => setWhatIfCcy(c)} style={{
                padding: '3px 10px', borderRadius: '5px', fontSize: '11px', fontWeight: 600,
                cursor: 'pointer', border: 'none',
                background: whatIfCcy === c ? 'var(--bg-elevated)' : 'transparent',
                color: whatIfCcy === c ? 'var(--text-1)' : 'var(--text-4)',
                transition: 'all 0.15s',
              }}>{c}</button>
            ))}
          </div>
        </div>

        {/* What-if currency conversion helper */}
        {(() => {
          const fx = summary?.fx_rates || {}
          const toDisplay = (usdVal) => {
            if (!usdVal && usdVal !== 0) return '—'
            if (whatIfCcy === 'INR' && fx.INR) return fmtNative(usdVal * fx.INR, 'INR')
            if (whatIfCcy === 'AED' && fx.AED) return fmtNative(usdVal * fx.AED, 'AED')
            return `$${Math.abs(usdVal).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
          }
          const sign = (v) => v >= 0 ? '+' : ''

          return (
            <div className="copilot-scenarios">

              {/* Scenario A — Trim */}
              <div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-2)', marginBottom: '3px' }}>A · Trim Bottom Performers</div>
                <div style={{ fontSize: '11px', color: 'var(--text-4)', marginBottom: '10px' }}>Remove bottom {trimPct}% by return ({whatIfTrim.count} stocks)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                  <input type="range" min={0} max={30} step={5} value={trimPct} onChange={e => setTrimPct(+e.target.value)} style={{ flex: 1, accentColor: '#f59e0b', cursor: 'pointer' }} />
                  <span style={{ minWidth: 28, fontWeight: 700, color: '#f59e0b', fontSize: '12px' }}>{trimPct}%</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <WhatIfRow label="New P&L" value={toDisplay(whatIfTrim.pnl)}
                    color={whatIfTrim.pnl >= 0 ? '#4ade80' : '#f87171'}
                    description={`P&L change: ${sign(whatIfTrim.delta)}${toDisplay(whatIfTrim.delta)}`} />
                  {baseScore && <WhatIfRow label="Est. Score Impact" value={`${baseScore} → ~${baseScore + whatIfTrim.scoreBoost}`} color="#38bdf8" description="Risk score improves" />}
                </div>
              </div>

              {/* Scenario B — Correction */}
              <div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-2)', marginBottom: '3px' }}>B · Market Correction</div>
                <div style={{ fontSize: '11px', color: 'var(--text-4)', marginBottom: '10px' }}>If all holdings drop by {correctionPct}%</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                  <input type="range" min={5} max={40} step={5} value={correctionPct} onChange={e => setCorrectionPct(+e.target.value)} style={{ flex: 1, accentColor: '#f87171', cursor: 'pointer' }} />
                  <span style={{ minWidth: 36, fontWeight: 700, color: '#f87171', fontSize: '12px' }}>-{correctionPct}%</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <WhatIfRow label="Estimated Loss" value={toDisplay(whatIfCorrection.delta)}
                    color="#f87171"
                    description={`New portfolio value: ${toDisplay(whatIfCorrection.value)}`} />
                  {baseScore && <WhatIfRow label="Est. Score Impact" value={`${baseScore} → ~${Math.max(0, baseScore + whatIfCorrection.scoreDelta)}`} color="#f59e0b" description="Momentum score drops" />}
                </div>
              </div>

              {/* Scenario C — Equal weight */}
              <div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-2)', marginBottom: '3px' }}>C · Equal-Weight Rebalance</div>
                <div style={{ fontSize: '11px', color: 'var(--text-4)', marginBottom: '10px' }}>Redistribute evenly across {holdings.length} holdings</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                  <div onClick={() => setEqualWeight(v => !v)} style={{ width: 42, height: 22, borderRadius: '11px', position: 'relative', cursor: 'pointer', background: equalWeight ? '#38bdf8' : 'var(--border)', transition: 'background 0.2s' }}>
                    <div style={{ position: 'absolute', top: 2, left: equalWeight ? 21 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.3)', transition: 'left 0.2s' }} />
                  </div>
                  <span style={{ fontSize: '12px', color: equalWeight ? '#38bdf8' : 'var(--text-3)', fontWeight: 600 }}>{equalWeight ? 'On' : 'Off'}</span>
                </div>
                {whatIfEqual ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <WhatIfRow label="Rebalanced P&L" value={toDisplay(whatIfEqual.pnl)}
                      color={whatIfEqual.pnl >= 0 ? '#4ade80' : '#f87171'}
                      description={`Change: ${sign(whatIfEqual.delta)}${toDisplay(whatIfEqual.delta)}`} />
                    {baseScore && <WhatIfRow label="Est. Score Impact" value={`${baseScore} → ~${baseScore + whatIfEqual.scoreBoost}`} color="#38bdf8" description="Diversification improves" />}
                    <button onClick={downloadEqualWeightCSV} style={{
                      marginTop: '4px', padding: '8px 12px', borderRadius: '8px', fontSize: '11px',
                      fontWeight: 700, cursor: 'pointer', border: '1px solid #38bdf840',
                      background: '#38bdf810', color: '#38bdf8', transition: 'all 0.15s',
                      display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center',
                    }}
                      onMouseEnter={e => e.currentTarget.style.background = '#38bdf820'}
                      onMouseLeave={e => e.currentTarget.style.background = '#38bdf810'}
                    >
                      ↓ Download Rebalance Plan (CSV)
                    </button>
                  </div>
                ) : (
                  <div style={{ padding: '9px 12px', borderRadius: '8px', background: 'var(--bg-base)', border: '1px solid var(--border-soft)', color: 'var(--text-4)', fontSize: '12px' }}>Toggle on to simulate</div>
                )}
              </div>
            </div>
          )
        })()}
      </div>

      {/* ════ ASK AI ════ */}
      <div style={card}>
        <div style={sectionLabel}>Ask AI About Your Portfolio</div>

        {/* 2×3 chip grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '14px' }}>
          {ASK_CHIPS.map(([chip, icon]) => (
            <button key={chip} onClick={() => handleAsk(chip)} disabled={askLoading} style={{
              padding: '10px 12px', borderRadius: '9px', fontSize: '12px', cursor: askLoading ? 'default' : 'pointer',
              border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-2)',
              textAlign: 'left', display: 'flex', gap: '8px', alignItems: 'center',
              transition: 'all 0.15s', opacity: askLoading ? 0.5 : 1, lineHeight: 1.4,
            }}
              onMouseEnter={e => { if (!askLoading) { e.currentTarget.style.borderColor = '#8b5cf6'; e.currentTarget.style.color = '#a78bfa' } }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-2)' }}
            >
              <span style={{ fontSize: '14px', flexShrink: 0 }}>{icon}</span><span>{chip}</span>
            </button>
          ))}
        </div>

        {/* Input row */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <input value={askQ} onChange={e => setAskQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAsk()}
            placeholder="Ask anything about your portfolio…"
            style={{ flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px', color: 'var(--text-1)', fontSize: '13px', outline: 'none' }}
          />
          <button onClick={() => handleAsk()} disabled={askLoading || !askQ.trim()} style={{
            padding: '10px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
            cursor: askLoading || !askQ.trim() ? 'default' : 'pointer', border: 'none',
            background: askLoading || !askQ.trim() ? 'var(--bg-elevated)' : 'linear-gradient(135deg,#8b5cf6,#3b82f6)',
            color: '#fff', opacity: askLoading || !askQ.trim() ? 0.5 : 1, transition: 'all 0.2s', whiteSpace: 'nowrap',
          }}>{askLoading ? '⏳' : 'Ask →'}</button>
        </div>

        {/* Thinking indicator */}
        {askLoading && (
          <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', background: 'var(--bg-input)', borderRadius: '8px', borderLeft: '3px solid #8b5cf6' }}>
            <div style={{ display: 'flex', gap: '3px' }}>
              {[0, 1, 2].map(i => (
                <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: '#8b5cf6', display: 'inline-block', animation: `pulse 1.2s ${i * 0.2}s infinite` }} />
              ))}
            </div>
            <span style={{ color: 'var(--text-3)', fontSize: '12px' }}>Analyzing your portfolio…</span>
          </div>
        )}

        {/* Answer */}
        {askA && !askLoading && (
          <div style={{ marginTop: '12px', background: 'var(--bg-input)', borderRadius: '10px', padding: '14px 16px', borderLeft: '3px solid #8b5cf6' }}>
            <div style={{ fontSize: '10px', color: '#a78bfa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '8px' }}>AI Response</div>
            <div style={{ color: 'var(--text-1)', fontSize: '14px', lineHeight: 1.75 }}>{askA}</div>

            {/* Follow-up chips */}
            {followUps.length > 0 && (
              <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border-soft)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-4)', marginBottom: '7px' }}>Continue exploring:</div>
                <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
                  {followUps.map(q => (
                    <button key={q} onClick={() => handleAsk(q)} style={{
                      padding: '5px 12px', borderRadius: '14px', fontSize: '11px', cursor: 'pointer',
                      border: '1px solid #8b5cf640', background: '#8b5cf610', color: '#a78bfa',
                      transition: 'all 0.15s',
                    }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#8b5cf620' }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#8b5cf610' }}
                    >→ {q}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>


      {/* ════ DISCLAIMER ════ */}
      <div style={{ textAlign: 'center', color: 'var(--text-4)', fontSize: '11px', paddingBottom: '8px' }}>
        AI insights are model-generated and for informational purposes only. They do not constitute financial advice. Always do your own research.
      </div>

      <style>{`@keyframes pulse { 0%,80%,100%{transform:scale(0.6);opacity:0.5} 40%{transform:scale(1);opacity:1} }`}</style>
    </div>
  )
}

// ── Shared styles ─────────────────────────────────────────────
const card = {
  background: 'var(--bg-card)', borderRadius: '14px',
  padding: '20px', border: '1px solid var(--border)',
  boxShadow: 'var(--shadow)',
}
const sectionLabel = {
  fontSize: '10px', fontWeight: 700, color: 'var(--text-3)',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '14px',
}
