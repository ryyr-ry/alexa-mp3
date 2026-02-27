import { getPreviousTrack, buildMp3Url } from "../clients/partykit-client";
import {
  buildItemResponse,
  buildQueueFinishedResponse,
} from "../utils/response-builder";

/**
 * GetPreviousItem ハンドラ
 *
 * ユーザーが「前の曲」と言った時に呼ばれる
 */
interface ItemPayload {
  currentItemReference?: {
    value?: {
      id?: string;
      queueId?: string;
    };
  };
}

export async function handleGetPreviousItem(payload: ItemPayload) {
  const currentItemId = payload?.currentItemReference?.value?.id;
  const queueId = payload?.currentItemReference?.value?.queueId ?? "default-queue";

  if (!currentItemId) {
    return buildQueueFinishedResponse(queueId);
  }

  const result = await getPreviousTrack(currentItemId);

  if (!result.hasPrevious || !result.track) {
    return buildQueueFinishedResponse(queueId);
  }

  const mp3Url = buildMp3Url(result.track.id);
  const hasMore = result.hasNext ?? false;

  return buildItemResponse(
    result.track,
    mp3Url,
    queueId,
    hasMore,
    !hasMore
  );
}
