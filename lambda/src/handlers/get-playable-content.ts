import { resolveEntity } from "../clients/partykit-client";
import {
  buildGetPlayableContentResponse,
  buildContentNotFoundResponse,
} from "../utils/response-builder";

/**
 * GetPlayableContent ハンドラ
 *
 * Alexaからの「○○を再生して」リクエストを処理し、
 * PartyKitに問い合わせてコンテンツIDを返す
 */
interface SelectionAttribute {
  type: string;
  entityId: string;
}

interface GetPlayableContentPayload {
  selectionCriteria?: {
    attributes?: SelectionAttribute[];
  };
}

export async function handleGetPlayableContent(payload: GetPlayableContentPayload) {
  const { selectionCriteria } = payload;
  const attributes = selectionCriteria?.attributes ?? [];

  // エンティティ情報を抽出
  let entityId: string | null = null;
  let entityType = "TRACK";

  for (const attr of attributes) {
    if (attr.type === "TRACK" || attr.type === "ARTIST" || attr.type === "PLAYLIST") {
      entityId = attr.entityId;
      entityType = attr.type;
      break;
    }
  }

  if (!entityId) {
    // selectionCriteriaが空の場合（「アレクサ、○○で再生して」）→ 全曲
    const result = await resolveEntity("", "ALL");
    if (!result.found) {
      return buildContentNotFoundResponse();
    }
    return buildGetPlayableContentResponse("content::all::");
  }

  // PartyKitにエンティティを問い合わせ
  const result = await resolveEntity(entityId, entityType);

  if (!result.found) {
    return buildContentNotFoundResponse();
  }

  // contentIdを生成して返す（実際のトラック情報はInitiate時に取得）
  // ::区切りでハイフン安全（entityIdにハイフンが含まれてもパース可能）
  const contentId = `content::${entityType.toLowerCase()}::${entityId}`;
  return buildGetPlayableContentResponse(contentId);
}
