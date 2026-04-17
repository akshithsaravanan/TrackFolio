import { useAuth } from '../../context/AuthContext'
import { useTheme } from '../../context/ThemeContext'
import { useHideValues } from '../../context/HideValuesContext'
import { supabase } from '../../lib/supabase'

export default function Topbar({ title }) {
  const { user }               = useAuth()
  const { theme, toggleTheme } = useTheme()
  const { hidden, toggle }     = useHideValues()

  async function handleLogout() {
    await supabase.auth.signOut()
  }

  const avatarUrl   = user?.user_metadata?.avatar_url
  const displayName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || ''
  const initials    = displayName?.charAt(0).toUpperCase()

  return (
    <header className="topbar" style={{
      height: '56px',
      background: 'var(--bg-surface)',
      borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 24px',
      gap: '12px',
    }}>

      {/* Left — page title (desktop) or V logo (mobile) */}
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        <div className="topbar-logo" style={{ display: 'none', alignItems: 'center', marginRight: '10px' }}>
          <div style={{
            width: 30, height: 30, borderRadius: '8px',
            background: 'linear-gradient(135deg, #F59E0B, #D97706)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '16px', fontWeight: 900, color: '#0F172A',
            fontFamily: 'Georgia, serif',
            boxShadow: '0 2px 8px rgba(245,158,11,0.4)',
          }}>V</div>
        </div>
        <h1 className="topbar-title" style={{
          color: 'var(--text-1)', fontSize: '16px', fontWeight: 600,
          letterSpacing: '-0.3px', margin: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </h1>
      </div>

      {/* Right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>

        {/* Hide values toggle */}
        <button
          onClick={toggle}
          title={hidden ? 'Show values' : 'Hide values'}
          style={{
            width: '34px', height: '34px', borderRadius: '9px',
            background: hidden ? 'rgba(245,158,11,0.1)' : 'var(--bg-elevated)',
            border: hidden ? '1px solid rgba(245,158,11,0.3)' : '1px solid var(--border)',
            color: hidden ? 'var(--accent)' : 'var(--text-3)',
            fontSize: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', transition: 'all 0.2s',
          }}
        >
          {hidden ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
              <line x1="1" y1="1" x2="23" y2="23"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          )}
        </button>

        {/* Theme toggle */}
        <button onClick={toggleTheme} title="Switch theme" style={{
          width: '34px', height: '34px', borderRadius: '9px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          color: 'var(--text-3)', fontSize: '15px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
        }}>
          ◑
        </button>

        {/* Divider */}
        <div style={{ width: 1, height: 20, background: 'var(--border-soft)' }} />

        {/* Avatar */}
        {avatarUrl ? (
          <img src={avatarUrl} alt="avatar" style={{
            width: 30, height: 30, borderRadius: '50%', objectFit: 'cover',
          }} />
        ) : (
          <div style={{
            width: 30, height: 30, borderRadius: '50%',
            background: 'linear-gradient(135deg, #F59E0B, #D97706)',
            color: '#0F172A', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '12px', fontWeight: 700,
            flexShrink: 0,
          }}>{initials}</div>
        )}

        {/* Name — desktop only */}
        <span className="topbar-name" style={{
          color: 'var(--text-3)', fontSize: '13px', fontWeight: 500,
          maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {displayName}
        </span>

        {/* Sign out */}
        <button onClick={handleLogout} title="Sign out" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '0', width: '34px', height: '34px', borderRadius: '9px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          color: 'var(--text-4)', fontSize: '16px', cursor: 'pointer',
          transition: 'all 0.15s',
        }}>
          <span className="signout-icon">⏻</span>
          <span className="signout-text" style={{ display: 'none', fontSize: '12px', fontWeight: 500, padding: '0 10px', width: 'auto' }}>Sign out</span>
        </button>

      </div>

      <style>{`
        @media (max-width: 768px) {
          .topbar         { padding: 0 12px !important; }
          .topbar-title   { display: none !important; }
          .topbar-logo    { display: flex !important; }
          .topbar-name    { display: none !important; }
        }
        @media (min-width: 769px) {
          .signout-icon   { display: none; }
          .signout-text   { display: inline !important; }
          button[title="Sign out"] { width: auto !important; }
        }
      `}</style>
    </header>
  )
}
