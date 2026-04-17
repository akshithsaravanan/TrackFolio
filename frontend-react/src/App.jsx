// src/App.jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { HideValuesProvider } from './context/HideValuesContext'
import Layout from './components/layout/Layout'
import AuthPage         from './pages/AuthPage'
import DashboardPage    from './pages/DashboardPage'
import HoldingsPage     from './pages/HoldingsPage'
import AnalyticsPage    from './pages/AnalyticsPage'
import CopilotPage      from './pages/CopilotPage'
import SettingsPage     from './pages/SettingsPage'
import TransactionsPage from './pages/TransactionsPage'

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (user === null) return <Navigate to="/login" />
  return children
}

function Protected({ title, children }) {
  return (
    <ProtectedRoute>
      <Layout title={title}>
        {children}
      </Layout>
    </ProtectedRoute>
  )
}

export default function App() {
  return (
    <HideValuesProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login"        element={<AuthPage />} />
          <Route path="/"             element={<Protected title="Dashboard">    <DashboardPage />    </Protected>} />
          <Route path="/holdings"     element={<Protected title="Holdings">     <HoldingsPage />     </Protected>} />
          <Route path="/analytics"    element={<Protected title="Analytics">    <AnalyticsPage />    </Protected>} />
          <Route path="/insights"     element={<Protected title="AI Insights">  <CopilotPage />      </Protected>} />
          <Route path="/settings"     element={<Protected title="Settings">     <SettingsPage />     </Protected>} />
          <Route path="/transactions" element={<Protected title="Transactions"> <TransactionsPage /> </Protected>} />
          <Route path="*"             element={<Navigate to="/" />} />
        </Routes>
      </BrowserRouter>
    </HideValuesProvider>
  )
}
