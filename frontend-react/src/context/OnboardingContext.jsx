import { createContext, useContext, useState, useEffect } from 'react'
import { useAuth } from './AuthContext'

const OnboardingContext = createContext(null)

export function OnboardingProvider({ children }) {
  const [phase, setPhase] = useState(null) // null | 'wizard' | 'tour' | 'done'
  const [wizardStep, setWizardStep] = useState(0)
  const [tourStep,   setTourStep]   = useState(0)
  const { user } = useAuth()

  useEffect(() => {
    // Only show wizard when user is logged in and hasn't completed it
    if (!user) return
    const completed = localStorage.getItem('tourCompleted')
    if (!completed) {
      const t = setTimeout(() => setPhase('wizard'), 800)
      return () => clearTimeout(t)
    }
  }, [user])

  function startTour() {
    localStorage.removeItem('tourCompleted')
    setTourStep(0)
    setPhase('tour')
  }

  function startWizard() {
    localStorage.removeItem('tourCompleted')
    setWizardStep(0)
    setPhase('wizard')
  }

  function finishWizard() {
    setPhase('tour')
    setTourStep(0)
  }

  function nextTour() {
    setTourStep(s => s + 1)
  }

  function finishTour() {
    localStorage.setItem('tourCompleted', 'true')
    setPhase('done')
  }

  function skipAll() {
    localStorage.setItem('tourCompleted', 'true')
    setPhase('done')
  }

  return (
    <OnboardingContext.Provider value={{
      phase, wizardStep, setWizardStep, tourStep,
      startTour, startWizard, finishWizard, nextTour, finishTour, skipAll,
    }}>
      {children}
    </OnboardingContext.Provider>
  )
}

export function useOnboarding() {
  return useContext(OnboardingContext)
}
