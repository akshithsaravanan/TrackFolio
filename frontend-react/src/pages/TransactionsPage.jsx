import { useState, useEffect, useRef } from 'react'
import {
  getTransactions, addTransaction, updateTransaction,
  deleteTransaction, migrateHoldings, getBrokers, getTaxReport, getHoldings,
} from '../api/client'

// ── helpers ────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtPrice(price, currency) {
  if (price == null) return '—'
  if (currency === 'INR') return `₹${price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (currency === 'AED') return `AED ${price.toFixed(2)}`
  return `$${price.toFixed(2)}`
}

function TypeBadge({ type }) {
  const cfg = {
    buy:      { bg: '#4ade8018', border: '#4ade8040', color: '#4ade80', label: 'BUY'      },
    sell:     { bg: '#f8717118', border: '#f8717140', color: '#f87171', label: 'SELL'     },
    dividend: { bg: '#60a5fa18', border: '#60a5fa40', color: '#60a5fa', label: 'DIVIDEND' },
  }
  const c = cfg[type] || cfg.buy
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px', fontSize: '11px',
      fontWeight: 700, letterSpacing: '0.04em',
      background: c.bg, border: `1px solid ${c.border}`, color: c.color,
    }}>{c.label}</span>
  )
}

// ── Ticker typeahead ───────────────────────────────────────
function TickerTypeahead({ value, onChange, onSelect, holdings }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    const handler = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const q = value.toLowerCase()
  const matches = !q ? [] : holdings.filter(h =>
    h.ticker.toLowerCase().includes(q) ||
    (h.name || '').toLowerCase().includes(q)
  ).slice(0, 8)

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        value={value}
        onChange={e => { onChange(e.target.value.toUpperCase()); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder="e.g. BEL or Bharat"
        style={{
          width: '100%', padding: '8px 10px', borderRadius: '7px', fontSize: '13px',
          border: '1px solid var(--border)', background: 'var(--bg-base)',
          color: 'var(--text-1)', outline: 'none', boxSizing: 'border-box',
        }}
      />
      {open && matches.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: '8px', marginTop: '4px', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        }}>
          {matches.map(h => {
            const ticker = h.ticker.replace('.NS','').replace('.BO','').replace('.AE','')
            return (
              <div key={h.ticker} onMouseDown={() => {
                onSelect(h)
                setOpen(false)
              }} style={{
                padding: '9px 14px', cursor: 'pointer', fontSize: '13px',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderBottom: '1px solid var(--border-soft)',
              }}
                onMouseEnter={e => e.currentTarget.style.background='var(--bg-base)'}
                onMouseLeave={e => e.currentTarget.style.background='transparent'}
              >
                <div>
                  <span style={{ fontWeight: 700, color: 'var(--text-1)' }}>{ticker}</span>
                  {h.name && <span style={{ color: 'var(--text-3)', fontSize: '12px', marginLeft: '8px' }}>{h.name}</span>}
                </div>
                <span style={{ fontSize: '11px', color: 'var(--text-4)' }}>{h.currency}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Transaction Modal ──────────────────────────────────────
function TxnModal({ txn, brokers: brokersProp, holdings: holdingsProp, onSave, onClose }) {
  // Safety guards: always work with arrays even if parent passes bad data
  const brokers  = Array.isArray(brokersProp)  ? brokersProp  : []
  const holdings = Array.isArray(holdingsProp) ? holdingsProp : []

  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState(txn || {
    ticker: '', name: '', type: 'buy', quantity: '', price: '',
    currency: 'INR', broker_id: '', trade_date: today, notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function handleSave() {
    if (!form.ticker.trim()) return setErr('Ticker is required')
    if (!form.quantity || Number(form.quantity) <= 0) return setErr('Quantity must be > 0')
    if (form.price === '' || Number(form.price) < 0) return setErr('Price is required')
    if (!form.trade_date) return setErr('Date is required')
    setErr(''); setSaving(true)
    try {
      const payload = {
        ticker:     form.ticker.trim().toUpperCase(),
        name:       form.name.trim() || form.ticker.trim().toUpperCase(),
        type:       form.type,
        quantity:   Number(form.quantity),
        price:      Number(form.price),
        currency:   form.currency,
        broker_id:  form.broker_id ? Number(form.broker_id) : null,
        trade_date: form.trade_date,
        notes:      form.notes,
      }
      if (txn?.id) await updateTransaction(txn.id, payload)
      else         await addTransaction(payload)
      onSave()
    } catch (e) {
      setErr('Save failed — check all fields')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = {
    width: '100%', padding: '8px 10px', borderRadius: '7px', fontSize: '13px',
    border: '1px solid var(--border)', background: 'var(--bg-base)',
    color: 'var(--text-1)', outline: 'none', boxSizing: 'border-box',
  }
  const labelStyle = { fontSize: '11px', color: 'var(--text-3)', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '5px', display: 'block' }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px',
    }}>
      <div style={{
        background: 'var(--bg-elevated)', borderRadius: '14px', padding: '28px',
        width: '100%', maxWidth: '480px', border: '1px solid var(--border)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '22px' }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--text-1)' }}>
            {txn?.id ? 'Edit Transaction' : 'Add Transaction'}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-3)', fontSize: '20px', cursor: 'pointer' }}>×</button>
        </div>

        {/* Type selector */}
        <div style={{ marginBottom: '16px' }}>
          <label style={labelStyle}>Type</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            {['buy','sell','dividend'].map(t => (
              <button key={t} onClick={() => set('type', t)} style={{
                flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px',
                fontWeight: form.type === t ? 700 : 400, cursor: 'pointer', border: '1px solid',
                borderColor: form.type === t
                  ? (t === 'buy' ? '#4ade80' : t === 'sell' ? '#f87171' : '#60a5fa')
                  : 'var(--border)',
                background: form.type === t
                  ? (t === 'buy' ? '#4ade8020' : t === 'sell' ? '#f8717120' : '#60a5fa20')
                  : 'transparent',
                color: form.type === t
                  ? (t === 'buy' ? '#4ade80' : t === 'sell' ? '#f87171' : '#60a5fa')
                  : 'var(--text-3)',
                textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>{t}</button>
            ))}
          </div>
        </div>

        {/* Grid fields */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '14px' }}>
          <div>
            <label style={labelStyle}>Ticker *</label>
            <TickerTypeahead
              value={form.ticker}
              onChange={v => set('ticker', v)}
              onSelect={h => setForm(f => ({
                ...f,
                ticker:   h.ticker,
                name:     h.name || h.ticker,
                currency: h.currency,
              }))}
              holdings={holdings}
            />
          </div>
          <div>
            <label style={labelStyle}>Stock Name</label>
            <input style={inputStyle} value={form.name} placeholder="Optional"
              onChange={e => set('name', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Quantity *</label>
            <input style={inputStyle} type="number" min="0" value={form.quantity}
              placeholder="100" onChange={e => set('quantity', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Price (native) *</label>
            <input style={inputStyle} type="number" min="0" step="0.01" value={form.price}
              placeholder="1450.50" onChange={e => set('price', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Currency</label>
            <select style={inputStyle} value={form.currency} onChange={e => set('currency', e.target.value)}>
              <option value="INR">INR ₹</option>
              <option value="USD">USD $</option>
              <option value="AED">AED</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Date *</label>
            <input style={inputStyle} type="date" value={form.trade_date}
              onChange={e => set('trade_date', e.target.value)} />
          </div>
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label style={labelStyle}>Broker</label>
          <select style={inputStyle} value={form.broker_id || ''} onChange={e => set('broker_id', e.target.value)}>
            <option value="">— None —</option>
            {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={labelStyle}>Notes</label>
          <input style={inputStyle} value={form.notes} placeholder="Optional notes"
            onChange={e => set('notes', e.target.value)} />
        </div>

        {err && <div style={{ color: '#f87171', fontSize: '12px', marginBottom: '12px' }}>{err}</div>}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            padding: '9px 20px', borderRadius: '8px', border: '1px solid var(--border)',
            background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: '13px',
          }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{
            padding: '9px 20px', borderRadius: '8px', border: 'none',
            background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
            opacity: saving ? 0.7 : 1,
          }}>{saving ? 'Saving…' : txn?.id ? 'Update' : 'Add'}</button>
        </div>
      </div>
    </div>
  )
}

// ── Migration Wizard ──────────────────────────────────────
function MigrationBanner({ onDone }) {
  const [date,    setDate]    = useState(new Date(Date.now() - 365*24*60*60*1000).toISOString().slice(0,10))
  const [running, setRunning] = useState(false)
  const [result,  setResult]  = useState(null)

  async function run() {
    setRunning(true)
    try {
      const r = await migrateHoldings(date)
      setResult(r)
      setTimeout(onDone, 2000)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(59,130,246,0.1), rgba(139,92,246,0.1))',
      border: '1px solid rgba(99,102,241,0.3)', borderRadius: '12px', padding: '20px 24px', marginBottom: '20px',
    }}>
      <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-1)', marginBottom: '6px' }}>
        📋 First-time setup — Import existing holdings
      </div>
      <p style={{ color: 'var(--text-3)', fontSize: '13px', margin: '0 0 14px' }}>
        Create BUY records for your current holdings so realized P&amp;L tracking works from day one.
        Pick an approximate buy date (or today to skip history). Tickers already in your ledger are skipped.
      </p>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{
          padding: '7px 10px', borderRadius: '7px', fontSize: '13px',
          border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-1)',
        }} />
        <button onClick={run} disabled={running} style={{
          padding: '8px 18px', borderRadius: '8px', background: 'var(--accent)', color: '#fff',
          border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
          opacity: running ? 0.7 : 1,
        }}>{running ? 'Importing…' : 'Import Holdings as BUY records'}</button>
        <button onClick={onDone} style={{
          padding: '8px 14px', borderRadius: '8px', background: 'transparent', color: 'var(--text-3)',
          border: '1px solid var(--border)', cursor: 'pointer', fontSize: '13px',
        }}>Skip</button>
        {result && (
          <span style={{ color: '#4ade80', fontSize: '13px', fontWeight: 600 }}>
            ✓ Created {result.created} records, skipped {result.skipped}
          </span>
        )}
      </div>
    </div>
  )
}

// ── CSV export ────────────────────────────────────────────
function exportCSV(txns) {
  const headers = ['Date','Type','Ticker','Name','Quantity','Price','Currency','Broker','Notes']
  const rows = txns.map(t => [
    t.trade_date, t.type, t.ticker, t.name,
    t.quantity, t.price, t.currency,
    t.broker_name || '', t.notes || '',
  ])
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a'); a.href = url; a.download = 'transactions.csv'; a.click()
  URL.revokeObjectURL(url)
}

// ════════════════════════════════════════════════════════════
//  PAGE
// ════════════════════════════════════════════════════════════
export default function TransactionsPage() {
  const [txns,       setTxns]       = useState([])
  const [brokers,    setBrokers]    = useState([])
  const [holdings,   setHoldings]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [showModal,  setShowModal]  = useState(false)
  const [editTxn,    setEditTxn]    = useState(null)
  const [filter,     setFilter]     = useState('all')   // all | buy | sell | dividend
  const [showMigrate,setShowMigrate]= useState(false)
  const [delConfirm, setDelConfirm] = useState(null)
  const [showTax,    setShowTax]    = useState(false)
  const [taxData,    setTaxData]    = useState(null)
  const [taxLoading, setTaxLoading] = useState(false)
  const [isMobile,   setIsMobile]   = useState(window.innerWidth <= 768)

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= 768)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  async function load() {
    setLoading(true)
    try {
      const [t, b, h] = await Promise.all([getTransactions(), getBrokers(), getHoldings()])
      // Guard: API errors return objects like {detail:"..."} instead of arrays
      const txnList  = Array.isArray(t)            ? t              : []
      const brkList  = Array.isArray(b)            ? b              : []
      const hldList  = Array.isArray(h?.holdings)  ? h.holdings     : []
      setTxns(txnList)
      setBrokers(brkList)
      setHoldings(hldList)
      if (txnList.length === 0) setShowMigrate(true)
    } catch (err) {
      console.error('TransactionsPage load error:', err)
      // Leave state as empty arrays — page renders empty rather than crashing
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function loadTax() {
    setTaxLoading(true)
    try { setTaxData(await getTaxReport()) }
    finally { setTaxLoading(false) }
  }

  async function handleDelete(id) {
    await deleteTransaction(id)
    setDelConfirm(null)
    load()
  }

  const filtered = filter === 'all' ? txns : txns.filter(t => t.type === filter)

  // Summary stats
  const totalBuys     = txns.filter(t => t.type === 'buy').length
  const totalSells    = txns.filter(t => t.type === 'sell').length
  const totalDivs     = txns.filter(t => t.type === 'dividend').length

  if (loading) return <div style={{ color: 'var(--text-3)', padding: '40px' }}>Loading transactions…</div>

  return (
    <div style={{ color: 'var(--text-1)', display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, marginBottom: '4px' }}>Transactions</h2>
          <p style={{ color: 'var(--text-3)', fontSize: '13px' }}>
            {txns.length} records · {totalBuys} buys · {totalSells} sells · {totalDivs} dividends
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button onClick={() => exportCSV(filtered)} style={outlineBtn}>
            ↓ CSV
          </button>
          <button onClick={() => { loadTax(); setShowTax(true) }} style={outlineBtn}>
            Tax Report
          </button>
          <button onClick={() => { setShowMigrate(true) }} style={outlineBtn}>
            📋 Import Holdings
          </button>
          <button onClick={() => { setEditTxn(null); setShowModal(true) }} style={primaryBtn}>
            + Add Transaction
          </button>
        </div>
      </div>

      {/* Migration banner */}
      {showMigrate && (
        <MigrationBanner onDone={() => { setShowMigrate(false); load() }} />
      )}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: '4px', background: 'var(--bg-elevated)', borderRadius: '9px', padding: '3px', width: 'fit-content' }}>
        {[['all','All'],['buy','Buy'],['sell','Sell'],['dividend','Dividend']].map(([k,l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{
            padding: '5px 14px', borderRadius: '7px', fontSize: '12px', fontWeight: filter === k ? 600 : 400,
            cursor: 'pointer', border: 'none',
            background: filter === k ? 'var(--bg-card)' : 'transparent',
            color: filter === k ? 'var(--text-1)' : 'var(--text-4)',
            transition: 'all 0.15s',
          }}>{l}</button>
        ))}
      </div>

      {/* Table / Cards */}
      {filtered.length === 0
        ? (
          <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-4)' }}>
            <div style={{ fontSize: '36px', marginBottom: '10px' }}>📄</div>
            <div>No transactions yet.</div>
            <div style={{ marginTop: '8px', fontSize: '13px' }}>
              Click <strong>Import Holdings</strong> to seed from your current holdings,
              or <strong>Add Transaction</strong> to record a trade manually.
            </div>
          </div>
        )
        : isMobile
        ? (
          /* ── Mobile card list ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {filtered.map(t => {
              const value = t.quantity * t.price
              const typeBorderColor = t.type === 'buy' ? '#4ade80' : t.type === 'sell' ? '#f87171' : '#60a5fa'
              return (
                <div key={t.id} style={{
                  background: 'var(--bg-card)', borderRadius: '12px',
                  border: '1px solid var(--border)',
                  borderLeft: `3px solid ${typeBorderColor}`,
                  padding: '12px 14px',
                }}>
                  {/* Row 1: ticker + type badge */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                    <div>
                      <span style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-1)' }}>
                        {t.ticker.replace('.NS','').replace('.BO','').replace('.AE','')}
                      </span>
                      {t.name && t.name !== t.ticker && (
                        <div style={{ fontSize: '11px', color: 'var(--text-4)', marginTop: '1px' }}>{t.name}</div>
                      )}
                    </div>
                    <TypeBadge type={t.type} />
                  </div>
                  {/* Row 2: value (prominent) + date */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: 700, fontSize: '16px', color: 'var(--text-1)' }}>
                      {fmtPrice(value, t.currency)}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>{fmtDate(t.trade_date)}</span>
                  </div>
                  {/* Row 3: qty × price + broker + actions */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    paddingTop: '8px', borderTop: '1px solid var(--border-soft)' }}>
                    <span style={{ fontSize: '12px', color: 'var(--text-4)' }}>
                      {t.quantity.toLocaleString('en-IN', { maximumFractionDigits: 4 })} × {fmtPrice(t.price, t.currency)}
                      {t.broker_name ? ` · ${t.broker_name}` : ''}
                    </span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button onClick={() => { setEditTxn(t); setShowModal(true) }} style={iconBtn} title="Edit">✎</button>
                      <button onClick={() => setDelConfirm(t.id)} style={{ ...iconBtn, color: '#f87171' }} title="Delete">✕</button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
        : (
          /* ── Desktop table ── */
          <div style={{ background: 'var(--bg-card)', borderRadius: '12px', border: '1px solid var(--border)', overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '700px' }}>
              <thead>
                <tr style={{ background: 'var(--bg-elevated)', borderBottom: '2px solid var(--accent)' }}>
                  {['Date','Type','Ticker','Qty','Price','Value','Broker','Notes',''].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: h === 'Qty' || h === 'Price' || h === 'Value' ? 'right' : 'left',
                      color: 'var(--text-3)', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase',
                      letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => {
                  const value = t.quantity * t.price
                  return (
                    <tr key={t.id} style={{ borderBottom: '1px solid var(--border-soft)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-base)'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <td style={td}>{fmtDate(t.trade_date)}</td>
                      <td style={td}><TypeBadge type={t.type} /></td>
                      <td style={td}>
                        <span style={{ fontWeight: 700, color: 'var(--text-1)' }}>
                          {t.ticker.replace('.NS','').replace('.BO','').replace('.AE','')}
                        </span>
                        {t.name && t.name !== t.ticker && (
                          <div style={{ fontSize: '11px', color: 'var(--text-4)', marginTop: '1px' }}>{t.name}</div>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>{t.quantity.toLocaleString('en-IN', { maximumFractionDigits: 4 })}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtPrice(t.price, t.currency)}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtPrice(value, t.currency)}</td>
                      <td style={{ ...td, color: 'var(--text-3)', fontSize: '12px' }}>{t.broker_name || '—'}</td>
                      <td style={{ ...td, color: 'var(--text-4)', fontSize: '12px', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.notes || '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button onClick={() => { setEditTxn(t); setShowModal(true) }} style={iconBtn} title="Edit">✎</button>
                        <button onClick={() => setDelConfirm(t.id)} style={{ ...iconBtn, color: '#f87171' }} title="Delete">✕</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      }

      {/* Delete confirm */}
      {delConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg-elevated)', borderRadius: '12px', padding: '28px', maxWidth: '360px', width: '90%', border: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 700, fontSize: '16px', marginBottom: '10px', color: 'var(--text-1)' }}>Delete transaction?</div>
            <div style={{ color: 'var(--text-3)', fontSize: '13px', marginBottom: '20px' }}>This cannot be undone.</div>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button onClick={() => setDelConfirm(null)} style={outlineBtn}>Cancel</button>
              <button onClick={() => handleDelete(delConfirm)} style={{ ...primaryBtn, background: '#ef4444' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Tax Report modal */}
      {showTax && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:'16px', overflowY:'auto' }}>
          <div style={{ background:'var(--bg-elevated)', borderRadius:'14px', padding:'28px', width:'100%', maxWidth:'680px', border:'1px solid var(--border)', maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'20px' }}>
              <div>
                <div style={{ fontWeight:700, fontSize:'16px', color:'var(--text-1)' }}>Tax P&amp;L Report — STCG / LTCG</div>
                <div style={{ fontSize:'12px', color:'var(--text-3)', marginTop:'3px' }}>Indian equity tax rules · FIFO lot matching · Values in ₹</div>
              </div>
              <button onClick={() => setShowTax(false)} style={{ background:'none', border:'none', color:'var(--text-3)', fontSize:'22px', cursor:'pointer' }}>×</button>
            </div>

            {taxLoading && <div style={{ color:'var(--text-3)', padding:'40px', textAlign:'center' }}>Computing…</div>}

            {!taxLoading && taxData && !taxData.has_data && (
              <div style={{ color:'var(--text-4)', textAlign:'center', padding:'40px' }}>
                No sell transactions yet. Record SELL trades to see tax estimates.
              </div>
            )}

            {!taxLoading && taxData?.has_data && (
              <>
                {/* Summary cards */}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:'12px', marginBottom:'24px' }}>
                  {[
                    { label:'STCG Gains', value:`₹${taxData.summary.stcg_total.toLocaleString('en-IN',{maximumFractionDigits:0})}`, color: taxData.summary.stcg_total>=0?'#4ade80':'#f87171', sub:'< 1 year held' },
                    { label:'LTCG Gains', value:`₹${taxData.summary.ltcg_total.toLocaleString('en-IN',{maximumFractionDigits:0})}`, color: taxData.summary.ltcg_total>=0?'#4ade80':'#f87171', sub:'≥ 1 year held' },
                    { label:'STCG Tax @20%', value:`₹${taxData.summary.stcg_tax_inr.toLocaleString('en-IN',{maximumFractionDigits:0})}`, color:'#f59e0b', sub:'Approx. liability' },
                    { label:'LTCG Tax @12.5%', value:`₹${taxData.summary.ltcg_tax_inr.toLocaleString('en-IN',{maximumFractionDigits:0})}`, color:'#f59e0b', sub:`After ₹1.25L exempt` },
                    { label:'Total Tax Est.', value:`₹${taxData.summary.total_tax_inr.toLocaleString('en-IN',{maximumFractionDigits:0})}`, color:'#ef4444', sub:'Consult your CA' },
                  ].map(c => (
                    <div key={c.label} style={{ background:'var(--bg-base)', borderRadius:'10px', padding:'14px' }}>
                      <div style={{ fontSize:'10px', color:'var(--text-4)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:'5px' }}>{c.label}</div>
                      <div style={{ fontSize:'18px', fontWeight:700, color: c.color }}>{c.value}</div>
                      <div style={{ fontSize:'11px', color:'var(--text-4)', marginTop:'2px' }}>{c.sub}</div>
                    </div>
                  ))}
                </div>

                {/* Lot-level table */}
                <div style={{ fontSize:'12px', color:'var(--text-3)', marginBottom:'8px', fontWeight:600 }}>Lot-level breakdown (FIFO)</div>
                <div style={{ overflowX:'auto' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'12px', minWidth:'580px' }}>
                    <thead><tr style={{ background:'var(--bg-elevated)', borderBottom:'2px solid var(--accent)' }}>
                      {['Ticker','Buy Date','Sell Date','Days','Qty','Term','P&L (₹)'].map(h => (
                        <th key={h} style={{ padding:'8px 10px', textAlign: ['Qty','Days','P&L (₹)'].includes(h)?'right':'left', color:'var(--text-3)', fontWeight:600, fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.03em', whiteSpace:'nowrap' }}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {taxData.lots.map((l, i) => (
                        <tr key={i} style={{ borderBottom:'1px solid var(--border-soft)' }}>
                          <td style={{ padding:'8px 10px', fontWeight:700, color:'var(--text-1)' }}>{l.ticker.replace('.NS','').replace('.BO','').replace('.AE','')}</td>
                          <td style={{ padding:'8px 10px', color:'var(--text-3)' }}>{l.buy_date}</td>
                          <td style={{ padding:'8px 10px', color:'var(--text-3)' }}>{l.sell_date}</td>
                          <td style={{ padding:'8px 10px', textAlign:'right', color:'var(--text-3)' }}>{l.days_held}</td>
                          <td style={{ padding:'8px 10px', textAlign:'right', color:'var(--text-2)' }}>{l.qty}</td>
                          <td style={{ padding:'8px 10px' }}>
                            <span style={{ fontSize:'11px', fontWeight:700, padding:'2px 7px', borderRadius:'4px', background: l.term==='STCG'?'#f59e0b20':'#60a5fa20', color: l.term==='STCG'?'#f59e0b':'#60a5fa', border:`1px solid ${l.term==='STCG'?'#f59e0b40':'#60a5fa40'}` }}>{l.term}</span>
                          </td>
                          <td style={{ padding:'8px 10px', textAlign:'right', fontWeight:600, color: l.pl_inr>=0?'#4ade80':'#f87171' }}>
                            {l.pl_inr>=0?'+':''}₹{Math.abs(l.pl_inr).toLocaleString('en-IN',{maximumFractionDigits:0})}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop:'14px', padding:'10px 14px', background:'var(--bg-base)', borderRadius:'8px', fontSize:'11px', color:'var(--text-4)' }}>
                  ⚠ This is an estimate for planning purposes. Rates are FY2024-25 (STCG 20%, LTCG 12.5% above ₹1.25L). Consult a CA for actual tax filing. Non-INR gains are converted at current FX rates.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Add/Edit modal */}
      {showModal && (
        <TxnModal
          txn={editTxn}
          brokers={brokers}
          holdings={holdings}
          onSave={() => { setShowModal(false); setEditTxn(null); load() }}
          onClose={() => { setShowModal(false); setEditTxn(null) }}
        />
      )}
    </div>
  )
}

const td         = { padding: '10px 14px', color: 'var(--text-2)', verticalAlign: 'middle' }
const primaryBtn = { padding: '8px 18px', borderRadius: '8px', background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }
const outlineBtn = { padding: '8px 14px', borderRadius: '8px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: '13px' }
const iconBtn    = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: '14px', padding: '3px 6px', borderRadius: '4px' }
