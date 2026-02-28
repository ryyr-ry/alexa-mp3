/** アーティストデータモデル */
export interface Artist {
  id: string;        // artist.{FNV-1a 64bit hash}
  name: string;      // 正式名
  keywords: string;  // カンマ区切り検索キーワード
  trackCount: number; // 所属曲数（JOINで取得）
}
