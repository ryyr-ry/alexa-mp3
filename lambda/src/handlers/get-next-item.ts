import { getNextTrack, buildMp3Url } from "../clients/partykit-client";
import {
  buildItemResponse,
  buildQueueFinishedResponse,
} from "../utils/response-builder";

/**
 * GetNextItem ハンドラ
 *
 * 再生中の曲が終わりかけた時、またはユーザーが「次の曲」と言った時に呼ばれる
 */
interface ItemPayload {
  currentItemReference?: {
    value?: {
      id?: string;
      queueId?: string;
    };
  };
}

export async function handleGetNextItem(payload: ItemPayload) {
  const currentItemId = payload?.currentItemReference?.value?.id;
  const queueId = payload?.currentItemReference?.value?.queueId ?? "default-queue";

  if (!currentItemId) {
    return buildQueueFinishedResponse(queueId);
  }

  const result = await getNextTrack(currentItemId);

  if (!result.hasNext || !result.track) {
    return buildQueueFinishedResponse(queueId);
  }

  const mp3Url = buildMp3Url(result.track.id);
  const hasMore = result.hasFurtherNext ?? false;

  return buildItemResponse(
    result.track,
    mp3Url,
    queueId,
    hasMore,
    !hasMore
  );
}
