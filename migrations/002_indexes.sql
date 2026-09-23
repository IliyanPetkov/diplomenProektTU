-- =====================================================================
-- Миграция 002: Индекси за производителност и ограничения
-- =====================================================================

-- Индекси за папки
CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders (owner_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders (parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_deleted ON folders (is_deleted);

-- Индекси за файлове
CREATE INDEX IF NOT EXISTS idx_files_owner ON files (owner_id);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files (folder_id);
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files (is_deleted);
CREATE INDEX IF NOT EXISTS idx_files_checksum ON files (checksum_sha256);

-- Индекси за версии
CREATE INDEX IF NOT EXISTS idx_file_versions_file_id ON file_versions (file_id);
CREATE INDEX IF NOT EXISTS idx_file_versions_num ON file_versions (file_id, version_number);

-- Индекси за споделяния
CREATE INDEX IF NOT EXISTS idx_shares_grantee ON shares (grantee_id);
CREATE INDEX IF NOT EXISTS idx_shares_file ON shares (file_id);
CREATE INDEX IF NOT EXISTS idx_shares_folder ON shares (folder_id);

-- Индекси за публични връзки
CREATE INDEX IF NOT EXISTS idx_public_links_token ON public_links (token);
CREATE INDEX IF NOT EXISTS idx_public_links_file ON public_links (file_id);
CREATE INDEX IF NOT EXISTS idx_public_links_expires ON public_links (expires_at);

-- Индекси за одитния лог
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs (timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_logs (correlation_id);

-- Индекси за upload sessions
CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON upload_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON upload_sessions (status);
