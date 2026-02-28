import { createClient, type Client, type InValue } from "@libsql/client";
import type { Track } from "../models/track";
import type { Artist } from "../models/artist";
import type { Playlist } from "../models/playlist";
import { deriveArtistId } from "./hash";

/**
 * Turso DB クライアント
 *
 * DI対応: コンストラクタで接続設定を注入
 * 全CRUD操作を型安全なメソッドで提供
 *
 * 型はmodels/track.ts、models/playlist.ts、models/artist.tsの単一ソースを再利用（重複定義禁止）
 */

export interface DbConfig {
  url: string;
  authToken: string;
}

export class TursoDb {
  private readonly client: Client;
  private initPromise: Promise<void> | null = null;

  constructor(config: DbConfig) {
    this.client = createClient({
      url: config.url,
      authToken: config.authToken,
    });
  }

  /** スキーマ初期化（初回のみ。競合条件をPromiseロックで防止） */
  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    // PRAGMAとDDLを同一コネクションで実行するためexecuteMultiple内に含める
    await this.client.executeMultiple(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL,
        artist_id TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '',
        duration INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tracks_artist_id ON tracks(artist_id);
      CREATE TABLE IF NOT EXISTS archived_tracks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL,
        artist_id TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '',
        duration INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL, archived_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS artists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        keywords TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS archived_playlists (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        created_at TEXT NOT NULL, archived_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, track_id)
      );
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS auth_challenges (
        id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // マイグレーション: 既存tracksからアーティストを自動生成
    await this.client.execute(`
      INSERT OR IGNORE INTO artists (id, name, keywords)
      SELECT DISTINCT artist_id, artist, '' FROM tracks
      WHERE artist_id != '' AND artist_id NOT IN (SELECT id FROM artists)
    `);

    console.log("[DB] スキーマ初期化完了");
  }

  // ===== Artists =====

  /** 全アーティスト取得（曲数付きLEFT JOIN） */
  async getArtists(): Promise<Artist[]> {
    const rs = await this.client.execute(`
      SELECT a.id, a.name, a.keywords,
             COUNT(t.id) AS track_count
      FROM artists a
      LEFT JOIN tracks t ON t.artist_id = a.id
      GROUP BY a.id
      ORDER BY a.name COLLATE NOCASE
    `);
    return rs.rows.map(rowToArtist);
  }

  /** IDでアーティスト取得 */
  async getArtist(id: string): Promise<Artist | null> {
    const rs = await this.client.execute({
      sql: `SELECT a.id, a.name, a.keywords,
                   COUNT(t.id) AS track_count
            FROM artists a
            LEFT JOIN tracks t ON t.artist_id = a.id
            WHERE a.id = ?
            GROUP BY a.id`,
      args: [id],
    });
    const row = rs.rows[0];
    return row ? rowToArtist(row) : null;
  }

  /**
   * アーティスト存在保証（存在しなければ作成）
   * トラック追加・編集時に自動呼び出し
   */
  async ensureArtist(artistName: string): Promise<string> {
    const id = deriveArtistId(artistName);
    await this.client.execute({
      sql: "INSERT OR IGNORE INTO artists (id, name, keywords) VALUES (?, ?, '')",
      args: [id, artistName],
    });
    return id;
  }

  /** アーティスト新規作成（手動） */
  async createArtist(name: string, keywords: string): Promise<Artist> {
    const id = deriveArtistId(name);
    await this.client.execute({
      sql: "INSERT OR IGNORE INTO artists (id, name, keywords) VALUES (?, ?, ?)",
      args: [id, name, keywords],
    });
    return { id, name, keywords, trackCount: 0 };
  }

  /** アーティスト更新（名前・キーワード） */
  async updateArtist(
    id: string,
    fields: { name?: string; keywords?: string }
  ): Promise<boolean> {
    const sets: string[] = [];
    const args: InValue[] = [];
    if (fields.name !== undefined) { sets.push("name = ?"); args.push(fields.name); }
    if (fields.keywords !== undefined) { sets.push("keywords = ?"); args.push(fields.keywords); }
    if (sets.length === 0) return false;
    args.push(id);
    const rs = await this.client.execute({
      sql: `UPDATE artists SET ${sets.join(", ")} WHERE id = ?`,
      args,
    });
    return (rs.rowsAffected ?? 0) > 0;
  }

  /** アーティスト削除（所属曲のartistを"不明なアーティスト"に更新） */
  async archiveArtist(id: string): Promise<boolean> {
    const tx = await this.client.transaction("write");
    try {
      const unknownId = deriveArtistId("不明なアーティスト");
      await tx.execute({
        sql: "INSERT OR IGNORE INTO artists (id, name, keywords) VALUES (?, '不明なアーティスト', '')",
        args: [unknownId],
      });
      await tx.execute({
        sql: "UPDATE tracks SET artist = '不明なアーティスト', artist_id = ? WHERE artist_id = ?",
        args: [unknownId, id],
      });
      const rs = await tx.execute({
        sql: "DELETE FROM artists WHERE id = ?",
        args: [id],
      });
      await tx.commit();
      return (rs.rowsAffected ?? 0) > 0;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ===== Tracks =====

  /** アーカイブ済みトラック取得 */
  async getArchivedTracks(): Promise<Track[]> {
    const rs = await this.client.execute("SELECT * FROM archived_tracks ORDER BY archived_at DESC");
    return rs.rows.map(rowToTrack);
  }

  async getTracks(): Promise<Track[]> {
    const rs = await this.client.execute("SELECT * FROM tracks ORDER BY added_at DESC");
    return rs.rows.map(rowToTrack);
  }

  /** IDのみ取得（next/previous検索用、全カラム不要） */
  async getTrackIds(): Promise<string[]> {
    const rs = await this.client.execute("SELECT id FROM tracks ORDER BY added_at DESC");
    return rs.rows.map((row) => String(row["id"] ?? ""));
  }

  /** artist_idで曲を検索（INDEX使用、O(1)検索） */
  async getTracksByArtistId(artistId: string): Promise<Track[]> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM tracks WHERE artist_id = ? ORDER BY added_at DESC",
      args: [artistId],
    });
    return rs.rows.map(rowToTrack);
  }

  async getTrack(id: string): Promise<Track | null> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM tracks WHERE id = ?",
      args: [id],
    });
    const row = rs.rows[0];
    return row ? rowToTrack(row) : null;
  }

  async addTrack(track: Track): Promise<void> {
    await this.ensureArtist(track.artist);
    await this.client.execute({
      sql: "INSERT INTO tracks (id, title, artist, artist_id, album, duration, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [track.id, track.title, track.artist, track.artistId, track.album, track.duration, track.addedAt],
    });
  }

  async updateTrack(
    id: string,
    fields: { title?: string; artist?: string; album?: string }
  ): Promise<boolean> {
    const sets: string[] = [];
    const args: InValue[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); args.push(fields.title); }
    if (fields.artist !== undefined) {
      const artistId = deriveArtistId(fields.artist);
      sets.push("artist = ?"); args.push(fields.artist);
      sets.push("artist_id = ?"); args.push(artistId);
      await this.ensureArtist(fields.artist);
    }
    if (fields.album !== undefined) { sets.push("album = ?"); args.push(fields.album); }
    if (sets.length === 0) return false;
    args.push(id);
    const rs = await this.client.execute({
      sql: `UPDATE tracks SET ${sets.join(", ")} WHERE id = ?`,
      args,
    });
    return (rs.rowsAffected ?? 0) > 0;
  }

  async archiveTrack(id: string): Promise<boolean> {
    const tx = await this.client.transaction("write");
    try {
      const inserted = await tx.execute({
        sql: `INSERT OR REPLACE INTO archived_tracks (id, title, artist, artist_id, album, duration, added_at)
              SELECT id, title, artist, artist_id, album, duration, added_at FROM tracks WHERE id = ?`,
        args: [id],
      });
      if ((inserted.rowsAffected ?? 0) === 0) {
        await tx.rollback();
        return false;
      }
      await tx.execute({
        sql: "DELETE FROM playlist_tracks WHERE track_id = ?",
        args: [id],
      });
      await tx.execute({
        sql: "DELETE FROM tracks WHERE id = ?",
        args: [id],
      });
      await tx.commit();
      return true;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ===== Playlists =====

  /** アーカイブ済みPL取得 */
  async getArchivedPlaylists(): Promise<Playlist[]> {
    const rs = await this.client.execute("SELECT * FROM archived_playlists ORDER BY archived_at DESC");
    return rs.rows.map((row) => ({
      id: String(row["id"] ?? ""),
      name: String(row["name"] ?? ""),
      trackIds: [],
      createdAt: String(row["created_at"] ?? ""),
      updatedAt: String(row["created_at"] ?? ""),
    }));
  }

  /** 全PL取得（サブクエリで曲順保証 + N+1 解消） */
  async getPlaylists(): Promise<Playlist[]> {
    const rs = await this.client.execute(`
      SELECT p.id, p.name, p.created_at, p.updated_at,
             (SELECT GROUP_CONCAT(track_id, ',')
              FROM (SELECT track_id FROM playlist_tracks
                    WHERE playlist_id = p.id ORDER BY position)
             ) AS track_ids
      FROM playlists p
      ORDER BY p.created_at DESC
    `);
    return rs.rows.map(rowToPlaylist);
  }

  async getPlaylist(id: string): Promise<Playlist | null> {
    const rs = await this.client.execute({
      sql: `SELECT p.id, p.name, p.created_at, p.updated_at,
                   (SELECT GROUP_CONCAT(track_id, ',')
                    FROM (SELECT track_id FROM playlist_tracks
                          WHERE playlist_id = p.id ORDER BY position)
                   ) AS track_ids
            FROM playlists p
            WHERE p.id = ?`,
      args: [id],
    });
    const row = rs.rows[0];
    return row ? rowToPlaylist(row) : null;
  }

  /** PL内の曲をTrackオブジェクトとして取得（resolve用JOINクエリ） */
  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    const rs = await this.client.execute({
      sql: `SELECT t.* FROM tracks t
            JOIN playlist_tracks pt ON t.id = pt.track_id
            WHERE pt.playlist_id = ?
            ORDER BY pt.position`,
      args: [playlistId],
    });
    return rs.rows.map(rowToTrack);
  }

  async createPlaylist(id: string, name: string, trackIds: string[]): Promise<string[]> {
    const tx = await this.client.transaction("write");
    try {
      const now = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
      await tx.execute({
        sql: "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        args: [id, name, now, now],
      });
      // 存在するtrack_idを一括チェック（IN句で1クエリ）
      const validIds = new Set<string>();
      if (trackIds.length > 0) {
        const placeholders = trackIds.map(() => "?").join(",");
        const existsRs = await tx.execute({
          sql: `SELECT id FROM tracks WHERE id IN (${placeholders})`,
          args: trackIds as InValue[],
        });
        for (const row of existsRs.rows) validIds.add(String(row["id"]));
      }
      // バッチINSERT（存在確認済みのIDのみ）
      const insertedIds: string[] = [];
      let pos = 0;
      for (const tid of trackIds) {
        if (!tid || !validIds.has(tid)) continue;
        await tx.execute({
          sql: "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
          args: [id, tid, pos++],
        });
        insertedIds.push(tid);
      }
      await tx.commit();
      return insertedIds;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  async updatePlaylist(
    id: string,
    fields: { name?: string; trackIds?: string[] }
  ): Promise<boolean> {
    const tx = await this.client.transaction("write");
    try {
      // PL存在チェック
      const exists = await tx.execute({ sql: "SELECT 1 FROM playlists WHERE id = ?", args: [id] });
      if (exists.rows.length === 0) {
        await tx.rollback();
        return false;
      }
      const now = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
      if (fields.name !== undefined) {
        await tx.execute({
          sql: "UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?",
          args: [fields.name, now, id],
        });
      } else {
        await tx.execute({
          sql: "UPDATE playlists SET updated_at = ? WHERE id = ?",
          args: [now, id],
        });
      }
      if (fields.trackIds !== undefined) {
        await tx.execute({
          sql: "DELETE FROM playlist_tracks WHERE playlist_id = ?",
          args: [id],
        });
        // 一括存在チェック
        const validIds = new Set<string>();
        if (fields.trackIds.length > 0) {
          const placeholders = fields.trackIds.map(() => "?").join(",");
          const existsRs = await tx.execute({
            sql: `SELECT id FROM tracks WHERE id IN (${placeholders})`,
            args: fields.trackIds as InValue[],
          });
          for (const row of existsRs.rows) validIds.add(String(row["id"]));
        }
        let pos = 0;
        for (const tid of fields.trackIds) {
          if (!tid || !validIds.has(tid)) continue;
          await tx.execute({
            sql: "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
            args: [id, tid, pos++],
          });
        }
      }
      await tx.commit();
      return true;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  /** PLをアーカイブ（archived_playlistsに移動後、本体と関連を物理削除） */
  async archivePlaylist(id: string): Promise<boolean> {
    const tx = await this.client.transaction("write");
    try {
      const inserted = await tx.execute({
        sql: `INSERT OR REPLACE INTO archived_playlists (id, name, created_at)
              SELECT id, name, created_at FROM playlists WHERE id = ?`,
        args: [id],
      });
      if ((inserted.rowsAffected ?? 0) === 0) {
        await tx.rollback();
        return false;
      }
      await tx.execute({
        sql: "DELETE FROM playlist_tracks WHERE playlist_id = ?",
        args: [id],
      });
      await tx.execute({
        sql: "DELETE FROM playlists WHERE id = ?",
        args: [id],
      });
      await tx.commit();
      return true;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ===== Alexa検索 =====

  /** 曲名でLIKE部分一致検索（スペース正規化） */
  async searchTracksByTitle(query: string): Promise<Track[]> {
    const normalized = query.replace(/\s+/g, "");
    const rs = await this.client.execute({
      sql: `SELECT * FROM tracks
            WHERE REPLACE(title, ' ', '') LIKE ?
            ORDER BY added_at DESC`,
      args: [`%${normalized}%`],
    });
    return rs.rows.map(rowToTrack);
  }

  /** アーティスト名でLIKE部分一致検索（artists.keywordsをJOIN、スペース正規化） */
  async searchTracksByArtist(query: string): Promise<Track[]> {
    const normalized = query.replace(/\s+/g, "");
    const rs = await this.client.execute({
      sql: `SELECT t.* FROM tracks t
            JOIN artists a ON t.artist_id = a.id
            WHERE REPLACE(a.name, ' ', '') LIKE ?
               OR REPLACE(a.keywords, ' ', '') LIKE ?
            ORDER BY t.added_at DESC`,
      args: [`%${normalized}%`, `%${normalized}%`],
    });
    return rs.rows.map(rowToTrack);
  }

  /** プレイリスト名でLIKE部分一致検索（スペース正規化） */
  async searchPlaylistsByName(query: string): Promise<Playlist[]> {
    const normalized = query.replace(/\s+/g, "");
    const rs = await this.client.execute({
      sql: `SELECT p.id, p.name, p.created_at, p.updated_at,
                   (SELECT GROUP_CONCAT(track_id, ',')
                    FROM (SELECT track_id FROM playlist_tracks
                          WHERE playlist_id = p.id ORDER BY position)
                   ) AS track_ids
            FROM playlists p
            WHERE REPLACE(p.name, ' ', '') LIKE ?
            ORDER BY p.created_at DESC`,
      args: [`%${normalized}%`],
    });
    return rs.rows.map(rowToPlaylist);
  }

  // ===== WebAuthn =====

  /** 登録済みクレデンシャル数を取得（先着1名判定用） */
  async getCredentialCount(): Promise<number> {
    const rs = await this.client.execute("SELECT COUNT(*) as cnt FROM webauthn_credentials");
    return Number(rs.rows[0]?.["cnt"] ?? 0);
  }

  /** 登録済みユーザー名を取得（ログイン画面表示用） */
  async getUserName(): Promise<string | null> {
    const rs = await this.client.execute("SELECT user_name FROM webauthn_credentials LIMIT 1");
    const row = rs.rows[0];
    return row ? String(row["user_name"]) : null;
  }

  /** 全クレデンシャル取得（allowCredentials生成用） */
  async getCredentials(): Promise<Array<{ id: string; transports: string }>> {
    const rs = await this.client.execute("SELECT id, transports FROM webauthn_credentials");
    return rs.rows.map((row) => ({
      id: String(row["id"] ?? ""),
      transports: String(row["transports"] ?? ""),
    }));
  }

  /** IDでクレデンシャル取得（認証検証用） */
  async getCredentialById(credId: string): Promise<{
    id: string; userId: string; publicKey: string; counter: number; transports: string;
  } | null> {
    const rs = await this.client.execute({
      sql: "SELECT * FROM webauthn_credentials WHERE id = ?",
      args: [credId],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      id: String(row["id"]),
      userId: String(row["user_id"]),
      publicKey: String(row["public_key"]),
      counter: Number(row["counter"] ?? 0),
      transports: String(row["transports"] ?? ""),
    };
  }

  /** クレデンシャル保存 */
  async saveCredential(cred: {
    id: string; userId: string; userName: string;
    publicKey: string; counter: number; transports: string;
  }): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO webauthn_credentials (id, user_id, user_name, public_key, counter, transports)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [cred.id, cred.userId, cred.userName, cred.publicKey, cred.counter, cred.transports],
    });
  }

  /** カウンター更新 */
  async updateCredentialCounter(credId: string, counter: number): Promise<void> {
    await this.client.execute({
      sql: "UPDATE webauthn_credentials SET counter = ? WHERE id = ?",
      args: [counter, credId],
    });
  }

  /** チャレンジ一時保存 */
  async saveChallenge(id: string, challenge: string, type: string): Promise<void> {
    // 古いチャレンジを削除（5分以上前）
    await this.client.execute(
      "DELETE FROM auth_challenges WHERE created_at < datetime('now', '-5 minutes')"
    );
    await this.client.execute({
      sql: "INSERT OR REPLACE INTO auth_challenges (id, challenge, type) VALUES (?, ?, ?)",
      args: [id, challenge, type],
    });
  }

  /** チャレンジ取得＆削除（1回限り使用、5分以内のみ有効） */
  async getAndDeleteChallenge(id: string): Promise<string | null> {
    const rs = await this.client.execute({
      sql: `SELECT challenge FROM auth_challenges
            WHERE id = ? AND created_at >= datetime('now', '-5 minutes')`,
      args: [id],
    });
    // 取得成功・失敗に関わらず削除（ワンタイム）
    await this.client.execute({ sql: "DELETE FROM auth_challenges WHERE id = ?", args: [id] });
    return rs.rows[0] ? String(rs.rows[0]["challenge"]) : null;
  }
}

// ---------- ヘルパー ----------

function rowToTrack(row: Record<string, unknown>): Track {
  return {
    id: String(row["id"] ?? ""),
    title: String(row["title"] ?? ""),
    artist: String(row["artist"] ?? ""),
    artistId: String(row["artist_id"] ?? ""),
    album: String(row["album"] ?? ""),
    duration: Number(row["duration"] ?? 0),
    addedAt: String(row["added_at"] ?? ""),
  };
}

function rowToArtist(row: Record<string, unknown>): Artist {
  return {
    id: String(row["id"] ?? ""),
    name: String(row["name"] ?? ""),
    keywords: String(row["keywords"] ?? ""),
    trackCount: Number(row["track_count"] ?? 0),
  };
}

function rowToPlaylist(row: Record<string, unknown>): Playlist {
  const rawTrackIds = row["track_ids"];
  const trackIds = typeof rawTrackIds === "string" && rawTrackIds
    ? rawTrackIds.split(",")
    : [];
  return {
    id: String(row["id"] ?? ""),
    name: String(row["name"] ?? ""),
    trackIds,
    createdAt: String(row["created_at"] ?? ""),
    updatedAt: String(row["updated_at"] ?? ""),
  };
}
