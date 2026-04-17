import { createContext, useContext, useState, useEffect } from 'react'

export const THEMES = [
  { id: 'auto',       label: 'Follow Device', swatch: null },
  { id: 'pure-black', label: 'Pure Black',    swatch: '#111111' },
  { id: 'obsidian',   label: 'Obsidian',      swatch: '#0E1320' },
  { id: 'ocean',      label: 'Ocean',         swatch: '#071B2E' },
  { id: 'cool-slate', label: 'Cool Slate',    swatch: '#111E30' },
  { id: 'light',      label: 'Light',         swatch: '#F0F4F8' },
]

function getEffectiveTheme(theme) {
  if (theme === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'pure-black'
      : 'light'
  }
  return theme
}

const ThemeContext = createContext()

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    return localStorage.getItem('theme') || 'pure-black'
  })

  useEffect(() => {
    const apply = () => {
      document.documentElement.setAttribute('data-theme', getEffectiveTheme(theme))
    }
    apply()
    localStorage.setItem('theme', theme)

    // If "auto", listen for OS dark/light changes
    if (theme === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

  function setTheme(t) { setThemeState(t) }

  function toggleTheme() {
    setThemeState(t => {
      const idx = THEMES.findIndex(x => x.id === t)
      return THEMES[(idx + 1) % THEMES.length].id
    })
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
