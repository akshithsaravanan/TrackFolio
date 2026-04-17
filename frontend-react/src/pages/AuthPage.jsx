import { useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

export default function AuthPage() {
  const { user, loading: authLoading } = useAuth()
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [isSignUp, setIsSignUp] = useState(false)
  const navigate = useNavigate()

  if (authLoading) return null
  if (user) return <Navigate to="/" />

  async function handleGoogleLogin() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/` },
    })
  }

  async function handleEmailAuth(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = isSignUp
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password })
    if (error) { setError(error.message); setLoading(false) }
    else navigate('/')
  }

  return (
    <div style={styles.page}>

      {/* Dot-grid background */}
      <div style={styles.dotGrid} />

      <div style={styles.card}>

        {/* Gold top bar */}
        <div style={styles.goldBar} />

        <div style={{ padding: '36px 36px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>

          {/* App Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0', marginBottom: '4px' }}>
            <div style={styles.vLogo}>T</div>
            <span style={styles.riddhi}>rackFolio</span>
          </div>

          <p style={styles.subtitle}>Track your investments across multiple markets</p>

          {/* Google Login */}
          <button style={styles.googleBtn} onClick={handleGoogleLogin}>
            <svg width="18" height="18" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.8 2.5 30.2 0 24 0 14.8 0 7 5.4 3.2 13.3l7.8 6C13 13.5 18 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.9-10 6.9-17z"/>
              <path fill="#FBBC05" d="M11 28.3c-.5-1.5-.8-3-.8-4.8s.3-3.3.8-4.8l-7.8-6C1.2 16 0 19.9 0 24s1.2 8 3.2 11.3l7.8-6z"/>
              <path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.5-5.8c-2 1.4-4.6 2.2-7.7 2.2-6 0-11-4-12.8-9.6l-7.8 6C7 42.6 14.8 48 24 48z"/>
            </svg>
            Continue with Google
          </button>

          {/* Divider */}
          <div style={styles.divider}>
            <span style={styles.dividerLine} />
            <span style={styles.dividerText}>or</span>
            <span style={styles.dividerLine} />
          </div>

          {/* Email / Password Form */}
          <form onSubmit={handleEmailAuth} style={styles.form}>
            <input
              style={styles.input}
              type="email"
              placeholder="Email address"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
            <input
              style={styles.input}
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />

            {error && <p style={styles.error}>{error}</p>}

            <button style={styles.submitBtn} type="submit" disabled={loading}>
              {loading ? 'Please wait…' : isSignUp ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          {/* Toggle */}
          <p style={styles.toggle} onClick={() => { setIsSignUp(!isSignUp); setError('') }}>
            {isSignUp ? 'Already have an account? Sign In' : "Don't have an account? Sign Up"}
          </p>

          {/* Privacy trust strip */}
          <div style={{
            width: '100%', borderTop: '1px solid rgba(255,255,255,0.06)',
            paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '7px',
          }}>
            {[
              ['🔒', 'Your portfolio data is visible only to you'],
              ['🏦', 'Stored on Supabase — enterprise AWS infrastructure'],
              ['🚫', 'No ads · No tracking · No data sharing'],
            ].map(([icon, text]) => (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '13px' }}>{icon}</span>
                <span style={{ fontSize: '11px', color: '#475569', lineHeight: 1.4 }}>{text}</span>
              </div>
            ))}
          </div>

          {/* Footer */}
          <p style={styles.footer}>
            Multi-currency portfolio tracker · v1.0
          </p>

        </div>
      </div>
    </div>
  )
}

const styles = {
  page: {
    minHeight: '100vh',
    background: '#0F172A',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    position: 'relative',
    overflow: 'hidden',
  },
  dotGrid: {
    position: 'absolute', inset: 0, zIndex: 0,
    backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.025) 1px, transparent 1px)',
    backgroundSize: '28px 28px',
    pointerEvents: 'none',
  },
  card: {
    background: '#1A2740',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '16px',
    width: '100%',
    maxWidth: '400px',
    position: 'relative',
    zIndex: 1,
    boxShadow: '0 25px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(245,158,11,0.08)',
    overflow: 'hidden',
  },
  goldBar: {
    height: '4px',
    background: 'linear-gradient(90deg, #F59E0B, #D97706, #F59E0B)',
  },
  vLogo: {
    width: '44px', height: '44px', borderRadius: '11px',
    background: 'linear-gradient(135deg, #F59E0B, #D97706)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '22px', fontWeight: 900, color: '#0F172A',
    fontFamily: 'Georgia, "Times New Roman", serif',
    boxShadow: '0 4px 18px rgba(245,158,11,0.5)',
    flexShrink: 0,
  },
  riddhi: {
    fontSize: '26px', fontWeight: 700,
    color: '#f1f5f9', letterSpacing: '-0.5px',
    marginLeft: '4px', lineHeight: 1,
  },
  subtitle: {
    color: '#64748b', margin: 0,
    fontSize: '13px', textAlign: 'center', lineHeight: 1.5,
  },
  googleBtn: {
    width: '100%', padding: '11px',
    background: '#ffffff', color: '#1e293b',
    border: 'none', borderRadius: '8px',
    fontSize: '14px', fontWeight: 600, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
    marginTop: '4px', transition: 'opacity 0.15s',
  },
  divider: {
    width: '100%', display: 'flex', alignItems: 'center', gap: '12px',
  },
  dividerLine: {
    flex: 1, height: '1px',
    background: 'rgba(255,255,255,0.07)', display: 'block',
  },
  dividerText: {
    color: '#475569', fontSize: '12px',
  },
  form: {
    width: '100%', display: 'flex', flexDirection: 'column', gap: '10px',
  },
  input: {
    width: '100%', padding: '11px 14px',
    background: '#0D1929',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '8px', color: '#f1f5f9',
    fontSize: '14px', boxSizing: 'border-box', outline: 'none',
  },
  error: {
    color: '#f87171', fontSize: '13px', margin: 0,
    padding: '8px 12px', background: 'rgba(248,113,113,0.08)',
    border: '1px solid rgba(248,113,113,0.2)',
    borderRadius: '6px',
  },
  submitBtn: {
    width: '100%', padding: '12px',
    background: 'linear-gradient(135deg, #F59E0B, #D97706)',
    color: '#0F172A', border: 'none', borderRadius: '8px',
    fontSize: '14px', fontWeight: 700, cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(245,158,11,0.35)',
    transition: 'opacity 0.15s',
  },
  toggle: {
    color: '#F59E0B', fontSize: '13px',
    cursor: 'pointer', margin: 0,
    textDecoration: 'underline', textUnderlineOffset: '3px',
  },
  footer: {
    color: '#334155', fontSize: '11px', margin: 0,
    textAlign: 'center',
  },
}
