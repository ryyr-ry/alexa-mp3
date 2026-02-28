import type { TursoDb } from "../utils/db";
import type { Track } from "../models/track";
import {
  buildPlayResponse,
  buildStopResponse,
  buildSpeechResponse,
  buildEmptyResponse,
  decodeToken,
  type PlaybackToken,
} from "../utils/alexa-response";

/**
 * Alexa AudioPlayer ハンドラ
 *
 * PartyKitのHTTPエンドポイントで直接Alexaリクエストを処理する。
 * Lambda不要のステートレス設計。再生状態はstream.tokenに埋め込む。
 */

/** Alexaリクエストの共通型 */
interface AlexaRequest {
  version?: string;
  session?: Record<string, unknown>;
  context?: {
    AudioPlayer?: { token?: string; offsetInMilliseconds?: number; playerActivity?: string };
    System?: Record<string, unknown>;
  };
  request: {
    type: string;
    requestId?: string;
    timestamp?: string;
    locale?: string;
    intent?: { name: string; slots?: Record<string, { value?: string }> };
    token?: string;
    offsetInMilliseconds?: number;
    reason?: string;
    error?: { type: string; message: string };
  };
}

/** MP3/アートワークURL構築用 */
interface UrlBuilder {
  mp3(trackId: string): string;
  art(trackId: string): string;
}

export async function handleAlexaRequest(
  db: TursoDb,
  body: AlexaRequest,
  urlBuilder: UrlBuilder,
): Promise<Record<string, unknown>> {
  const { request, context } = body;
  const requestType = request.type;

  console.log(`[Alexa] ${requestType}`, request.intent?.name ?? request.token ?? "");

  // --- LaunchRequest ---
  if (requestType === "LaunchRequest") {
    return buildSpeechResponse(
      "音楽プレーヤーです。曲名やアーティスト名、プレイリスト名で再生できます。",
      false,
    );
  }

  // --- SessionEndedRequest ---
  if (requestType === "SessionEndedRequest") {
    return buildEmptyResponse();
  }

  // --- AudioPlayer系イベント ---
  if (requestType.startsWith("AudioPlayer.")) {
    return handleAudioPlayerEvent(db, request, urlBuilder);
  }

  // --- PlaybackController（物理ボタン） ---
  if (requestType.startsWith("PlaybackController.")) {
    return handlePlaybackController(db, context, urlBuilder, requestType);
  }

  // --- IntentRequest ---
  if (requestType === "IntentRequest" && request.intent) {
    return handleIntent(db, request, context, urlBuilder);
  }

  // 未知のリクエスト
  console.warn(`[Alexa] 未知のリクエスト: ${requestType}`);
  return buildEmptyResponse();
}

// ===========================================================
// IntentRequest
// ===========================================================

async function handleIntent(
  db: TursoDb,
  request: AlexaRequest["request"],
  context: AlexaRequest["context"],
  urlBuilder: UrlBuilder,
): Promise<Record<string, unknown>> {
  const intentName = request.intent!.name;
  const slots = request.intent!.slots ?? {};

  switch (intentName) {
    case "PlaySongIntent":
      return handlePlaySongIntent(db, slots["songName"]?.value, urlBuilder);

    case "PlayArtistIntent":
      return handlePlayArtistIntent(db, slots["artistName"]?.value, urlBuilder);

    case "PlayPlaylistIntent":
      return handlePlayPlaylistIntent(db, slots["playlistName"]?.value, urlBuilder);

    case "PlayAllIntent":
      return handlePlayAllIntent(db, urlBuilder);

    case "AMAZON.ResumeIntent":
      return handleResumeIntent(context, urlBuilder, db);

    case "AMAZON.PauseIntent":
    case "AMAZON.StopIntent":
    case "AMAZON.CancelIntent":
      return buildStopResponse();

    case "AMAZON.NextIntent":
      return handleNavigateIntent(db, context, urlBuilder, "next");

    case "AMAZON.PreviousIntent":
      return handleNavigateIntent(db, context, urlBuilder, "previous");

    case "AMAZON.HelpIntent":
      return buildSpeechResponse(
        "曲名、アーティスト名、またはプレイリスト名を言ってください。例えば、ビリーロムの曲をかけて、と言ってみてください。",
        false,
      );

    default:
      return buildSpeechResponse("曲名やアーティスト名で再生できます。", false);
  }
}

// ===========================================================
// PlaySongIntent — 曲名で再生（AMAZON.MusicRecording）
// ===========================================================

async function handlePlaySongIntent(
  db: TursoDb,
  songName: string | undefined,
  urlBuilder: UrlBuilder,
): Promise<Record<string, unknown>> {
  if (!songName) {
    return handlePlayAllIntent(db, urlBuilder);
  }
  const tracks = await db.searchTracksByTitle(songName);
  if (tracks.length === 0) {
    return buildSpeechResponse(`${songName} が見つかりませんでした。`, false);
  }
  const first = tracks[0]!;
  return buildPlayResponse(
    first,
    urlBuilder.mp3(first.id),
    urlBuilder.art(first.id),
    { trackId: first.id, context: "single" },
    "REPLACE_ALL",
    0,
    undefined,
    `${first.title} を再生します。`,
  );
}

// ===========================================================
// PlayArtistIntent — アーティスト名で再生（AMAZON.Artist）
// ===========================================================

async function handlePlayArtistIntent(
  db: TursoDb,
  artistName: string | undefined,
  urlBuilder: UrlBuilder,
): Promise<Record<string, unknown>> {
  if (!artistName) {
    return handlePlayAllIntent(db, urlBuilder);
  }
  const tracks = await db.searchTracksByArtist(artistName);
  if (tracks.length === 0) {
    return buildSpeechResponse(`${artistName} の曲が見つかりませんでした。`, false);
  }
  const first = tracks[0]!;
  return buildPlayResponse(
    first,
    urlBuilder.mp3(first.id),
    urlBuilder.art(first.id),
    { trackId: first.id, context: `artist::${first.artistId}` },
    "REPLACE_ALL",
    0,
    undefined,
    `${first.artist} の曲を再生します。`,
  );
}

// ===========================================================
// PlayPlaylistIntent — プレイリスト名で再生（AMAZON.SearchQuery）
// ===========================================================

async function handlePlayPlaylistIntent(
  db: TursoDb,
  playlistName: string | undefined,
  urlBuilder: UrlBuilder,
): Promise<Record<string, unknown>> {
  if (!playlistName) {
    return buildSpeechResponse("プレイリスト名を言ってください。", false);
  }
  const playlists = await db.searchPlaylistsByName(playlistName);
  const pl = playlists[0];
  if (!pl || pl.trackIds.length === 0) {
    return buildSpeechResponse(`「${playlistName}」というプレイリストが見つかりませんでした。`, false);
  }
  const tracks = await db.getPlaylistTracks(pl.id);
  const first = tracks[0];
  if (!first) {
    return buildSpeechResponse("プレイリストに曲が含まれていません。", false);
  }
  return buildPlayResponse(
    first,
    urlBuilder.mp3(first.id),
    urlBuilder.art(first.id),
    { trackId: first.id, context: `playlist::${pl.id}` },
    "REPLACE_ALL",
    0,
    undefined,
    `プレイリスト ${pl.name} を再生します。`,
  );
}

// ===========================================================
// PlayAllIntent — 全曲再生
// ===========================================================

async function handlePlayAllIntent(
  db: TursoDb,
  urlBuilder: UrlBuilder,
): Promise<Record<string, unknown>> {
  const tracks = await db.getTracks();
  if (tracks.length === 0) {
    return buildSpeechResponse("再生できる曲がありません。", false);
  }
  const first = tracks[0]!;
  return buildPlayResponse(
    first,
    urlBuilder.mp3(first.id),
    urlBuilder.art(first.id),
    { trackId: first.id, context: "all" },
    "REPLACE_ALL",
    0,
    undefined,
    `${first.title} を再生します。`,
  );
}

// ===========================================================
// ResumeIntent — 再生再開
// ===========================================================

async function handleResumeIntent(
  context: AlexaRequest["context"],
  urlBuilder: UrlBuilder,
  db: TursoDb,
): Promise<Record<string, unknown>> {
  const audioPlayer = context?.AudioPlayer;
  const token = audioPlayer?.token ? decodeToken(audioPlayer.token) : null;
  const offset = audioPlayer?.offsetInMilliseconds ?? 0;

  if (token) {
    const track = await db.getTrack(token.trackId);
    if (track) {
      return buildPlayResponse(
        track,
        urlBuilder.mp3(track.id),
        urlBuilder.art(track.id),
        token,
        "REPLACE_ALL",
        offset,
      );
    }
  }

  // tokenが無効 → 全曲の先頭から再生
  const tracks = await db.getTracks();
  if (tracks.length === 0) {
    return buildSpeechResponse("再生できる曲がありません。", false);
  }
  const first = tracks[0]!;
  return buildPlayResponse(
    first,
    urlBuilder.mp3(first.id),
    urlBuilder.art(first.id),
    { trackId: first.id, context: "all" },
    "REPLACE_ALL",
    0,
  );
}

// ===========================================================
// Next / Previous
// ===========================================================

async function handleNavigateIntent(
  db: TursoDb,
  context: AlexaRequest["context"],
  urlBuilder: UrlBuilder,
  direction: "next" | "previous",
): Promise<Record<string, unknown>> {
  const audioPlayer = context?.AudioPlayer;
  const token = audioPlayer?.token ? decodeToken(audioPlayer.token) : null;

  if (!token) {
    return buildSpeechResponse("現在再生中の曲がありません。", false);
  }
  const adjacent = await findAdjacentTrack(db, token, direction);
  if (!adjacent) {
    const msg = direction === "next" ? "次の曲はありません。" : "前の曲はありません。";
    return buildSpeechResponse(msg, false);
  }

  return buildPlayResponse(
    adjacent,
    urlBuilder.mp3(adjacent.id),
    urlBuilder.art(adjacent.id),
    { trackId: adjacent.id, context: token.context },
    "REPLACE_ALL",
    0,
  );
}

// ===========================================================
// AudioPlayer系イベント
// ===========================================================

async function handleAudioPlayerEvent(
  db: TursoDb,
  request: AlexaRequest["request"],
  urlBuilder: UrlBuilder,
): Promise<Record<string, unknown>> {
  // PlaybackNearlyFinished → 次の曲をENQUEUE
  if (request.type === "AudioPlayer.PlaybackNearlyFinished") {
    const currentToken = request.token;
    if (!currentToken) return buildEmptyResponse();

    const token = decodeToken(currentToken);
    if (!token) return buildEmptyResponse();

    const nextTrack = await findAdjacentTrack(db, token, "next");
    if (!nextTrack) return buildEmptyResponse();

    return buildPlayResponse(
      nextTrack,
      urlBuilder.mp3(nextTrack.id),
      urlBuilder.art(nextTrack.id),
      { trackId: nextTrack.id, context: token.context },
      "ENQUEUE",
      0,
      currentToken,
    );
  }

  // その他のAudioPlayerイベント（Started/Finished/Stopped/Failed）→ 空レスポンス
  if (request.type === "AudioPlayer.PlaybackFailed") {
    console.error("[Alexa] PlaybackFailed:", request.error);
  }
  return buildEmptyResponse();
}

// ===========================================================
// PlaybackController（物理ボタン）
// ===========================================================

async function handlePlaybackController(
  db: TursoDb,
  context: AlexaRequest["context"],
  urlBuilder: UrlBuilder,
  requestType: string,
): Promise<Record<string, unknown>> {
  const audioPlayer = context?.AudioPlayer;
  const token = audioPlayer?.token ? decodeToken(audioPlayer.token) : null;

  if (requestType === "PlaybackController.NextCommandIssued") {
    if (!token) return buildEmptyResponse();
    const next = await findAdjacentTrack(db, token, "next");
    if (!next) return buildEmptyResponse();
    return buildPlayResponse(
      next,
      urlBuilder.mp3(next.id),
      urlBuilder.art(next.id),
      { trackId: next.id, context: token.context },
      "REPLACE_ALL",
      0,
    );
  }

  if (requestType === "PlaybackController.PreviousCommandIssued") {
    if (!token) return buildEmptyResponse();
    const prev = await findAdjacentTrack(db, token, "previous");
    if (!prev) return buildEmptyResponse();
    return buildPlayResponse(
      prev,
      urlBuilder.mp3(prev.id),
      urlBuilder.art(prev.id),
      { trackId: prev.id, context: token.context },
      "REPLACE_ALL",
      0,
    );
  }

  if (requestType === "PlaybackController.PlayCommandIssued") {
    if (token) {
      const track = await db.getTrack(token.trackId);
      if (track) {
        return buildPlayResponse(
          track,
          urlBuilder.mp3(track.id),
          urlBuilder.art(track.id),
          token,
          "REPLACE_ALL",
          audioPlayer?.offsetInMilliseconds ?? 0,
        );
      }
    }
    return buildEmptyResponse();
  }

  if (requestType === "PlaybackController.PauseCommandIssued") {
    return buildStopResponse();
  }

  return buildEmptyResponse();
}

// ===========================================================
// 共通: 隣接トラック検索
// ===========================================================

async function findAdjacentTrack(
  db: TursoDb,
  token: PlaybackToken,
  direction: "next" | "previous",
): Promise<Track | null> {
  if (token.context === "single") return null;

  let trackList: string[];

  if (token.context.startsWith("playlist::")) {
    const playlistId = token.context.slice("playlist::".length);
    const pl = await db.getPlaylist(playlistId);
    if (!pl) return null;
    trackList = pl.trackIds;
  } else if (token.context.startsWith("artist::")) {
    const artistId = token.context.slice("artist::".length);
    const tracks = await db.getTracksByArtistId(artistId);
    trackList = tracks.map((t) => t.id);
  } else {
    trackList = await db.getTrackIds();
  }

  const currentIndex = trackList.indexOf(token.trackId);
  if (currentIndex === -1) return null;

  const targetIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
  const targetId = trackList[targetIndex];
  if (!targetId) return null;

  return db.getTrack(targetId);
}
