import { resolveEntity, getNextTrack, buildMp3Url } from "../clients/partykit-client";
import {
  buildItemResponse,
  buildQueueFinishedResponse,
} from "../utils/response-builder";

/**
 * GetItem ハンドラ
 *
 * ストリームURLの更新要求。現在再生中のアイテムの最新URLを返す。
 * GetNextItemとは異なり、「次の曲」ではなく「現在の曲」のURL再取得。
 */
interface ItemPayload {
  currentItemReference?: {
    value?: {
      id?: string;
      queueId?: string;
    };
  };
}

export async function handleGetItem(payload: ItemPayload) {
  const currentItemId = payload?.currentItemReference?.value?.id;
  const queueId = payload?.currentItemReference?.value?.queueId ?? "default-queue";

  if (!currentItemId) {
    return buildQueueFinishedResponse(queueId);
  }

  // 現在のトラック情報を再取得
  const result = await resolveEntity(currentItemId, "TRACK");

  if (!result.found || !result.track) {
    return buildQueueFinishedResponse(queueId);
  }

  const mp3Url = buildMp3Url(result.track.id);

  // キュー状態を確認して動的にhasMore/isLastを決定
  const nextResult = await getNextTrack(result.track.id);
  const hasMore = nextResult.hasNext ?? false;

  return buildItemResponse(
    result.track,
    mp3Url,
    queueId,
    hasMore,
    !hasMore
  );
}
