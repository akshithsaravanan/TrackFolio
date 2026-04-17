import { useState, useEffect } from 'react'

// Captures the browser's beforeinstallprompt event and shows a gold install banner
export default function InstallBanner() {
  const [prompt,    setPrompt]    = useState(null)   // deferred install prompt
  const [visible,   setVisible]   = useState(false)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    // Already installed as PWA — don't show banner
    if (window.matchMedia('(display-mode: standalone)').matches) return
    // User previously dismissed — don't nag again this session
    if (sessionStorage.getItem('installDismissed')) return

    const handler = (e) => {
      e.preventDefault()          // stop Chrome's mini infobar
      setPrompt(e)                 // save it so we can trigger it ourselves
      setVisible(true)
    }

    window.addEventListener('beforeinstallprompt', handler)

    // Also listen for successful install
    window.addEventListener('appinstalled', () => {
      setInstalled(true)
      setVisible(false)
    })

    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  async function handleInstall() {
    if (!prompt) return
    prompt.prompt()                        // show the native install dialog
    const { outcome } = await prompt.userChoice
    if (outcome === 'accepted') {
      setInstalled(true)
    }
    setVisible(false)
  }

  function handleDismiss() {
    sessionStorage.setItem('installDismissed', 'true')
    setVisible(false)
  }

  if (!visible) return null

  return (
    <>
      {/* Backdrop blur on mobile for focus */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 8000,
        padding: '12px 16px',
        paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
      }}>
        <div style={{
          background: 'linear-gradient(135deg, #1A2740, #0F172A)',
          border: '1px solid rgba(245,158,11,0.35)',
          borderRadius: '14px',
          padding: '14px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(245,158,11,0.1)',
          animation: 'slideUp 0.3s ease-out',
        }}>

          {/* V icon */}
          <div style={{
            width: 40, height: 40, borderRadius: '10px', flexShrink: 0,
            background: 'linear-gradient(135deg, #F59E0B, #D97706)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '20px', fontWeight: 900, color: '#0F172A',
            fontFamily: 'Georgia, serif',
            boxShadow: '0 3px 10px rgba(245,158,11,0.4)',
          }}>V</div>

          {/* Text */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: '#f1f5f9' }}>
              Install TrackFolio
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '1px' }}>
              Add to home screen for quick access
            </div>
          </div>

          {/* Dismiss */}
          <button onClick={handleDismiss} style={{
            background: 'none', border: 'none',
            color: '#475569', cursor: 'pointer',
            fontSize: '18px', padding: '4px', flexShrink: 0,
            lineHeight: 1,
          }}>✕</button>

          {/* Install button */}
          <button onClick={handleInstall} style={{
            padding: '8px 18px', borderRadius: '8px', flexShrink: 0,
            border: 'none',
            background: 'linear-gradient(135deg, #F59E0B, #D97706)',
            color: '#0F172A', fontSize: '13px', fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 3px 10px rgba(245,158,11,0.35)',
          }}>
            Install
          </button>

        </div>
      </div>

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  )
}
