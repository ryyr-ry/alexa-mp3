import type * as Party from "partykit/server";
import type { TrackInput } from "./models/track";
import { generateTrackId } from "./models/track";
import {
  handleGetTracks,
  handleGetTrack,
  handleAddTrack,
  handleUpdateTrack,
  handleArchiveTrack,
} from "./handlers/track-handler";
import {
  handleGetPlaylists,
  handleGetPlaylist,
  handleCreatePlaylist,
  handleUpdatePlaylist,
  handleArchivePlaylist,
} from "./handlers/playlist-handler";
import { handleAlexaRequest } from "./handlers/alexa-handler";
import { jsonResponse } from "./utils/json-response";
import { TursoDb } from "./utils/db";
import { R2Client } from "./utils/r2-client";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default class MusicServer implements Party.Server {
  private readonly db: TursoDb;
  private readonly r2: R2Client;
  private readonly apiSecret: string;
  private initialized = false;

  constructor(readonly room: Party.Room) {
    const env = (room as unknown as { env: Record<string, string> }).env ?? {};
    this.db = new TursoDb({
      url: env["TURSO_URL"] ?? "",
      authToken: env["TURSO_AUTH_TOKEN"] ?? "",
    });
    this.r2 = new R2Client({
      endpoint: env["R2_ENDPOINT"] ?? "",
      bucket: env["R2_BUCKET"] ?? "alexa-mp3",
      accessKey: env["R2_ACCESS_KEY"] ?? "",
      secretKey: env["R2_SECRET_KEY"] ?? "",
    });
    this.apiSecret = env["API_SECRET"] ?? "";

    // 必須環境変数の起動時バリデーション
    const required = ["TURSO_URL", "TURSO_AUTH_TOKEN", "R2_ENDPOINT", "R2_ACCESS_KEY", "R2_SECRET_KEY", "API_SECRET"];
    const missing = required.filter((k) => !env[k]);
    if (missing.length > 0) {
      console.error(`[Server] 必須環境変数が未設定: ${missing.join(", ")}`);
    }
    console.log("[Server] MusicServer初期化完了");
  }

  /** DB初期化（初回のみ。ロックはTursoDb.initialize()内で保証） */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.db.initialize();
    this.initialized = true;
  }

  // ===========================================================
  // ブロードキャスト
  // ===========================================================

  private async broadcastState(): Promise<void> {
    const tracks = await this.db.getTracks();
    const playlists = await this.db.getPlaylists();
    const message = JSON.stringify({
      type: "state-update",
      state: { activeTracks: tracks, playlists },
    });
    for (const conn of this.room.getConnections()) {
      conn.send(message);
    }
  }

  // ===========================================================
  // 認証ヘルパー
  // ===========================================================

  private isAuthorized(req: Party.Request): boolean {
    if (!this.apiSecret) {
      console.warn("[Auth] API_SECRETが未設定。保護ルートへのアクセスを拒否します。");
      return false;
    }
    const auth = req.headers.get("Authorization");
    return auth === `Bearer ${this.apiSecret}`;
  }

  // ===========================================================
  // WebSocket
  // ===========================================================

  async onConnect(conn: Party.Connection): Promise<void> {
    await this.ensureInitialized();
    console.log(`[WS] 接続: ${conn.id}`);
    const tracks = await this.db.getTracks();
    const playlists = await this.db.getPlaylists();
    conn.send(
      JSON.stringify({
        type: "state-update",
        state: { activeTracks: tracks, playlists },
      })
    );
  }

  async onMessage(
    message: string | ArrayBuffer,
    sender: Party.Connection
  ): Promise<void> {
    await this.ensureInitialized();

    // --- バイナリ: MP3アップロード ---
    if (typeof message !== "string") {
      try {
        const bytes = new Uint8Array(message as ArrayBuffer);
        const sepIdx = bytes.indexOf(0);
        if (sepIdx === -1) return;

        const meta = JSON.parse(
          new TextDecoder().decode(bytes.slice(0, sepIdx))
        ) as { action: string; trackId: string };
        const mp3Bytes = bytes.slice(sepIdx + 1);

        if (meta.action === "upload-mp3") {
          console.log(`[Upload] MP3保存開始: ${meta.trackId} (${mp3Bytes.length}bytes)`);
          await this.r2.put(`mp3/${meta.trackId}.mp3`, mp3Bytes, "audio/mpeg");
          console.log(`[Upload] MP3保存完了: ${meta.trackId}`);
          sender.send(
            JSON.stringify({ type: "upload-complete", trackId: meta.trackId })
          );
        }
      } catch (err) {
        console.error("[Upload] エラー:", err);
        sender.send(
          JSON.stringify({ type: "error", message: "MP3アップロードに失敗しました" })
        );
      }
      return;
    }

    // --- テキスト: JSON操作 ---
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case "add-track": {
          const input: TrackInput = data.input;
          const id = generateTrackId();
          const track = await handleAddTrack(this.db, id, input);

          if (input.artDataUrl) {
            await this.saveArt(id, input.artDataUrl);
          }

          console.log(`[Track] 追加: ${track.title}`);
          sender.send(
            JSON.stringify({ type: "track-added", track })
          );
          break;
        }

        case "update-track": {
          const { trackId, title, artist, album } = data;
          const ok = await handleUpdateTrack(this.db, trackId, { title, artist, album });
          if (!ok) {
            sender.send(
              JSON.stringify({ type: "error", message: "曲が見つかりません" })
            );
            return;
          }
          console.log(`[Track] 更新: ${trackId}`);
          break;
        }

        case "archive-track": {
          const ok = await handleArchiveTrack(this.db, data.trackId);
          if (!ok) {
            sender.send(
              JSON.stringify({ type: "error", message: "曲が見つかりません" })
            );
            return;
          }
          try {
            await this.r2.delete(`mp3/${data.trackId}.mp3`);
            await this.r2.delete(`art/${data.trackId}.jpg`);
          } catch (r2Err) {
            console.error(`[R2] アーカイブ時のR2削除失敗 (孤立ファイル残存): ${data.trackId}`, r2Err);
          }
          console.log(`[Track] アーカイブ: ${data.trackId}`);
          break;
        }

        case "create-playlist": {
          const playlist = await handleCreatePlaylist(this.db, {
            name: data.name,
            trackIds: data.trackIds,
          });
          console.log(`[Playlist] 作成: ${data.name}`);
          sender.send(
            JSON.stringify({ type: "playlist-created", playlist })
          );
          break;
        }

        case "update-playlist": {
          const ok = await handleUpdatePlaylist(this.db, data.playlistId, {
            name: data.name,
            trackIds: data.trackIds,
          });
          if (!ok) {
            sender.send(
              JSON.stringify({ type: "error", message: "プレイリストが見つかりません" })
            );
            return;
          }
          break;
        }

        case "archive-playlist": {
          const ok = await handleArchivePlaylist(this.db, data.playlistId);
          if (!ok) {
            sender.send(
              JSON.stringify({ type: "error", message: "プレイリストが見つかりません" })
            );
            return;
          }
          console.log(`[Playlist] アーカイブ: ${data.playlistId}`);
          break;
        }

        default:
          sender.send(
            JSON.stringify({ type: "error", message: `未知の操作: ${data.type}` })
          );
          return;
      }

      // 全クライアントに最新状態をブロードキャスト
      await this.broadcastState();
    } catch (err) {
      console.error("[WS] メッセージ処理エラー:", err);
      const errorMsg =
        err instanceof Error ? err.message : "不明なエラーが発生しました";
      sender.send(JSON.stringify({ type: "error", message: errorMsg }));
    }
  }

  // ===========================================================
  // HTTP API
  // ===========================================================

  async onRequest(req: Party.Request): Promise<Response> {
    await this.ensureInitialized();

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const fullPath = url.pathname;
    // PartyKitはURLに /parties/:party/:roomId プレフィックスを含む。
    // /api/ 以降を抽出してルーティングに使用する。
    const apiIdx = fullPath.indexOf("/api/");
    const path = apiIdx !== -1 ? fullPath.slice(apiIdx) : fullPath;

    // --- 公開API（認証不要） ---
    const publicResult = await this.handlePublicRoutes(path, req);
    if (publicResult) return publicResult;

    // --- 認証必須API ---
    if (!this.isAuthorized(req)) {
      return jsonResponse({ error: "Unauthorized" }, 401, { corsOrigin: null });
    }
    const protectedResult = await this.handleProtectedRoutes(path, req);
    if (protectedResult) {
      // 保護ルートはサーバー間通信のみ。CORSヘッダーを除去
      protectedResult.headers.delete("Access-Control-Allow-Origin");
      return protectedResult;
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }

  /** 公開ルート: UI用REST + メディア配信 */
  private async handlePublicRoutes(
    path: string,
    req: Party.Request
  ): Promise<Response | null> {
    // --- メディア配信（DB不要） ---
    const mp3Match = path.match(/^\/api\/mp3\/([^/]+)$/);
    if (mp3Match?.[1] && req.method === "GET") {
      const trackId = decodeURIComponent(mp3Match[1].replace(/\.mp3$/, ""));
      const data = await this.r2.get(`mp3/${trackId}.mp3`);
      if (!data) return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
      return new Response(data.data, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    const artMatch = path.match(/^\/api\/art\/([^/]+)$/);
    if (artMatch?.[1] && req.method === "GET") {
      const trackId = decodeURIComponent(artMatch[1].replace(/\.\w+$/, ""));
      const result = await this.r2.get(`art/${trackId}.jpg`);
      if (!result) return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
      return new Response(result.data, {
        headers: {
          "Content-Type": result.contentType,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // --- データAPI ---
    if (path === "/api/tracks" && req.method === "GET") {
      return handleGetTracks(this.db);
    }

    const trackMatch = path.match(/^\/api\/tracks\/([^/]+)$/);
    if (trackMatch?.[1] && req.method === "GET") {
      return handleGetTrack(this.db, decodeURIComponent(trackMatch[1]));
    }

    if (path === "/api/playlists" && req.method === "GET") {
      return handleGetPlaylists(this.db);
    }

    const plMatch = path.match(/^\/api\/playlists\/([^/]+)$/);
    if (plMatch?.[1] && req.method === "GET") {
      return handleGetPlaylist(this.db, decodeURIComponent(plMatch[1]));
    }

    // Alexaエンドポイント（AudioPlayer Interface + 標準Skill API）
    if (path === "/api/alexa" && req.method === "POST") {
      return this.handleAlexaRoute(req);
    }

    return null;
  }

  /** 保護ルート: 認証必須API */
  private async handleProtectedRoutes(
    path: string,
    req: Party.Request
  ): Promise<Response | null> {
    try {
      // archive-track（認証必須）
      const archiveTrackMatch = path.match(/^\/api\/tracks\/([^/]+)\/archive$/);
      if (archiveTrackMatch?.[1] && req.method === "POST") {
        const trackId = archiveTrackMatch[1];
        const ok = await handleArchiveTrack(this.db, trackId);
        if (!ok) return jsonResponse({ error: "Track not found" }, 404, { corsOrigin: null });
        try {
          await this.r2.delete(`mp3/${trackId}.mp3`);
          await this.r2.delete(`art/${trackId}.jpg`);
        } catch (r2Err) {
          console.error(`[R2] HTTP archive時のR2削除失敗: ${trackId}`, r2Err);
        }
        return jsonResponse({ success: true }, 200, { corsOrigin: null });
      }

      return null;
    } catch (err) {
      console.error("[Protected] リクエスト処理エラー:", err);
      return jsonResponse({ error: "Bad Request" }, 400, { corsOrigin: null });
    }
  }

  // ===========================================================
  // Alexa HTTP ルート
  // ===========================================================

  private async handleAlexaRoute(req: Party.Request): Promise<Response> {
    try {
      const body = await req.json() as Parameters<typeof handleAlexaRequest>[1];
      const baseUrl = new URL(req.url);
      // PartyKitのURL構造からベースURLを組み立てる
      const fullPath = baseUrl.pathname;
      const apiIdx = fullPath.indexOf("/api/");
      const prefix = apiIdx !== -1 ? fullPath.slice(0, apiIdx) : "";
      const origin = `${baseUrl.protocol}//${baseUrl.host}${prefix}`;

      const urlBuilder = {
        mp3: (trackId: string) => `${origin}/api/mp3/${encodeURIComponent(trackId)}.mp3`,
        art: (trackId: string) => `${origin}/api/art/${encodeURIComponent(trackId)}.jpg`,
      };

      const result = await handleAlexaRequest(this.db, body, urlBuilder);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("[Alexa] リクエスト処理エラー:", err);
      return new Response(
        JSON.stringify({ version: "1.0", response: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // ===========================================================
  // アートワーク保存ヘルパー
  // ===========================================================

  private async saveArt(trackId: string, dataUrl: string): Promise<void> {
    if (!dataUrl || !dataUrl.includes(",")) {
      console.warn(`[saveArt] 不正なdata:URL形式: ${trackId}`);
      return;
    }
    const [header, b64] = dataUrl.split(",");
    if (!b64 || !header?.startsWith("data:")) {
      console.warn(`[saveArt] data:URLのパース失敗: ${trackId}`);
      return;
    }
    const mime = header.match(/data:([^;]+)/)?.[1] ?? "image/jpeg";
    const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await this.r2.put(`art/${trackId}.jpg`, binary, mime);
  }
}
