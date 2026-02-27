import type { TrackInfo } from "../clients/partykit-client";
import { buildArtUrl } from "../clients/partykit-client";

/**
 * Music Skill API レスポンスビルダー
 * 公式仕様に準拠したJSONレスポンスを組み立てる
 */

function uuid(): string {
  return crypto.randomUUID();
}

/** GetPlayableContent の成功レスポンス */
export function buildGetPlayableContentResponse(contentId: string) {
  return {
    header: {
      namespace: "Alexa.Media.Search",
      name: "GetPlayableContent.Response",
      messageId: uuid(),
      payloadVersion: "1.0",
    },
    payload: {
      content: { id: contentId },
    },
  };
}

/** GetPlayableContent のエラーレスポンス（コンテンツ見つからず） */
export function buildContentNotFoundResponse() {
  return {
    header: {
      namespace: "Alexa.Media.Search",
      name: "ErrorResponse",
      messageId: uuid(),
      payloadVersion: "1.0",
    },
    payload: {
      type: "CONTENT_NOT_FOUND",
      message: "リクエストされたコンテンツが見つかりません",
    },
  };
}

/** Initiate の成功レスポンス */
export function buildInitiateResponse(
  track: TrackInfo,
  mp3Url: string,
  queueId: string,
  hasNext: boolean
) {
  return {
    header: {
      namespace: "Alexa.Media.Playback",
      name: "Initiate.Response",
      messageId: uuid(),
      payloadVersion: "1.0",
    },
    payload: {
      playbackMethod: {
        type: "ALEXA_AUDIO_PLAYER_QUEUE",
        id: queueId,
        rules: { feedbackEnabled: false },
        firstItem: buildItem(track, mp3Url, queueId, hasNext),
      },
    },
  };
}

/** GetNextItem / GetPreviousItem の成功レスポンス */
export function buildItemResponse(
  track: TrackInfo,
  mp3Url: string,
  queueId: string,
  hasMore: boolean,
  isLast: boolean
) {
  return {
    header: {
      namespace: "Alexa.Audio.PlayQueue",
      name: "GetItem.Response",
      messageId: uuid(),
      payloadVersion: "1.0",
    },
    payload: {
      item: buildItem(track, mp3Url, queueId, hasMore),
      isQueueFinished: isLast,
    },
  };
}

/** キュー終了レスポンス */
export function buildQueueFinishedResponse(_queueId: string) {
  return {
    header: {
      namespace: "Alexa.Audio.PlayQueue",
      name: "GetItem.Response",
      messageId: uuid(),
      payloadVersion: "1.0",
    },
    payload: {
      isQueueFinished: true,
    },
  };
}

/** 個別アイテムの構築 */
function buildItem(
  track: TrackInfo,
  mp3Url: string,
  _queueId: string,
  hasNext: boolean
) {
  return {
    id: track.id,
    playbackInfo: { type: "DEFAULT" },
    metadata: {
      type: "TRACK",
      name: {
        speech: { type: "PLAIN_TEXT", text: track.title },
        display: track.title,
      },
      art: {
        sources: [{ url: buildArtUrl(track.id) }],
      },
    },
    controls: [
      { type: "COMMAND", name: "NEXT", enabled: hasNext },
      { type: "COMMAND", name: "PREVIOUS", enabled: true },
    ],
    rules: { feedbackEnabled: false },
    stream: {
      id: `stream-${track.id}`,
      uri: mp3Url,
      offsetInMilliseconds: 0,
    },
  };
}
