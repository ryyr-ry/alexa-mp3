import { handleGetPlayableContent } from "./handlers/get-playable-content";
import { handleInitiate } from "./handlers/initiate";
import { handleGetNextItem } from "./handlers/get-next-item";
import { handleGetPreviousItem } from "./handlers/get-previous-item";
import { handleGetItem } from "./handlers/get-item";

/** Music Skill API リクエスト型 */
interface MusicSkillRequest {
  header: { namespace: string; name: string; messageId?: string; payloadVersion?: string };
  payload: Record<string, unknown>;
}

/** Music Skill API レスポンス型 */
interface MusicSkillResponse {
  header: { namespace: string; name: string; messageId: string; payloadVersion: string };
  payload: Record<string, unknown>;
}

/**
 * AWS Lambda エントリポイント
 * Music Skill APIのリクエストをルーティングし、対応するハンドラに委譲する
 */
export async function handler(event: MusicSkillRequest): Promise<MusicSkillResponse> {
  console.log("受信:", `${event.header?.namespace}.${event.header?.name}`);

  const { header, payload } = event;
  const namespace = header?.namespace;
  const name = header?.name;

  try {
    // GetPlayableContent: 「〇〇を再生して」
    if (namespace === "Alexa.Media.Search" && name === "GetPlayableContent") {
      return await handleGetPlayableContent(payload);
    }

    // Initiate: 再生開始
    if (namespace === "Alexa.Media.Playback" && name === "Initiate") {
      return await handleInitiate(payload as { contentId: string });
    }

    // GetNextItem: 次のトラック
    if (namespace === "Alexa.Audio.PlayQueue" && name === "GetNextItem") {
      return await handleGetNextItem(payload);
    }

    // GetPreviousItem: 前のトラック
    if (namespace === "Alexa.Audio.PlayQueue" && name === "GetPreviousItem") {
      return await handleGetPreviousItem(payload);
    }

    // GetItem: ストリームURLの再取得（期限切れ対応）
    if (namespace === "Alexa.Audio.PlayQueue" && name === "GetItem") {
      return await handleGetItem(payload);
    }

    // 未対応のリクエスト
    console.warn(`未対応のリクエスト: ${namespace}.${name}`);
    return {
      header: {
        namespace: namespace,
        name: "ErrorResponse",
        messageId: header?.messageId ?? "unknown",
        payloadVersion: "1.0",
      },
      payload: {
        type: "INTERNAL_ERROR",
        message: `${namespace}.${name} は未対応です`,
      },
    };
  } catch (error) {
    console.error("ハンドラエラー:", error);
    return {
      header: {
        namespace: namespace ?? "Alexa",
        name: "ErrorResponse",
        messageId: header?.messageId ?? "unknown",
        payloadVersion: "1.0",
      },
      payload: {
        type: "INTERNAL_ERROR",
        message: "内部エラーが発生しました",
      },
    };
  }
}
