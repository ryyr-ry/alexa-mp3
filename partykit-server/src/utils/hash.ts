/**
 * 安定ハッシュユーティリティ
 * アーティスト名・アルバム名から安定したIDを導出する
 *
 * 正規化: 小文字化 + 前後空白除去 + Unicode NFKC正規化
 * ハッシュ: FNV-1a 64bitを使用（djb2の32bit衝突リスクを排除）
 */

/** 入力を正規化（小文字化+前後空白除去+NFKC） */
export function normalize(str: string): string {
  return str.normalize("NFKC").toLowerCase().trim();
}

/** アーティスト名からIDを導出 */
export function deriveArtistId(artistName: string): string {
  return `artist.${fnv1a64(normalize(artistName))}`;
}

/** アルバム名からIDを導出 */
export function deriveAlbumId(albumName: string): string {
  return `album.${fnv1a64(normalize(albumName))}`;
}

/**
 * FNV-1a 64bitハッシュ（base36変換）
 * djb2の32bit（約6.5万件で50%衝突）と比較して衝突確率を大幅に低減
 * 同期関数のためWeb Crypto APIではなくBigIntベースの実装を使用
 */
function fnv1a64(str: string): string {
  const FNV_OFFSET = 14695981039346656037n;
  const FNV_PRIME = 1099511628211n;
  let hash = FNV_OFFSET;
  const bytes = new TextEncoder().encode(str);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & 0xFFFFFFFFFFFFFFFFn;
  }
  return hash.toString(36);
}
