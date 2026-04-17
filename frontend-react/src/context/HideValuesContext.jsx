import { createContext, useContext, useState } from 'react'

const HideValuesContext = createContext()

export function HideValuesProvider({ children }) {
  const [hidden, setHidden] = useState(
    () => localStorage.getItem('hideValues') === 'true'
  )

  function toggle() {
    setHidden(h => {
      localStorage.setItem('hideValues', String(!h))
      return !h
    })
  }

  // Returns masked string if hidden, otherwise returns the original value
  function mask(value) {
    return hidden ? '••••••' : value
  }

  return (
    <HideValuesContext.Provider value={{ hidden, toggle, mask }}>
      {children}
    </HideValuesContext.Provider>
  )
}

export const useHideValues = () => useContext(HideValuesContext)
