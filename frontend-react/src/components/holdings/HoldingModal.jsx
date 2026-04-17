import { useState, useEffect, useRef } from 'react'
import { addHolding, updateHolding, getBrokers, searchTicker } from '../../api/client'

const VALID_CURRENCIES = ['INR', 'USD', 'AED']

// ── Field-level validators ─────────────────────────────────────────────────
function validate(fields) {
  const errors = {}
  if (!fields.brokerId)
    errors.brokerId = 'Please select a broker.'
  if (!fields.ticker.trim())
    errors.ticker = 'Please search and select a stock.'
  const qty = parseFloat(fields.quantity)
  if (fields.quantity === '' || isNaN(qty))
    errors.quantity = 'Quantity is required.'
  else if (qty <= 0)
    errors.quantity = 'Quantity must be greater than 0.'
  const price = parseFloat(fields.avgPrice)
  if (fields.avgPrice === '' || isNaN(price))
    errors.avgPrice = 'Avg buy price is required.'
  else if (price < 0)
    errors.avgPrice = 'Price cannot be negative.'
  if (!fields.currency)
    errors.currency = 'Please select a currency.'
  return errors
}

// ── TickerSearch — searchable dropdown ────────────────────────────────────
function TickerSearch({ value, displayName, onSelect, error }) {
  const [query,    setQuery]    = useState(displayName || value || '')
  const [results,  setResults]  = useState([])
  const [loading,  setLoading]  = useState(false)
  const [open,     setOpen]     = useState(false)
  const [touched,  setTouched]  = useState(false)
  const debounceRef = useRef()
  const wrapRef     = useRef()

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleChange(e) {
    const q = e.target.value
    setQuery(q)
    setOpen(true)
    clearTimeout(debounceRef.current)
    if (!q.trim()) { setResults([]); return }
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await searchTicker(q)
        setResults(Array.isArray(data) ? data : [])
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 350)   // 350ms debounce — don't hammer the API on every keystroke
  }

  function handleSelect(item) {
    setQuery(`${item.name} (${item.ticker})`)
    setResults([])
    setOpen(false)
    setTouched(true)
    onSelect(item)
  }

  const inputStyle = {
    ...styles.input,
    ...(error && touched ? styles.inputError : {}),
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        style={inputStyle}
        type="text"
        placeholder="Search company name, e.g. Reliance or Apple..."
        value={query}
        onChange={handleChange}
        onFocus={() => { if (results.length > 0) setOpen(true) }}
        onBlur={() => setTouched(true)}
        autoComplete="off"
      />

      {/* Dropdown */}
      {open && (query.trim().length > 0) && (
        <div style={styles.dropdown}>
          {loading && (
            <div style={styles.dropItem}>Searching...</div>
          )}
          {!loading && results.length === 0 && (
            <div style={styles.dropItem}>No results for "{query}"</div>
          )}
          {!loading && results.map(item => (
            <div
              key={item.ticker}
              style={styles.dropItem}
              onMouseDown={() => handleSelect(item)}   // mousedown fires before blur
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={styles.dropTicker}>{item.ticker}</span>
                <span style={styles.dropExchange}>{item.exchange}</span>
              </div>
              <div style={styles.dropName}>{item.name}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main Modal ─────────────────────────────────────────────────────────────
export default function HoldingModal({ holding, onClose }) {
  const isEdit = !!holding

  const [brokers,   setBrokers]   = useState([])
  const [brokerId,     setBrokerId]     = useState(holding?.broker_id     || '')
  const [ticker,       setTicker]       = useState(holding?.ticker         || '')
  const [tickerName,   setTickerName]   = useState(holding?.name           || '')
  const [name,         setName]         = useState(holding?.name           || '')
  const [quantity,     setQuantity]     = useState(holding?.quantity       || '')
  const [avgPrice,     setAvgPrice]     = useState(holding?.avg_buy_price  || '')
  const [currency,     setCurrency]     = useState(holding?.currency       || '')
  const [assetType,    setAssetType]    = useState(holding?.asset_type     || 'stock')
  const [purchaseDate, setPurchaseDate] = useState(holding?.purchase_date  || '')
  const [notes,        setNotes]        = useState(holding?.notes          || '')

  const [errors,    setErrors]    = useState({})
  const [submitErr, setSubmitErr] = useState('')
  const [loading,   setLoading]   = useState(false)
  const [touched,   setTouched]   = useState({})

  useEffect(() => {
    getBrokers().then(data => setBrokers(data))
  }, [])

  function handleBrokerChange(e) {
    const id = e.target.value
    setBrokerId(id)
    const broker = brokers.find(b => b.id === parseInt(id))
    if (broker) setCurrency(broker.currency)
    setTouched(t => ({ ...t, brokerId: true }))
  }

  function handleTickerSelect(item) {
    setTicker(item.ticker)
    setTickerName(item.name)
    setName(item.name)
    // Auto-fill currency from Yahoo Finance result if not already set by broker
    if (!currency && item.currency) {
      const c = item.currency.toUpperCase()
      if (VALID_CURRENCIES.includes(c)) setCurrency(c)
    }
    setTouched(t => ({ ...t, ticker: true }))
  }

  function touch(field) {
    setTouched(t => ({ ...t, [field]: true }))
  }

  // Re-validate whenever relevant fields change
  useEffect(() => {
    if (Object.keys(touched).length === 0) return
    const errs = validate({ brokerId, ticker, quantity, avgPrice, currency })
    const filtered = {}
    for (const k of Object.keys(errs)) {
      if (touched[k]) filtered[k] = errs[k]
    }
    setErrors(filtered)
  }, [brokerId, ticker, quantity, avgPrice, currency, touched])

  async function handleSubmit(e) {
    e.preventDefault()
    setTouched({ brokerId: true, ticker: true, quantity: true, avgPrice: true, currency: true })
    const errs = validate({ brokerId, ticker, quantity, avgPrice, currency })
    setErrors(errs)
    if (Object.keys(errs).length > 0) return

    setLoading(true)
    setSubmitErr('')
    const payload = {
      broker_id:     parseInt(brokerId),
      ticker:        ticker.toUpperCase().trim(),
      name:          name.trim() || ticker.toUpperCase().trim(),
      quantity:      parseFloat(quantity),
      avg_buy_price: parseFloat(avgPrice),
      currency,
      asset_type:    assetType,
      purchase_date: purchaseDate || null,
      notes:         notes.trim(),
    }
    try {
      if (isEdit) await updateHolding(holding.id, payload)
      else        await addHolding(payload)
      onClose()
    } catch {
      setSubmitErr('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  function fieldStyle(field) {
    return { ...styles.input, ...(errors[field] ? styles.inputError : {}) }
  }

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div style={styles.modal}>
        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>{isEdit ? 'Edit Holding' : 'Add Holding'}</h3>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSubmit} style={styles.form} noValidate>

          {/* Broker */}
          <label style={styles.label}>Broker <span style={styles.required}>*</span></label>
          <select style={fieldStyle('brokerId')} value={brokerId} onChange={handleBrokerChange}>
            <option value="">Select broker...</option>
            {brokers.map(b => (
              <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>
            ))}
          </select>
          {errors.brokerId && <span style={styles.fieldError}>{errors.brokerId}</span>}

          {/* Ticker — search */}
          <label style={styles.label}>Stock / ETF <span style={styles.required}>*</span></label>
          <TickerSearch
            value={ticker}
            displayName={tickerName ? `${tickerName} (${ticker})` : ticker}
            onSelect={handleTickerSelect}
            error={errors.ticker}
          />
          {errors.ticker
            ? <span style={styles.fieldError}>{errors.ticker}</span>
            : ticker
              ? <span style={styles.hint}>✓ {ticker} selected</span>
              : <span style={styles.hint}>Type a company name or ticker to search</span>
          }

          {/* Quantity */}
          <label style={styles.label}>Quantity <span style={styles.required}>*</span></label>
          <input
            style={fieldStyle('quantity')}
            type="number"
            placeholder="e.g. 100"
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            onBlur={() => touch('quantity')}
            min="0.001"
            step="any"
          />
          {errors.quantity && <span style={styles.fieldError}>{errors.quantity}</span>}

          {/* Avg buy price */}
          <label style={styles.label}>
            Avg Buy Price {currency ? `(${currency})` : ''} <span style={styles.required}>*</span>
          </label>
          <input
            style={fieldStyle('avgPrice')}
            type="number"
            placeholder="e.g. 2450.50"
            value={avgPrice}
            onChange={e => setAvgPrice(e.target.value)}
            onBlur={() => touch('avgPrice')}
            min="0"
            step="any"
          />
          {errors.avgPrice && <span style={styles.fieldError}>{errors.avgPrice}</span>}

          {/* Purchase Date */}
          <label style={styles.label}>Purchase Date</label>
          <input
            style={styles.input}
            type="date"
            value={purchaseDate}
            onChange={e => setPurchaseDate(e.target.value)}
          />
          <span style={styles.hint}>When you first bought this holding (optional)</span>

          {/* Currency */}
          <label style={styles.label}>Currency <span style={styles.required}>*</span></label>
          <select
            style={fieldStyle('currency')}
            value={currency}
            onChange={e => { setCurrency(e.target.value); touch('currency') }}
          >
            <option value="">Select currency...</option>
            <option value="INR">INR — Indian Rupee</option>
            <option value="USD">USD — US Dollar</option>
            <option value="AED">AED — UAE Dirham</option>
          </select>
          {errors.currency
            ? <span style={styles.fieldError}>{errors.currency}</span>
            : <span style={styles.hint}>Auto-filled from broker. Change only if different.</span>
          }

          {/* Asset Type */}
          <label style={styles.label}>Asset Type</label>
          <select style={styles.input} value={assetType} onChange={e => setAssetType(e.target.value)}>
            <option value="stock">Stock</option>
            <option value="etf">ETF</option>
            <option value="mf">Mutual Fund</option>
          </select>

          {/* Notes / Investment Thesis */}
          <label style={styles.label}>Notes / Investment Thesis</label>
          <textarea
            style={{ ...styles.input, minHeight: '72px', resize: 'vertical', fontFamily: 'inherit' }}
            placeholder="Why you bought this, target price, exit thesis…"
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />

          {submitErr && <p style={styles.submitError}>{submitErr}</p>}

          <button style={styles.submitBtn} type="submit" disabled={loading}>
            {loading ? 'Saving...' : isEdit ? 'Update Holding' : 'Add Holding'}
          </button>

        </form>
      </div>
    </>
  )
}

const styles = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100 },
  modal: {
    position: 'fixed', top: '50%', left: '50%',
    transform: 'translate(-50%, -50%)',
    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
    borderRadius: '12px', padding: '20px', width: '460px',
    maxWidth: 'calc(100vw - 24px)',
    maxHeight: '90dvh', overflowY: 'auto', zIndex: 101,
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  },
  modalHeader: {
    display: 'flex', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: '20px',
  },
  modalTitle: { color: 'var(--text-1)', fontSize: '17px', fontWeight: 600 },
  closeBtn: { background: 'none', border: 'none', color: 'var(--text-3)', fontSize: '18px', cursor: 'pointer' },
  form: { display: 'flex', flexDirection: 'column', gap: '4px' },
  label: { color: 'var(--text-3)', fontSize: '13px', marginTop: '12px' },
  required: { color: 'var(--red)', marginLeft: '2px' },
  input: {
    padding: '10px 12px', background: 'var(--bg-input)',
    border: '1px solid var(--border)', borderRadius: '6px',
    color: 'var(--text-1)', fontSize: '14px', outline: 'none',
    width: '100%', boxSizing: 'border-box',
  },
  inputError: { borderColor: 'var(--red)', background: 'var(--bg-input)' },
  fieldError: { color: 'var(--red)', fontSize: '12px', marginTop: '2px' },
  hint: { color: 'var(--text-4)', fontSize: '11px', marginTop: '2px' },
  submitError: {
    color: 'var(--red)', fontSize: '13px',
    background: 'rgba(251,113,133,0.08)', border: '1px solid rgba(251,113,133,0.2)',
    padding: '8px 12px', borderRadius: '6px', marginTop: '8px',
  },
  submitBtn: {
    marginTop: '20px', padding: '12px',
    background: 'var(--accent)', color: '#0F172A',
    border: 'none', borderRadius: '8px',
    fontSize: '15px', fontWeight: 700, cursor: 'pointer',
  },
  // Dropdown styles
  dropdown: {
    position: 'absolute', top: '100%', left: 0, right: 0,
    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
    borderRadius: '8px', marginTop: '4px',
    zIndex: 200, maxHeight: '260px', overflowY: 'auto',
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  },
  dropItem: {
    padding: '10px 14px', cursor: 'pointer', color: 'var(--text-2)',
    fontSize: '13px', borderBottom: '1px solid var(--border-soft)',
    transition: 'background 0.1s',
  },
  dropTicker: { color: 'var(--accent)', fontWeight: 700, fontSize: '14px' },
  dropExchange: { color: 'var(--text-4)', fontSize: '11px' },
  dropName: { color: 'var(--text-3)', fontSize: '12px', marginTop: '2px' },
}
