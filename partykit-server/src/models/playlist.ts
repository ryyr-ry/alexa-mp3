/** プレイリストデータモデル */
export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** プレイリストIDの生成 */
export function generatePlaylistId(): string {
  return `pl.${crypto.randomUUID()}`;
}
