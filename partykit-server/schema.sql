-- Alexa MP3 Player - Turso Schema

-- 現在有効な曲
CREATE TABLE IF NOT EXISTS tracks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,
  album       TEXT NOT NULL DEFAULT '',
  duration    INTEGER NOT NULL DEFAULT 0,
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- アーカイブ済み曲（論理削除フラグ禁止 → 別テーブル移動）
CREATE TABLE IF NOT EXISTS archived_tracks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,
  album       TEXT NOT NULL DEFAULT '',
  duration    INTEGER NOT NULL DEFAULT 0,
  added_at    TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- プレイリスト
CREATE TABLE IF NOT EXISTS playlists (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- アーカイブ済みプレイリスト（論理削除フラグ禁止 → 別テーブル移動）
CREATE TABLE IF NOT EXISTS archived_playlists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- プレイリスト⇔曲の関連（順序付き、FK制約で参照整合性保証）
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks_order
  ON playlist_tracks(playlist_id, position);
