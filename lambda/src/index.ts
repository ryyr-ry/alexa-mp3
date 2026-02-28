import { handleGetPlayableContent } from "./handlers/get-playable-content";
import { handleInitiate } from "./handlers/initiate";
import { handleGetNextItem } from "./handlers/get-next-item";
import { handleGetPreviousItem } from "./handlers/get-previous-item";
import { handleGetItem } from "./handlers/get-item";

/** Music Skill API リクエスト型 */
interface MusicSkillRequest {
  header?: { namespace: string; name: string; messageId?: string; payloadVersion?: string };
  payload?: Record<string, unknown>;
  // 標準Skill API形式のフォールバック用
  request?: { type: string; intent?: { name: string } };
  session?: Record<string, unknown>;
  version?: string;
}

/** Music Skill API レスポンス型 */
interface MusicSkillResponse {
  header?: { namespace: string; name: string; messageId: string; payloadVersion: string };
  payload?: Record<string, unknown>;
  // 標準Skill API形式レスポンス
  version?: string;
  response?: Record<string, unknown>;
}

/**
 * AWS Lambda エントリポイント
 * Music Skill APIのリクエストをルーティングし、対応するハンドラに委譲する
 * 標準Skill API形式（LaunchRequest等）にも対応
 */
export async function handler(event: MusicSkillRequest): Promise<MusicSkillResponse> {
  console.log("受信イベント:", JSON.stringify(event).slice(0, 500));

  // ===========================================================
  // 標準Skill API形式（request.type）の処理
  // AlexaはMusic Skillでも LaunchRequest / SessionEndedRequest を送る場合がある
  // ===========================================================
  if (event.request?.type) {
    const requestType = event.request.type;
    console.log("標準Skill API形式:", requestType);

    if (requestType === "LaunchRequest") {
      return {
        version: "1.0",
        response: {
          outputSpeech: {
            type: "PlainText",
            text: "音楽プレーヤーです。曲名やアーティスト名で再生できます。",
          },
          shouldEndSession: false,
        },
      };
    }

    if (requestType === "SessionEndedRequest") {
      return { version: "1.0", response: {} };
    }

    // IntentRequest（標準スキルのインテント）
    if (requestType === "IntentRequest") {
      const intentName = event.request.intent?.name;
      console.log("IntentRequest:", intentName);

      // Alexa組み込みインテント
      if (intentName === "AMAZON.StopIntent" || intentName === "AMAZON.CancelIntent") {
        return {
          version: "1.0",
          response: {
            outputSpeech: { type: "PlainText", text: "停止します。" },
            shouldEndSession: true,
          },
        };
      }
      if (intentName === "AMAZON.HelpIntent") {
        return {
          version: "1.0",
          response: {
            outputSpeech: {
              type: "PlainText",
              text: "曲名やアーティスト名を言ってください。例えば、ビリーロムの曲をかけて、と言ってみてください。",
            },
            shouldEndSession: false,
          },
        };
      }

      // その他のインテント
      return {
        version: "1.0",
        response: {
          outputSpeech: { type: "PlainText", text: "曲名やアーティスト名で再生できます。" },
          shouldEndSession: false,
        },
      };
    }

    // 未知の標準形式リクエスト
    return { version: "1.0", response: {} };
  }

  // ===========================================================
  // Music Skill API形式（header.namespace + header.name）の処理
  // ===========================================================
  const { header, payload } = event;
  const namespace = header?.namespace;
  const name = header?.name;

  if (!namespace || !name) {
    console.error("不明なリクエスト形式:", JSON.stringify(event).slice(0, 300));
    return { version: "1.0", response: {} };
  }

  console.log("Music Skill API:", `${namespace}.${name}`);

  try {
    // GetPlayableContent: 「〇〇を再生して」
    if (namespace === "Alexa.Media.Search" && name === "GetPlayableContent") {
      return await handleGetPlayableContent(payload ?? {});
    }

    // Initiate: 再生開始
    if (namespace === "Alexa.Media.Playback" && name === "Initiate") {
      return await handleInitiate(payload as { contentId: string });
    }

    // GetNextItem: 次のトラック
    if (namespace === "Alexa.Audio.PlayQueue" && name === "GetNextItem") {
      return await handleGetNextItem(payload ?? {});
    }

    // GetPreviousItem: 前のトラック
    if (namespace === "Alexa.Audio.PlayQueue" && name === "GetPreviousItem") {
      return await handleGetPreviousItem(payload ?? {});
    }

    // GetItem: ストリームURLの再取得（期限切れ対応）
    if (namespace === "Alexa.Audio.PlayQueue" && name === "GetItem") {
      return await handleGetItem(payload ?? {});
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
