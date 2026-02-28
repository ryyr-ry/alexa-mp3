/**
 * HTTP JSONレスポンスの共通ヘルパー
 *
 * CORSオリジン:
 *   - 公開API（トラック、プレイリスト、アーティスト等）: "*"
 *   - 認証必須ルート: 明示的オリジンのみ or なし
 */

interface JsonResponseOptions {
  /** CORSのAccess-Control-Allow-Origin。デフォルト"*" */
  corsOrigin?: string | null;
}

export function jsonResponse(
  data: unknown,
  status = 200,
  options: JsonResponseOptions = {}
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // corsOriginがnullの場合はCORSヘッダーを付与しない
  const origin = options.corsOrigin !== undefined ? options.corsOrigin : "*";
  if (origin !== null) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return new Response(JSON.stringify(data), { status, headers });
}
