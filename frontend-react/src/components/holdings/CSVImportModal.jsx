import { useState, useEffect, useRef } from 'react'
import { getBrokers, importCSV } from '../../api/client'

// ── Templates for each broker type ────────────────────────────────────────────
// The key matches the broker name (case-insensitive substring match)

const TEMPLATES = {
  icici: {
    label:    'ICICI Direct (trade history)',
    filename: 'icici_trades_template.csv',
    headers:  'Trade Date,Scrip Code,Scrip Name,Buy/Sell,Quantity,Price,Amount',
    example:  '01/04/2025,RELIANCE,Reliance Industries,Buy,10,2450.50,24505.00\n15/04/2025,INFY,Infosys Ltd,Buy,5,1650.00,8250.00',
    note:     'Export from ICICI Direct → Reports → Trade Book. Date format: DD/MM/YYYY. Ticker = Scrip Code (we add .NS automatically).',
  },
  sbi: {
    label:    'SBI Securities (trade history)',
    filename: 'sbi_trades_template.csv',
    headers:  'Date,Scrip Name,ISIN,Buy/Sell,Quantity,Rate,Amount',
    example:  '01-Apr-2025,RELIANCE,INE002A01018,Buy,10,2450.50,24505.00\n15-Apr-2025,INFY,INE009A01021,Buy,5,1650.00,8250.00',
    note:     'Export from SBI Securities → Reports → Trade History. ISINs are resolved to correct NSE/BSE tickers automatically via Yahoo Finance.',
  },
  cbq: {
    label:    'CBQ Alphatrade (trade history)',
    filename: 'cbq_trades_template.csv',
    headers:  'Date,Symbol,Description,Action,Quantity,Price,Amount',
    example:  '2025-04-01,AAPL,Apple Inc,Buy,5,175.50,877.50\n2025-04-15,VOO,Vanguard S&P 500 ETF,Buy,2,490.00,980.00',
    note:     'Export from CBQ Alphatrade → Account → Transaction History. Date format: YYYY-MM-DD.',
  },
  hsbc: {
    label:    'HSBC WorldTrader (trade history)',
    filename: 'hsbc_trades_template.csv',
    headers:  'Transaction Date,Stock Code,Stock Name,Transaction Type,Units,Price Per Unit,Total Value',
    example:  '01 April 2025,AAPL,Apple Inc,Purchase,5,175.50,877.50\n15 April 2025,VOO,Vanguard S&P 500 ETF,Purchase,2,490.00,980.00',
    note:     'Export from HSBC WorldTrader → Portfolio → Transaction History.',
  },
}

// Standard template — used for any unknown broker
const STANDARD_TEMPLATE = {
  label:    'Standard / Generic template',
  filename: 'holdings_template.csv',
  headers:  'ticker,name,quantity,avg_buy_price,currency',
  example:  'RELIANCE.NS,Reliance Industries,10,2450.50,INR\nAAPL,Apple Inc,5,175.50,USD\nINFY.NS,Infosys Ltd,20,1650.00,INR',
  note:     'One row per holding — not trade history. Enter your current holdings directly. For Indian stocks use NSE ticker with .NS (e.g. RELIANCE.NS) or BSE ticker with .BO.',
}

function getBrokerTemplate(brokerName) {
  const lower = (brokerName || '').toLowerCase()
  for (const [key, template] of Object.entries(TEMPLATES)) {
    if (lower.includes(key)) return template
  }
  return STANDARD_TEMPLATE
}

function downloadCSV(filename, content) {
  const blob = new Blob([content], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CSVImportModal({ onClose }) {
  const [brokers,    setBrokers]    = useState([])
  const [brokerId,   setBrokerId]   = useState('')
  const [file,       setFile]       = useState(null)
  const [replace,    setReplace]    = useState(false)
  const [loading,    setLoading]    = useState(false)
  const [result,     setResult]     = useState(null)   // import result
  const [error,      setError]      = useState('')
  const fileRef = useRef()

  useEffect(() => {
    getBrokers().then(setBrokers)
  }, [])

  const selectedBroker = brokers.find(b => b.id === parseInt(brokerId))
  const template       = selectedBroker ? getBrokerTemplate(selectedBroker.name) : null

  function handleDownload() {
    if (!template) return
    const content = template.headers + '\n' + template.example
    downloadCSV(template.filename, content)
  }

  async function handleUpload(e) {
    e.preventDefault()
    if (!brokerId || !file) return
    setLoading(true)
    setError('')
    setResult(null)

    try {
      const data = await importCSV(parseInt(brokerId), file, replace)
      if (data.detail) {
        setError(data.detail)
      } else {
        setResult(data)
      }
    } catch (err) {
      setError('Upload failed. Check that the backend is running.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div style={styles.backdrop} onClick={!loading ? onClose : undefined} />
      <div style={styles.modal}>

        {/* Header */}
        <div style={styles.header}>
          <h3 style={styles.title}>Import Holdings from CSV</h3>
          <button style={styles.closeBtn} onClick={onClose} disabled={loading}>✕</button>
        </div>

        {/* ── Result view (after successful import) ── */}
        {result ? (
          <div>
            <div style={styles.successBox}>
              ✅ Import complete — <strong>{result.imported}</strong> holdings imported
              {result.skipped > 0 && <>, <strong>{result.skipped}</strong> skipped</>}
              {result.deleted > 0 && <> · <strong>{result.deleted}</strong> old records replaced</>}
            </div>

            {result.holdings?.length > 0 && (
              <table style={styles.resultTable}>
                <thead>
                  <tr>
                    <th style={styles.rth}>Ticker</th>
                    <th style={styles.rth}>Name</th>
                    <th style={styles.rth}>Qty</th>
                    <th style={styles.rth}>Avg Price</th>
                    <th style={styles.rth}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.holdings.map((h, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border-soft)' }}>
                      <td style={styles.rtd}>{h.ticker}</td>
                      <td style={styles.rtd}>{h.name}</td>
                      <td style={styles.rtd}>{h.quantity}</td>
                      <td style={styles.rtd}>{h.avg_buy_price}</td>
                      <td style={{ ...styles.rtd, color: h.action === 'error' ? '#f87171' : '#4ade80' }}>
                        {h.action}
                        {h.error && <div style={{ fontSize: '11px' }}>{h.error}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <button style={styles.submitBtn} onClick={onClose}>Done</button>
          </div>

        ) : (
          /* ── Import form ── */
          <form onSubmit={handleUpload} style={styles.form}>

            {/* Step 1 — Select broker */}
            <div style={styles.step}>
              <div style={styles.stepNum}>1</div>
              <div style={{ flex: 1 }}>
                <div style={styles.stepTitle}>Select Broker</div>
                <select
                  style={styles.input}
                  value={brokerId}
                  onChange={e => setBrokerId(e.target.value)}
                  required
                >
                  <option value="">Select a broker...</option>
                  {brokers.map(b => (
                    <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Step 2 — Download template (only shown after broker selected) */}
            {template && (
              <div style={styles.step}>
                <div style={styles.stepNum}>2</div>
                <div style={{ flex: 1 }}>
                  <div style={styles.stepTitle}>Download Template</div>
                  <div style={styles.templateBox}>
                    <div style={{ fontWeight: 600, color: '#f1f5f9', marginBottom: '4px' }}>{template.label}</div>
                    <div style={{ color: '#64748b', fontSize: '12px', marginBottom: '10px', lineHeight: 1.5 }}>
                      {template.note}
                    </div>
                    <div style={styles.csvPreview}>
                      <span style={{ color: '#60a5fa' }}>{template.headers}</span>{'\n'}
                      <span style={{ color: '#94a3b8' }}>{template.example}</span>
                    </div>
                    <button type="button" style={styles.downloadBtn} onClick={handleDownload}>
                      ⬇ Download {template.filename}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Step 3 — Upload file */}
            <div style={styles.step}>
              <div style={styles.stepNum}>{template ? '3' : '2'}</div>
              <div style={{ flex: 1 }}>
                <div style={styles.stepTitle}>Upload Filled CSV</div>
                <div
                  style={{ ...styles.dropZone, ...(file ? styles.dropZoneActive : {}) }}
                  onClick={() => fileRef.current?.click()}
                >
                  {file
                    ? <><span style={{ color: '#4ade80' }}>✓</span> {file.name}</>
                    : 'Click to choose CSV file'
                  }
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv"
                  style={{ display: 'none' }}
                  onChange={e => setFile(e.target.files[0] || null)}
                />
              </div>
            </div>

            {/* Replace option */}
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', padding: '12px 14px', borderRadius: '8px', border: replace ? '1px solid rgba(245,158,11,0.4)' : '1px solid var(--border)', background: replace ? 'var(--accent-glow)' : 'transparent', transition: 'all 0.2s' }}>
              <input
                type="checkbox"
                checked={replace}
                onChange={e => setReplace(e.target.checked)}
                style={{ marginTop: '2px', accentColor: '#f59e0b', cursor: 'pointer', flexShrink: 0 }}
              />
              <div>
                <div style={{ color: replace ? '#f59e0b' : '#94a3b8', fontSize: '13px', fontWeight: 600 }}>
                  Replace existing holdings
                </div>
                <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px', lineHeight: 1.5 }}>
                  ⚠ Deletes all current holdings for this broker before importing. Use this to fix incorrectly imported data.
                </div>
              </div>
            </label>

            {error && <div style={styles.errorBox}>{error}</div>}

            <button
              style={{ ...styles.submitBtn, opacity: (!brokerId || !file || loading) ? 0.5 : 1, background: replace ? '#b45309' : '#3b82f6' }}
              type="submit"
              disabled={!brokerId || !file || loading}
            >
              {loading ? 'Importing…' : replace ? '⚠ Replace & Import CSV' : 'Import CSV'}
            </button>
          </form>
        )}
      </div>
    </>
  )
}

const styles = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 100 },
  modal: {
    position: 'fixed', top: '50%', left: '50%',
    transform: 'translate(-50%, -50%)',
    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
    borderRadius: '12px', padding: '20px', width: '560px',
    maxWidth: 'calc(100vw - 24px)',
    maxHeight: '90dvh', overflowY: 'auto',
    zIndex: 101, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' },
  title:  { color: 'var(--text-1)', fontSize: '17px', fontWeight: 600 },
  closeBtn: { background: 'none', border: 'none', color: 'var(--text-3)', fontSize: '18px', cursor: 'pointer' },
  form:   { display: 'flex', flexDirection: 'column', gap: '20px' },
  step: {
    display: 'flex', gap: '16px', alignItems: 'flex-start',
  },
  stepNum: {
    width: '26px', height: '26px', borderRadius: '50%',
    background: 'var(--accent)', color: '#0F172A',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '13px', fontWeight: 700, flexShrink: 0, marginTop: '2px',
  },
  stepTitle: { color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' },
  input: {
    padding: '10px 12px', background: 'var(--bg-input)',
    border: '1px solid var(--border)', borderRadius: '6px',
    color: 'var(--text-1)', fontSize: '14px', outline: 'none',
    width: '100%', boxSizing: 'border-box',
  },
  templateBox: {
    background: 'var(--bg-base)', borderRadius: '8px',
    padding: '14px', border: '1px solid var(--border)',
  },
  csvPreview: {
    fontFamily: 'monospace', fontSize: '12px',
    background: 'var(--bg-input)', borderRadius: '4px',
    padding: '10px', marginBottom: '12px',
    whiteSpace: 'pre', overflowX: 'auto',
    border: '1px solid var(--border-soft)',
    color: 'var(--text-2)',
  },
  downloadBtn: {
    padding: '8px 16px', background: 'var(--accent-glow)',
    color: 'var(--accent)', border: '1px solid rgba(245,158,11,0.3)',
    borderRadius: '6px', fontSize: '13px',
    fontWeight: 600, cursor: 'pointer',
  },
  dropZone: {
    border: '2px dashed var(--border)', borderRadius: '8px',
    padding: '20px', textAlign: 'center',
    color: 'var(--text-4)', fontSize: '14px',
    cursor: 'pointer', transition: 'all 0.2s',
  },
  dropZoneActive: {
    borderColor: 'var(--accent)', color: 'var(--text-1)',
    background: 'var(--accent-glow)',
  },
  errorBox: {
    color: 'var(--red)', background: 'rgba(251,113,133,0.08)',
    border: '1px solid rgba(251,113,133,0.2)',
    padding: '10px 14px', borderRadius: '6px',
    fontSize: '13px',
  },
  successBox: {
    color: 'var(--green)', background: 'rgba(52,211,153,0.08)',
    border: '1px solid rgba(52,211,153,0.2)',
    padding: '12px 16px', borderRadius: '8px',
    fontSize: '14px', marginBottom: '16px',
  },
  submitBtn: {
    padding: '12px', background: 'var(--accent)',
    color: '#0F172A', border: 'none',
    borderRadius: '8px', fontSize: '15px',
    fontWeight: 700, cursor: 'pointer',
    width: '100%',
  },
  resultTable: {
    width: '100%', borderCollapse: 'collapse',
    background: 'var(--bg-input)', borderRadius: '8px',
    overflow: 'hidden', marginBottom: '16px',
    fontSize: '13px',
  },
  rth: { padding: '8px 12px', color: 'var(--text-3)', textAlign: 'left', fontWeight: 600, background: 'var(--bg-elevated)' },
  rtd: { padding: '8px 12px', color: 'var(--text-2)' },
}
