/**
 * PartyKit HTTP APIクライアント
 * Lambda → PartyKit間の通信を担う
 *
 * 認証: API_SECRET環境変数でBearer tokenを設定
 */

const PARTYKIT_BASE_URL = process.env["PARTYKIT_URL"] ?? "";
const ROOM_ID = "alexa-mp3-main";
const API_SECRET = process.env["API_SECRET"] ?? "";

if (!PARTYKIT_BASE_URL) {
  console.error("[PartyKit] 環境変数 PARTYKIT_URL が未設定です。全リクエストが失敗します。");
}
if (!API_SECRET) {
  console.error("[PartyKit] 環境変数 API_SECRET が未設定です。認証が必要なリクエストは拒否されます。");
}

/** PartyKitにHTTPリクエストを送信（Bearer認証+リトライ付き） */
async function fetchPartyKit(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${PARTYKIT_BASE_URL}/party/${ROOM_ID}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (API_SECRET) {
    headers["Authorization"] = `Bearer ${API_SECRET}`;
  }

  const MAX_RETRIES = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { ...options, headers });
      if (res.ok || res.status < 500) return res;
      // 5xx系はリトライ対象
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

/** PartyKit側Track型のミラー (partykit-server/src/models/track.ts と同期を保つこと) */
export interface TrackInfo {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  album: string;
  duration: number;
  addedAt: string;
}

interface ResolveResult {
  found: boolean;
  track?: TrackInfo;
  tracks?: TrackInfo[];
  playlist?: { id: string; name: string; trackIds: string[] };
  totalCount?: number;
}

interface NextPrevResult {
  hasNext?: boolean;
  hasPrevious?: boolean;
  hasFurtherNext?: boolean;
  track?: TrackInfo;
}

/** entityIdからトラックを解決 */
export async function resolveEntity(
  entityId: string,
  entityType: string
): Promise<ResolveResult> {
  const res = await fetchPartyKit("/api/resolve", {
    method: "POST",
    body: JSON.stringify({ entityId, entityType }),
  });
  if (!res.ok) {
    console.error(`[PartyKit] resolve failed: ${res.status}`);
    return { found: false };
  }
  return (await res.json()) as ResolveResult;
}

/** 次のトラックを取得 */
export async function getNextTrack(
  currentTrackId: string,
  playlistId?: string
): Promise<NextPrevResult> {
  const res = await fetchPartyKit("/api/next", {
    method: "POST",
    body: JSON.stringify({ currentTrackId, playlistId }),
  });
  if (!res.ok) {
    console.error(`[PartyKit] next failed: ${res.status}`);
    return { hasNext: false };
  }
  return (await res.json()) as NextPrevResult;
}

/** 前のトラックを取得 */
export async function getPreviousTrack(
  currentTrackId: string,
  playlistId?: string
): Promise<NextPrevResult> {
  const res = await fetchPartyKit("/api/previous", {
    method: "POST",
    body: JSON.stringify({ currentTrackId, playlistId }),
  });
  if (!res.ok) {
    console.error(`[PartyKit] previous failed: ${res.status}`);
    return { hasPrevious: false };
  }
  return (await res.json()) as NextPrevResult;
}

/** MP3のHTTPS配信URLを構築 */
export function buildMp3Url(trackId: string): string {
  return `${PARTYKIT_BASE_URL}/party/${ROOM_ID}/api/mp3/${encodeURIComponent(trackId)}.mp3`;
}

/** アートワークのHTTPS配信URLを構築 */
export function buildArtUrl(trackId: string): string {
  return `${PARTYKIT_BASE_URL}/party/${ROOM_ID}/api/art/${encodeURIComponent(trackId)}.jpg`;
}
