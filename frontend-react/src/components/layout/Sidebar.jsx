import { Link, useLocation } from 'react-router-dom'

const navItems = [
  { path: '/',             icon: '▣', label: 'Dashboard'   },
  { path: '/holdings',     icon: '◈', label: 'Holdings'    },
  { path: '/transactions', icon: '↕', label: 'Transactions'},
  { path: '/analytics',    icon: '◎', label: 'Analytics'   },
  { path: '/insights',     icon: '✦', label: 'AI Insights', accent: true },
  { path: '/settings',     icon: '◌', label: 'Settings'    },
]

export default function Sidebar() {
  const location = useLocation()
  return (
    <aside style={{
      width: 'var(--sidebar-w)', minHeight: '100vh', flexShrink: 0,
      background: 'var(--bg-elevated)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      transition: 'background 0.3s',
    }}>
      {/* ── Brand ── */}
      <div style={{
        padding: '20px 18px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: '0',
      }}>
        {/* App logo icon */}
        <div style={{
          width: 34, height: 34, borderRadius: '9px',
          background: 'linear-gradient(135deg, #F59E0B, #D97706)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '18px', fontWeight: 900, color: '#0F172A',
          fontFamily: 'Georgia, "Times New Roman", serif',
          boxShadow: '0 3px 12px rgba(245,158,11,0.45)',
          flexShrink: 0, letterSpacing: '-1px',
          userSelect: 'none',
        }}>T</div>
        <span style={{
          fontSize: '17px', fontWeight: 700,
          color: 'var(--text-1)', letterSpacing: '-0.3px',
          marginLeft: '3px', lineHeight: 1,
        }}>rackFolio</span>
      </div>

      {/* ── Nav ── */}
      <nav style={{ padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
        {navItems.map(item => {
          const isActive = location.pathname === item.path
          return (
            <Link key={item.path} to={item.path} data-tour={item.tourId} style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '10px 12px', borderRadius: '8px',
              textDecoration: 'none', fontSize: '13.5px',
              fontWeight: isActive ? 600 : item.accent ? 500 : 400,
              transition: 'all 0.15s',
              border: '1px solid transparent',
              // Active: gold glow. Accent (AI): purple tint. Default: muted
              background: isActive
                ? 'linear-gradient(135deg, rgba(245,158,11,0.2), rgba(245,158,11,0.08))'
                : item.accent ? 'rgba(139,92,246,0.08)' : 'transparent',
              color: isActive ? '#F59E0B'
                : item.accent ? '#a78bfa' : 'var(--text-3)',
              borderColor: isActive
                ? 'rgba(245,158,11,0.3)'
                : item.accent ? 'rgba(139,92,246,0.2)' : 'transparent',
              boxShadow: isActive ? '0 2px 10px rgba(245,158,11,0.15)' : 'none',
            }}>
              <span style={{ fontSize: '15px', opacity: isActive ? 1 : 0.65 }}>{item.icon}</span>
              {item.label}
            </Link>
          )
        })}
      </nav>

      {/* ── Footer ── */}
      <div style={{
        padding: '14px 18px',
        borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ color: 'var(--text-4)', fontSize: '11px' }}>v2.0</span>
        <span style={{
          fontSize: '10px', fontWeight: 700,
          color: '#F59E0B', background: 'rgba(245,158,11,0.1)',
          padding: '2px 8px', borderRadius: '4px',
          border: '1px solid rgba(245,158,11,0.2)',
        }}>VRIDDHI</span>
      </div>
    </aside>
  )
}
