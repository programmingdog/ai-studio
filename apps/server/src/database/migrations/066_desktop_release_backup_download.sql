ALTER TABLE desktop_releases
  ADD COLUMN backup_download_url VARCHAR(2000) NOT NULL DEFAULT '' AFTER notes;
