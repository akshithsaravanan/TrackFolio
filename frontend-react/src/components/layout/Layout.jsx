import { useState } from 'react'
import Sidebar from './Sidebar'
import Topbar  from './Topbar'
import InstallBanner from './InstallBanner'

export default function Layout({ children, title }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-base)' }}>
      {/* Sidebar — hidden on mobile via CSS class */}
      <div className="sidebar-wrapper">
        <Sidebar />
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <Topbar title={title} />
        <main className="main-content" style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-base)' }}>
          {children}
        </main>
      </div>

      {/* Mobile bottom navigation */}
      <MobileNav />

      {/* PWA install banner — shows automatically when browser deems app installable */}
      <InstallBanner />

      <style>{`
        .sidebar-wrapper { display: flex; }
        .main-content    { padding: 28px; }

        @media (max-width: 768px) {
          .sidebar-wrapper { display: none; }
          .main-content    { padding: 16px 12px 80px; }
        }
      `}</style>
    </div>
  )
}

function MobileNav() {
  const path = window.location.pathname
  const items = [
    { href: '/',             icon: '▣', label: 'Home'        },
    { href: '/holdings',     icon: '◈', label: 'Holdings'    },
    { href: '/analytics',    icon: '◎', label: 'Analytics'   },
    { href: '/insights',     icon: '✦', label: 'AI Insights' },
    { href: '/settings',     icon: '◌', label: 'Settings'    },
  ]
  return (
    <>
      <nav style={{
        display: 'none',
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: 'var(--bg-elevated)', borderTop: '1px solid var(--border-soft)',
        zIndex: 200, padding: '6px 0 env(safe-area-inset-bottom, 6px)',
      }} className="mobile-nav">
        {items.map(item => {
          const active = path === item.href
          return (
            <a key={item.href} href={item.href} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
              flex: 1, padding: '6px 4px', textDecoration: 'none',
              color: active ? 'var(--accent)' : 'var(--text-3)',
              fontSize: '10px', fontWeight: active ? 700 : 400,
            }}>
              <span style={{ fontSize: '18px', lineHeight: 1, opacity: active ? 1 : 0.7 }}>{item.icon}</span>
              {item.label}
            </a>
          )
        })}
      </nav>
      <style>{`
        @media (max-width: 768px) {
          .mobile-nav { display: flex !important; }
        }
      `}</style>
    </>
  )
}
