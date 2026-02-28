import type { TursoDb } from "../utils/db";
import type { Artist } from "../models/artist";
import { jsonResponse } from "../utils/json-response";

/** 全アーティスト一覧を返す（曲数付き） */
export async function handleGetArtists(db: TursoDb): Promise<Response> {
  const artists = await db.getArtists();
  return jsonResponse(artists);
}

/** アーティスト新規作成 */
export async function handleCreateArtist(
  db: TursoDb,
  input: { name: string; keywords: string }
): Promise<Artist> {
  return db.createArtist(input.name, input.keywords);
}

/** アーティスト更新（名前・キーワード） */
export async function handleUpdateArtist(
  db: TursoDb,
  artistId: string,
  fields: { name?: string; keywords?: string }
): Promise<boolean> {
  return db.updateArtist(artistId, fields);
}

/** アーティスト削除（所属曲は"不明なアーティスト"に移行） */
export async function handleArchiveArtist(
  db: TursoDb,
  artistId: string
): Promise<boolean> {
  return db.archiveArtist(artistId);
}
