-- Phase 8: host progression notifications.
-- PostgreSQL enum values are additive so existing notification rows remain valid.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HOST_LEVEL_UP';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HOST_TASK_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HOST_ACHIEVEMENT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HOST_RANKING';
