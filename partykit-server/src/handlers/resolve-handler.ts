import type { TursoDb } from "../utils/db";
import { jsonResponse } from "../utils/json-response";

/**
 * Lambda用のエンティティ解決ハンドラ
 * LambdaがGetPlayableContentで受け取ったentityIdを元に曲を特定する
 */

/** entityIdからトラックを解決 */
export async function handleResolveEntity(
  db: TursoDb,
  body: { entityId: string; entityType: string }
): Promise<Response> {
  const { entityId, entityType } = body;

  // 全曲リストを返す
  if (entityType === "ALL" || (!entityId && !entityType)) {
    const tracks = await db.getTracks();
    if (tracks.length === 0) {
      return jsonResponse({ found: false }, 404);
    }
    return jsonResponse({ found: true, tracks, totalCount: tracks.length });
  }

  if (entityType === "TRACK") {
    const track = await db.getTrack(entityId);
    if (!track) {
      return jsonResponse({ found: false }, 404);
    }
    return jsonResponse({ found: true, track, totalCount: 1 });
  }

  if (entityType === "ARTIST") {
    const tracks = await db.getTracksByArtistId(entityId);
    if (tracks.length === 0) {
      return jsonResponse({ found: false }, 404);
    }
    return jsonResponse({ found: true, tracks, totalCount: tracks.length });
  }

  if (entityType === "PLAYLIST") {
    const playlist = await db.getPlaylist(entityId);
    if (!playlist) {
      return jsonResponse({ found: false }, 404);
    }
    // JOINクエリで直接取得（N+1回避）
    const tracks = await db.getPlaylistTracks(entityId);
    return jsonResponse({ found: true, playlist, tracks, totalCount: tracks.length });
  }

  return jsonResponse({ error: `Unknown entityType: ${entityType}` }, 400);
}

/** 次の曲を返す（Lambda用のGetNextItem対応） */
export async function handleGetNextTrack(
  db: TursoDb,
  body: { currentTrackId: string; playlistId?: string }
): Promise<Response> {
  const { currentTrackId, playlistId } = body;

  let trackList: string[];

  if (playlistId) {
    const playlist = await db.getPlaylist(playlistId);
    if (!playlist) {
      return jsonResponse({ hasNext: false }, 404);
    }
    trackList = playlist.trackIds;
  } else {
    trackList = await db.getTrackIds();
  }

  const currentIndex = trackList.indexOf(currentTrackId);
  if (currentIndex === -1 || currentIndex >= trackList.length - 1) {
    return jsonResponse({ hasNext: false });
  }

  const nextTrackId = trackList[currentIndex + 1];
  if (!nextTrackId) {
    return jsonResponse({ hasNext: false });
  }
  const nextTrack = await db.getTrack(nextTrackId);
  if (!nextTrack) {
    return jsonResponse({ hasNext: false });
  }

  const hasFurtherNext = currentIndex + 1 < trackList.length - 1;
  return jsonResponse({ hasNext: true, track: nextTrack, hasFurtherNext });
}

/** 前の曲を返す（Lambda用のGetPreviousItem対応） */
export async function handleGetPreviousTrack(
  db: TursoDb,
  body: { currentTrackId: string; playlistId?: string }
): Promise<Response> {
  const { currentTrackId, playlistId } = body;

  let trackList: string[];

  if (playlistId) {
    const playlist = await db.getPlaylist(playlistId);
    if (!playlist) {
      return jsonResponse({ hasPrevious: false }, 404);
    }
    trackList = playlist.trackIds;
  } else {
    trackList = await db.getTrackIds();
  }

  const currentIndex = trackList.indexOf(currentTrackId);
  if (currentIndex <= 0) {
    return jsonResponse({ hasPrevious: false });
  }

  const prevTrackId = trackList[currentIndex - 1];
  if (!prevTrackId) {
    return jsonResponse({ hasPrevious: false });
  }
  const prevTrack = await db.getTrack(prevTrackId);
  if (!prevTrack) {
    return jsonResponse({ hasPrevious: false });
  }

  // Lambda側で「この曲からさらに次があるか」確認のRTTを削減
  const hasNextFromHere = currentIndex - 1 < trackList.length - 1;
  return jsonResponse({ hasPrevious: true, track: prevTrack, hasNext: hasNextFromHere });
}
