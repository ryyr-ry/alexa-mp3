import type { Track } from "../models/track";

/**
 * Alexa AudioPlayerレスポンスビルダー
 *
 * 公式仕様: https://developer.amazon.com/en-US/docs/alexa/custom-skills/audioplayer-interface-reference.html
 */

/** stream.tokenに埋め込む再生状態 */
export interface PlaybackToken {
  trackId: string;
  /** "all" | "artist::{artistId}" | "playlist::{playlistId}" */
  context: string;
}

export function encodeToken(token: PlaybackToken): string {
  return btoa(JSON.stringify(token));
}

export function decodeToken(raw: string): PlaybackToken | null {
  try {
    return JSON.parse(atob(raw)) as PlaybackToken;
  } catch {
    return null;
  }
}

/** AudioPlayer.Play ディレクティブ付きレスポンス */
export function buildPlayResponse(
  track: Track,
  mp3Url: string,
  artUrl: string,
  token: PlaybackToken,
  behavior: "REPLACE_ALL" | "ENQUEUE" | "REPLACE_ENQUEUED",
  offsetMs: number,
  expectedPreviousToken?: string,
  speechText?: string,
) {
  const encodedToken = encodeToken(token);

  const stream: Record<string, unknown> = {
    url: mp3Url,
    token: encodedToken,
    offsetInMilliseconds: offsetMs,
  };
  if (behavior === "ENQUEUE" && expectedPreviousToken) {
    stream["expectedPreviousToken"] = expectedPreviousToken;
  }

  const directive: Record<string, unknown> = {
    type: "AudioPlayer.Play",
    playBehavior: behavior,
    audioItem: {
      stream,
      metadata: {
        title: track.title,
        subtitle: track.artist,
        art: { sources: [{ url: artUrl }] },
      },
    },
  };

  const response: Record<string, unknown> = {
    directives: [directive],
    shouldEndSession: true,
  };

  if (speechText) {
    response["outputSpeech"] = { type: "PlainText", text: speechText };
  }

  return { version: "1.0", response };
}

/** AudioPlayer.Stop ディレクティブ付きレスポンス */
export function buildStopResponse() {
  return {
    version: "1.0",
    response: {
      directives: [{ type: "AudioPlayer.Stop" }],
      shouldEndSession: true,
    },
  };
}

/** 音声のみレスポンス（shouldEndSession指定可能） */
export function buildSpeechResponse(text: string, shouldEndSession: boolean) {
  return {
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text },
      shouldEndSession,
    },
  };
}

/** 空レスポンス（AudioPlayer系イベントへの応答用） */
export function buildEmptyResponse() {
  return { version: "1.0", response: {} };
}
