#!/bin/bash
# ============================================================
# Alexa Music Skill カタログアップロードスクリプト
#
# 前提条件:
#   - ASK CLI がインストール済み (npm i -g ask-cli)
#   - ask configure 済み
#   - PartyKitサーバーがデプロイ済み
# ============================================================

set -euo pipefail

# ===== 設定 =====
PARTYKIT_URL="${PARTYKIT_URL:-}"
ROOM_ID="alexa-mp3-main"
SKILL_ID="${SKILL_ID:-}"
OUTPUT_DIR="./catalog_output"

if [ -z "$PARTYKIT_URL" ]; then
  echo "エラー: 環境変数 PARTYKIT_URL を設定してください" >&2
  exit 1
fi
if [ -z "$SKILL_ID" ]; then
  echo "エラー: 環境変数 SKILL_ID を設定してください" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "========================================="
echo " Alexa カタログ自動生成 & アップロード"
echo "========================================="

# ===== Step 1: カタログJSONをPartyKitから取得 =====
echo ""
echo "[1/4] カタログJSONを生成中..."

curl -sf "${PARTYKIT_URL}/party/${ROOM_ID}/api/catalog/MusicRecording" \
  -o "${OUTPUT_DIR}/catalog_tracks.json"
echo "  → トラックカタログ: ${OUTPUT_DIR}/catalog_tracks.json"

curl -sf "${PARTYKIT_URL}/party/${ROOM_ID}/api/catalog/MusicGroup" \
  -o "${OUTPUT_DIR}/catalog_artists.json"
echo "  → アーティストカタログ: ${OUTPUT_DIR}/catalog_artists.json"

curl -sf "${PARTYKIT_URL}/party/${ROOM_ID}/api/catalog/MusicPlaylist" \
  -o "${OUTPUT_DIR}/catalog_playlists.json"
echo "  → プレイリストカタログ: ${OUTPUT_DIR}/catalog_playlists.json"

# ===== Step 2: カタログ作成（初回のみ） =====
echo ""
echo "[2/4] カタログの作成... (既に存在する場合はスキップ)"

# トラックカタログ
TRACK_CATALOG_ID="${TRACK_CATALOG_ID:-}"
if [ -z "$TRACK_CATALOG_ID" ]; then
  echo "  → トラックカタログを作成してください:"
  echo "    ask smapi create-catalog --catalog-title 'MyTracks' --catalog-type 'AMAZON.MusicRecording' --catalog-usage 'AlexaMusic.Catalog.MusicRecording'"
  echo "    結果のcatalog IDをTRACK_CATALOG_ID環境変数に設定してください"
fi

# アーティストカタログ
ARTIST_CATALOG_ID="${ARTIST_CATALOG_ID:-}"
if [ -z "$ARTIST_CATALOG_ID" ]; then
  echo "  → アーティストカタログを作成してください:"
  echo "    ask smapi create-catalog --catalog-title 'MyArtists' --catalog-type 'AMAZON.MusicGroup' --catalog-usage 'AlexaMusic.Catalog.MusicGroup'"
fi

# ===== Step 3: カタログをスキルに関連付け（初回のみ） =====
echo ""
echo "[3/4] スキルとの関連付け... (既に関連付け済みの場合はスキップ)"
if [ -n "$TRACK_CATALOG_ID" ]; then
  echo "  → ask smapi associate-catalog-with-skill --skill-id $SKILL_ID --catalog-id $TRACK_CATALOG_ID"
fi

# ===== Step 4: カタログデータのアップロード =====
echo ""
echo "[4/4] カタログデータをアップロード中..."

if [ -n "$TRACK_CATALOG_ID" ]; then
  echo "  → トラックカタログをアップロード中..."
  ask smapi upload-catalog --catalog-id "$TRACK_CATALOG_ID" --file "${OUTPUT_DIR}/catalog_tracks.json" || echo "  ⚠ アップロードに失敗しました"
fi

if [ -n "$ARTIST_CATALOG_ID" ]; then
  echo "  → アーティストカタログをアップロード中..."
  ask smapi upload-catalog --catalog-id "$ARTIST_CATALOG_ID" --file "${OUTPUT_DIR}/catalog_artists.json" || echo "  ⚠ アップロードに失敗しました"
fi

PLAYLIST_CATALOG_ID="${PLAYLIST_CATALOG_ID:-}"
if [ -n "$PLAYLIST_CATALOG_ID" ]; then
  echo "  → プレイリストカタログをアップロード中..."
  ask smapi upload-catalog --catalog-id "$PLAYLIST_CATALOG_ID" --file "${OUTPUT_DIR}/catalog_playlists.json" || echo "  ⚠ アップロードに失敗しました"
else
  echo "  ⚠ PLAYLIST_CATALOG_IDが未設定のためプレイリストカタログはスキップ"
fi

echo ""
echo "========================================="
echo " 完了！"
echo "========================================="
echo ""
echo "環境変数の設定例:"
echo "  export PARTYKIT_URL=https://your-app.username.partykit.dev"
echo "  export SKILL_ID=amzn1.ask.skill.xxxxx"
echo "  export TRACK_CATALOG_ID=amzn1.ask.catalog.xxxxx"
echo "  export ARTIST_CATALOG_ID=amzn1.ask.catalog.xxxxx"
echo "  export PLAYLIST_CATALOG_ID=amzn1.ask.catalog.xxxxx"

