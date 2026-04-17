-- Migration: 001_user_approvals
-- Run once in Supabase Dashboard → SQL Editor
-- Enables the user approval / access control system

CREATE TABLE IF NOT EXISTS user_approvals (
  user_id     UUID        PRIMARY KEY,
  email       TEXT,
  approved    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ
);

-- Index for quick pending-user lookups
CREATE INDEX IF NOT EXISTS idx_user_approvals_approved
  ON user_approvals (approved, created_at DESC);

-- No RLS needed — this table is only accessed by the backend
-- using the SERVICE ROLE key, which bypasses RLS.
