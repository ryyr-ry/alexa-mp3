import type { TursoDb } from "../utils/db";
import type { Playlist } from "../models/playlist";
import { generatePlaylistId } from "../models/playlist";
import { jsonResponse } from "../utils/json-response";

/** 全プレイリスト一覧を返す */
export async function handleGetPlaylists(db: TursoDb): Promise<Response> {
  const playlists = await db.getPlaylists();
  return jsonResponse(playlists);
}

/** 指定IDのプレイリストを返す */
export async function handleGetPlaylist(
  db: TursoDb,
  playlistId: string
): Promise<Response> {
  const playlist = await db.getPlaylist(playlistId);
  if (!playlist) {
    return jsonResponse({ error: "Playlist not found" }, 404);
  }
  return jsonResponse(playlist);
}

/** プレイリスト作成 */
export async function handleCreatePlaylist(
  db: TursoDb,
  input: { name: string; trackIds: string[] }
): Promise<Playlist> {
  const id = generatePlaylistId();
  const insertedIds = await db.createPlaylist(id, input.name, input.trackIds);
  const now = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  return {
    id,
    name: input.name,
    trackIds: insertedIds,
    createdAt: now,
    updatedAt: now,
  };
}

/** プレイリスト更新（名前・曲リスト） */
export async function handleUpdatePlaylist(
  db: TursoDb,
  playlistId: string,
  input: { name?: string; trackIds?: string[] }
): Promise<boolean> {
  return db.updatePlaylist(playlistId, input);
}

/** プレイリストをアーカイブへ移動（論理削除禁止） */
export async function handleArchivePlaylist(
  db: TursoDb,
  playlistId: string
): Promise<boolean> {
  return db.archivePlaylist(playlistId);
}
