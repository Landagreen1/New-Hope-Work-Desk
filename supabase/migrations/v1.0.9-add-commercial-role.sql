-- New Hope Work Desk v1.0.9 — Add 'commercial' role to app_role enum
-- This MUST be run and committed BEFORE v1.1.0-commercial-quotes-board.sql
-- PostgreSQL requires new enum values to be committed before they can be used.

alter type public.app_role add value if not exists 'commercial';
