import {
  resolveEntity,
  buildMp3Url,
  type TrackInfo,
} from "../clients/partykit-client";
import {
  buildInitiateResponse,
  buildContentNotFoundResponse,
} from "../utils/response-builder";

/**
 * Initiate ハンドラ
 *
 * GetPlayableContent成功後にAlexaから呼ばれる
 * 最初のトラック情報（ストリームURL含む）を返す
 */
interface InitiatePayload {
  contentId: string;
}

export async function handleInitiate(payload: InitiatePayload) {
  const { contentId } = payload;
  const queueId = `queue-${Date.now().toString(36)}`;

  // contentIdの形式: "content::type::entityId" （::区切りでハイフン安全）
  // 後方互換: 旧形式 "content-{type}-{entityId}" もサポート
  let type: string;
  let entityId: string;

  if (contentId.includes("::")) {
    const segments = contentId.split("::");
    type = segments[1] ?? "";
    entityId = segments.slice(2).join("::");
  } else {
    if (contentId === "content-all") {
      type = "all";
      entityId = "";
    } else {
      const parts = contentId.split("-");
      type = parts[1] ?? "";
      entityId = parts.slice(2).join("-");
    }
  }

  let firstTrack: TrackInfo | null = null;
  let totalCount = 0;

  if (type === "all") {
    const result = await resolveEntity("", "ALL");
    if (!result.found || !result.tracks?.length) {
      return buildContentNotFoundResponse();
    }
    firstTrack = result.tracks[0] ?? null;
    totalCount = result.totalCount ?? result.tracks.length;
  } else if (type === "track") {
    const result = await resolveEntity(entityId, "TRACK");
    if (!result.found || !result.track) {
      return buildContentNotFoundResponse();
    }
    firstTrack = result.track;
    totalCount = 1;
  } else if (type === "artist") {
    const result = await resolveEntity(entityId, "ARTIST");
    if (!result.found || !result.tracks?.length) {
      return buildContentNotFoundResponse();
    }
    firstTrack = result.tracks[0] ?? null;
    totalCount = result.totalCount ?? result.tracks.length;
  } else if (type === "playlist") {
    const result = await resolveEntity(entityId, "PLAYLIST");
    if (!result.found || !result.tracks?.length) {
      return buildContentNotFoundResponse();
    }
    firstTrack = result.tracks[0] ?? null;
    totalCount = result.totalCount ?? result.tracks.length;
  }

  if (!firstTrack) {
    return buildContentNotFoundResponse();
  }

  const hasNext = totalCount > 1;
  const mp3Url = buildMp3Url(firstTrack.id);

  return buildInitiateResponse(
    firstTrack,
    mp3Url,
    queueId,
    hasNext
  );
}
