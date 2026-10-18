-- Nightly app ↔ phone-line comparison (workers/syncReconciler.js): one row per run.
--   summary: counts (customers checked, matched, phone-only, fixes made, needs attention, failed syncs)
--   fixes:   differences corrected automatically (plan, phone sign-in for suspended/deleted accounts)
--   issues:  differences left for a person to look at
-- Safe to re-run.
CREATE TABLE IF NOT EXISTS sync_reconcile_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger      VARCHAR(20) NOT NULL DEFAULT 'nightly',   -- 'nightly' | 'manual'
  run_by       UUID,                                      -- admin who pressed "Run check now"
  started_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at  TIMESTAMP,
  summary      JSONB DEFAULT '{}',
  fixes        JSONB DEFAULT '[]',
  issues       JSONB DEFAULT '[]',
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_reconcile_reports_started ON sync_reconcile_reports (started_at DESC);
