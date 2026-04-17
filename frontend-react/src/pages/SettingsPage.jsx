import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { clearCache, mergeDuplicateHoldings } from '../api/client'
import { supabase } from '../lib/supabase'

// ── Card wrapper ──────────────────────────────────────
function Card({ title, children }) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: '12px', padding: '22px',
      boxShadow: 'var(--shadow)',
    }}>
      <h3 style={{
        margin: '0 0 18px 0', fontSize: '11px', fontWeight: 700,
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-3)',
      }}>
        {title}
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {children}
      </div>
    </div>
  )
}

// ── Row ───────────────────────────────────────────────
function Row({ label, sub, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontSize: '14px', color: 'var(--text-2)', fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: '12px', color: 'var(--text-4)', marginTop: '2px' }}>{sub}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

export default function SettingsPage() {
  const { user } = useAuth()

  const [currency,    setCurrency]    = useState(() => localStorage.getItem('preferredCurrency') || 'All')
  const [cacheStatus, setCacheStatus] = useState(null)
  const [cacheMsg,    setCacheMsg]    = useState('')
  const [mergeStatus, setMergeStatus] = useState(null)
  const [mergeMsg,    setMergeMsg]    = useState('')
  const [signingOut,  setSigningOut]  = useState(false)

  function handleCurrencyChange(e) {
    const val = e.target.value
    setCurrency(val)
    localStorage.setItem('preferredCurrency', val)
  }

  async function handleClearCache() {
    setCacheStatus('loading'); setCacheMsg('')
    try {
      await clearCache()
      setCacheStatus('ok')
      setCacheMsg('Cache cleared. Fresh prices will load on next page visit.')
    } catch {
      setCacheStatus('error')
      setCacheMsg('Failed to clear cache.')
    }
  }

  async function handleMergeDuplicates() {
    setMergeStatus('loading'); setMergeMsg('')
    try {
      const res = await mergeDuplicateHoldings()
      if (res.merged_groups === 0) {
        setMergeStatus('ok')
        setMergeMsg('No duplicates found — everything looks clean.')
      } else {
        setMergeStatus('ok')
        setMergeMsg(`Merged ${res.merged_groups} group(s). ${res.transactions_created} transactions created.`)
      }
    } catch {
      setMergeStatus('error')
      setMergeMsg('Merge failed. Make sure the backend is running.')
    }
  }

  async function handleSignOut() {
    setSigningOut(true)
    await supabase.auth.signOut()
  }

  return (
    <div style={{ maxWidth: '640px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ── Page header ── */}
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: '22px', fontWeight: 700, color: 'var(--text-1)' }}>
          Settings
        </h2>
        <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-3)' }}>
          Preferences and account management.
        </p>
      </div>

      {/* ── 1. Profile ── */}
      <Card title="Profile">
        <Row label="Email" sub="Your account">
          <span style={{
            fontSize: '13px', color: 'var(--text-1)',
            background: 'var(--bg-input)', border: '1px solid var(--border)',
            borderRadius: '8px', padding: '6px 14px',
          }}>
            {user?.email || '—'}
          </span>
        </Row>
      </Card>

      {/* ── 2. Display ── */}
      <Card title="Display">
        <Row label="Default Currency" sub="Default filter on Holdings and Analytics">
          <select value={currency} onChange={handleCurrencyChange} style={{
            padding: '7px 32px 7px 12px', borderRadius: '8px',
            border: '1px solid var(--border)', background: 'var(--bg-input)',
            color: 'var(--text-1)', fontSize: '13px', fontWeight: 500,
            cursor: 'pointer', outline: 'none', appearance: 'none',
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
            backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center',
          }}>
            <option value="All">All currencies</option>
            <option value="INR">🇮🇳 INR — India</option>
            <option value="USD">🇺🇸 USD — US</option>
            <option value="AED">🇦🇪 AED — UAE</option>
          </select>
        </Row>
      </Card>

      {/* ── 3. Data ── */}
      <Card title="Data">
        <Row label="Clear Price Cache" sub="Force fresh prices on next load if data looks stale">
          <button onClick={handleClearCache} disabled={cacheStatus === 'loading'} style={{
            padding: '7px 16px', borderRadius: '8px',
            border: '1px solid var(--border)', background: 'var(--bg-elevated)',
            color: cacheStatus === 'loading' ? 'var(--text-4)' : 'var(--text-1)',
            fontSize: '13px', fontWeight: 600, cursor: cacheStatus === 'loading' ? 'not-allowed' : 'pointer',
            opacity: cacheStatus === 'loading' ? 0.6 : 1,
          }}>
            {cacheStatus === 'loading' ? '⏳ Clearing…' : '🗑 Clear Cache'}
          </button>
        </Row>

        {cacheMsg && (
          <div style={{
            padding: '10px 14px', borderRadius: '8px', fontSize: '13px',
            background: cacheStatus === 'ok' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
            border: `1px solid ${cacheStatus === 'ok' ? 'rgba(74,222,128,0.25)' : 'rgba(248,113,113,0.25)'}`,
            color: cacheStatus === 'ok' ? '#4ade80' : '#f87171',
          }}>{cacheMsg}</div>
        )}

        <Row label="Merge Duplicate Holdings" sub="Consolidate multiple rows for the same stock into one">
          <button onClick={handleMergeDuplicates} disabled={mergeStatus === 'loading'} style={{
            padding: '7px 16px', borderRadius: '8px',
            border: '1px solid var(--border)', background: 'var(--bg-elevated)',
            color: mergeStatus === 'loading' ? 'var(--text-4)' : 'var(--text-1)',
            fontSize: '13px', fontWeight: 600, cursor: mergeStatus === 'loading' ? 'not-allowed' : 'pointer',
            opacity: mergeStatus === 'loading' ? 0.6 : 1,
          }}>
            {mergeStatus === 'loading' ? '⏳ Merging…' : '⊕ Merge Duplicates'}
          </button>
        </Row>

        {mergeMsg && (
          <div style={{
            padding: '10px 14px', borderRadius: '8px', fontSize: '13px',
            background: mergeStatus === 'ok' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
            border: `1px solid ${mergeStatus === 'ok' ? 'rgba(74,222,128,0.25)' : 'rgba(248,113,113,0.25)'}`,
            color: mergeStatus === 'ok' ? '#4ade80' : '#f87171',
          }}>{mergeMsg}</div>
        )}
      </Card>

      {/* ── 4. Account ── */}
      <Card title="Account">
        <Row label="Sign out" sub="You will need to sign in again to access the app">
          <button onClick={handleSignOut} disabled={signingOut} style={{
            padding: '7px 18px', borderRadius: '8px',
            border: '1px solid rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.08)',
            color: signingOut ? 'rgba(248,113,113,0.4)' : '#f87171',
            fontSize: '13px', fontWeight: 700, cursor: signingOut ? 'not-allowed' : 'pointer',
          }}>
            {signingOut ? 'Signing out…' : 'Sign Out'}
          </button>
        </Row>
      </Card>

      {/* ── Footer ── */}
      <div style={{ textAlign: 'center', padding: '8px 0 20px', color: 'var(--text-4)', fontSize: '12px' }}>
        <span style={{ color: 'var(--accent)', fontWeight: 700 }}>TrackFolio</span> v1.0 · Multi-currency portfolio tracker
      </div>

    </div>
  )
}
