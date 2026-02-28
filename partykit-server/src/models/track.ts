/** 曲データモデル（Turso DB対応） */
export interface Track {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  album: string;
  duration: number;
  /** 検索用キーワード（ニックネーム・別名等、カンマ区切り） */
  keywords: string;
  addedAt: string;
}

/** 新規曲作成用の入力型（artDataUrlはアップロード時のみ使用、DBには保存しない） */
export interface TrackInput {
  title: string;
  artist: string;
  album: string;
  duration: number;
  artDataUrl: string | null;
}

/** トラックIDの生成 */
export function generateTrackId(): string {
  return `track.${crypto.randomUUID()}`;
}
