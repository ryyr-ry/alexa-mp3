import type { TursoDb } from "../utils/db";
import type { Track, TrackInput } from "../models/track";
import { deriveArtistId } from "../utils/hash";
import { jsonResponse } from "../utils/json-response";

/** 全曲一覧を返す */
export async function handleGetTracks(db: TursoDb): Promise<Response> {
  const tracks = await db.getTracks();
  return jsonResponse(tracks);
}

/** 指定IDの曲を返す */
export async function handleGetTrack(db: TursoDb, trackId: string): Promise<Response> {
  const track = await db.getTrack(trackId);
  if (!track) {
    return jsonResponse({ error: "Track not found" }, 404);
  }
  return jsonResponse(track);
}

/** 新しい曲を追加（メタデータのみ。MP3バイナリは別途） */
export async function handleAddTrack(
  db: TursoDb,
  id: string,
  input: TrackInput
): Promise<Track> {
  const track: Track = {
    id,
    title: input.title,
    artist: input.artist,
    artistId: deriveArtistId(input.artist),
    album: input.album,
    duration: input.duration,
    keywords: "",
    addedAt: new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""),
  };
  await db.addTrack(track);
  return track;
}

/** 曲のメタデータを更新 */
export async function handleUpdateTrack(
  db: TursoDb,
  trackId: string,
  fields: { title?: string; artist?: string; album?: string; keywords?: string }
): Promise<boolean> {
  return db.updateTrack(trackId, fields);
}

/** 曲をアーカイブへ移動（論理削除禁止） */
export async function handleArchiveTrack(
  db: TursoDb,
  trackId: string
): Promise<boolean> {
  return db.archiveTrack(trackId);
}
