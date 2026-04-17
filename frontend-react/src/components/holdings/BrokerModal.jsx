import { useState } from 'react'
import { addBroker } from '../../api/client'

export default function BrokerModal({ onClose }) {
  const [name,     setName]     = useState('')
  const [currency, setCurrency] = useState('INR')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      await addBroker({ name: name.trim(), currency })
      onClose()
    } catch (err) {
      setError('Could not create broker. Please try again.')
      setLoading(false)
    }
  }

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div style={styles.modal}>
        <div style={styles.header}>
          <h3 style={styles.title}>Add Broker / Account</h3>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <p style={styles.hint}>
          A broker is an account where you hold stocks — e.g. ICICI Direct (INR), CBQ (USD), Interactive Brokers (USD).
        </p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>Broker / Account Name</label>
          <input
            style={styles.input}
            type="text"
            placeholder="e.g. ICICI Direct"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            autoFocus
          />

          <label style={styles.label}>Default Currency</label>
          <select style={styles.input} value={currency} onChange={e => setCurrency(e.target.value)}>
            <option value="INR">INR — Indian Rupee</option>
            <option value="USD">USD — US Dollar</option>
            <option value="AED">AED — UAE Dirham</option>
          </select>

          {error && <p style={styles.error}>{error}</p>}

          <button style={styles.submitBtn} type="submit" disabled={loading}>
            {loading ? 'Creating...' : 'Create Broker'}
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
    borderRadius: '12px', padding: '20px', width: '400px',
    maxWidth: 'calc(100vw - 24px)',
    zIndex: 101, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  title:  { color: 'var(--text-1)', fontSize: '17px', fontWeight: 600 },
  closeBtn: { background: 'none', border: 'none', color: 'var(--text-3)', fontSize: '18px', cursor: 'pointer' },
  hint: { color: 'var(--text-4)', fontSize: '13px', marginBottom: '20px', lineHeight: 1.5 },
  form:  { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { color: 'var(--text-3)', fontSize: '13px', marginTop: '10px' },
  input: {
    padding: '10px 12px', background: 'var(--bg-input)',
    border: '1px solid var(--border)', borderRadius: '6px',
    color: 'var(--text-1)', fontSize: '14px', outline: 'none',
    width: '100%', boxSizing: 'border-box',
  },
  error: { color: 'var(--red)', fontSize: '13px', background: 'rgba(251,113,133,0.08)', border: '1px solid rgba(251,113,133,0.2)', padding: '8px 12px', borderRadius: '6px' },
  submitBtn: {
    marginTop: '16px', padding: '12px',
    background: 'var(--accent)', color: '#0F172A',
    border: 'none', borderRadius: '8px',
    fontSize: '15px', fontWeight: 700, cursor: 'pointer',
  },
}
