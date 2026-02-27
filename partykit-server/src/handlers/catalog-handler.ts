import type { TursoDb } from "../utils/db";
import { deriveArtistId, deriveAlbumId, normalize } from "../utils/hash";
import { jsonResponse } from "../utils/json-response";

/**
 * カタログJSON自動生成ハンドラ
 * PartyKit上の曲データからAmazonのカタログ形式JSONを生成する
 * アーカイブ済み曲はdeleted:trueとして含める（Alexa側のカタログから削除するため）
 */

/** AMAZON.MusicRecording（トラック）カタログを生成 */
async function generateTrackCatalog(db: TursoDb): Promise<object> {
  const tracks = await db.getTracks();
  const archivedTracks = await db.getArchivedTracks();

  const activeEntities = tracks.map((track) => ({
    id: track.id,
    names: [{ language: "ja", value: track.title }],
    popularity: { default: 100 },
    lastUpdatedTime: track.addedAt,
    locales: [{ country: "JP", language: "ja" }],
    languageOfContent: ["ja"],
    artists: [
      {
        id: deriveArtistId(track.artist),
        names: [{ language: "ja", value: track.artist }],
      },
    ],
    albums: track.album
      ? [
          {
            id: deriveAlbumId(track.album),
            names: [{ language: "ja", value: track.album }],
          },
        ]
      : [],
    // NOTE: このdeletedフィールドはAmazonカタログ仕様の必須項目であり、
    // アプリ側の論理削除フラグではない。
    deleted: false,
  }));

  // アーカイブ済み曲はdeleted:trueでAlexaカタログから除外
  const deletedEntities = archivedTracks.map((track) => ({
    id: track.id,
    names: [{ language: "ja", value: track.title }],
    popularity: { default: 0 },
    lastUpdatedTime: track.addedAt,
    locales: [{ country: "JP", language: "ja" }],
    languageOfContent: ["ja"],
    artists: [],
    albums: [],
    deleted: true,
  }));

  return {
    type: "AMAZON.MusicRecording",
    version: 2.0,
    locales: [{ country: "JP", language: "ja" }],
    entities: [...activeEntities, ...deletedEntities],
  };
}

/** AMAZON.MusicGroup（アーティスト）カタログを生成 */
async function generateArtistCatalog(db: TursoDb): Promise<object> {
  const tracks = await db.getTracks();
  const artistMap = new Map<string, { id: string; name: string; latestAddedAt: string }>();
  for (const track of tracks) {
    if (!track.artist) continue;
    const normalized = normalize(track.artist);
    const existing = artistMap.get(normalized);
    if (!existing || track.addedAt > existing.latestAddedAt) {
      artistMap.set(normalized, { id: deriveArtistId(track.artist), name: track.artist, latestAddedAt: track.addedAt });
    }
  }

  const entities = Array.from(artistMap.values()).map(({ id, name, latestAddedAt }) => ({
    id,
    names: [{ language: "ja", value: name }],
    popularity: { default: 100 },
    lastUpdatedTime: latestAddedAt,
    locales: [{ country: "JP", language: "ja" }],
    deleted: false,
  }));

  return {
    type: "AMAZON.MusicGroup",
    version: 2.0,
    locales: [{ country: "JP", language: "ja" }],
    entities,
  };
}

/** AMAZON.MusicPlaylist（プレイリスト）カタログを生成 */
async function generatePlaylistCatalog(db: TursoDb): Promise<object> {
  const playlists = await db.getPlaylists();
  const archivedPlaylists = await db.getArchivedPlaylists();

  const activeEntities = playlists.map((pl) => ({
    id: pl.id,
    names: [{ language: "ja", value: pl.name }],
    popularity: { default: 100 },
    lastUpdatedTime: pl.updatedAt,
    locales: [{ country: "JP", language: "ja" }],
    deleted: false,
  }));

  const deletedEntities = archivedPlaylists.map((pl) => ({
    id: pl.id,
    names: [{ language: "ja", value: pl.name }],
    popularity: { default: 0 },
    lastUpdatedTime: pl.createdAt,
    locales: [{ country: "JP", language: "ja" }],
    deleted: true,
  }));

  return {
    type: "AMAZON.MusicPlaylist",
    version: 2.0,
    locales: [{ country: "JP", language: "ja" }],
    entities: [...activeEntities, ...deletedEntities],
  };
}

/** カタログタイプに応じたJSONを返す */
export async function handleGetCatalog(
  db: TursoDb,
  catalogType: string
): Promise<Response> {
  let catalog: object;

  switch (catalogType) {
    case "MusicRecording":
      catalog = await generateTrackCatalog(db);
      break;
    case "MusicGroup":
      catalog = await generateArtistCatalog(db);
      break;
    case "MusicPlaylist":
      catalog = await generatePlaylistCatalog(db);
      break;
    default:
      return jsonResponse({ error: `Unknown catalog type: ${catalogType}` }, 400);
  }

  return jsonResponse(catalog);
}
