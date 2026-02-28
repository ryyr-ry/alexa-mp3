# ============================================================
# Alexa Music Skill カタログアップロードスクリプト (PowerShell版)
#
# 使い方:
#   .\scripts\upload-catalog.ps1 `
#     -PartyKitUrl "https://alexa-mp3-player.yourname.partykit.dev" `
#     -SkillId "amzn1.ask.skill.xxxxx" `
#     -TrackCatalogId "amzn1.ask-catalog.cat.xxxxx" `
#     -ArtistCatalogId "amzn1.ask-catalog.cat.xxxxx" `
#     -PlaylistCatalogId "amzn1.ask-catalog.cat.xxxxx"
#
# 前提条件:
#   - ASK CLI がインストール済み (npm i -g ask-cli)
#   - ask configure 済み
#   - PartyKitサーバーがデプロイ済み
# ============================================================

param(
    [Parameter(Mandatory=$true)]
    [string]$PartyKitUrl,

    [Parameter(Mandatory=$true)]
    [string]$SkillId,

    [string]$TrackCatalogId,
    [string]$ArtistCatalogId,
    [string]$PlaylistCatalogId,

    [string]$RoomId = "alexa-mp3-main",
    [string]$OutputDir = "catalog_output"
)

$ErrorActionPreference = "Stop"

# ===== 出力ディレクトリ =====
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " Alexa カタログ自動生成 & アップロード"   -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# ===== Step 1: カタログJSONをPartyKitから取得 =====
Write-Host ""
Write-Host "[1/4] カタログJSONを生成中..." -ForegroundColor Yellow

$baseUrl = "$PartyKitUrl/party/$RoomId/api/catalog"

$catalogTypes = @(
    @{ Name = "トラック";       File = "catalog_tracks.json";    Endpoint = "MusicRecording" }
    @{ Name = "アーティスト";   File = "catalog_artists.json";   Endpoint = "MusicGroup" }
    @{ Name = "プレイリスト";   File = "catalog_playlists.json"; Endpoint = "MusicPlaylist" }
)

foreach ($cat in $catalogTypes) {
    $url = "$baseUrl/$($cat.Endpoint)"
    $outPath = Join-Path $OutputDir $cat.File
    try {
        Invoke-RestMethod -Uri $url -OutFile $outPath -ErrorAction Stop
        Write-Host "  -> $($cat.Name): $outPath" -ForegroundColor Green
    } catch {
        Write-Host "  !! $($cat.Name)カタログの取得に失敗: $_" -ForegroundColor Red
        exit 1
    }
}

# ===== Step 2: カタログ作成（IDが未指定の場合のみ） =====
Write-Host ""
Write-Host "[2/4] カタログの確認..." -ForegroundColor Yellow

$catalogConfig = @(
    @{ Param = "TrackCatalogId";    Title = "MyTracks";    Type = "AMAZON.MusicRecording"; Usage = "AlexaMusic.Catalog.MusicRecording" }
    @{ Param = "ArtistCatalogId";   Title = "MyArtists";   Type = "AMAZON.MusicGroup";     Usage = "AlexaMusic.Catalog.MusicGroup" }
    @{ Param = "PlaylistCatalogId"; Title = "MyPlaylists"; Type = "AMAZON.MusicPlaylist";  Usage = "AlexaMusic.Catalog.MusicPlaylist" }
)

# IDが未指定のカタログを自動作成
foreach ($cfg in $catalogConfig) {
    $currentId = Get-Variable -Name $cfg.Param -ValueOnly -ErrorAction SilentlyContinue
    if ([string]::IsNullOrEmpty($currentId)) {
        Write-Host "  -> $($cfg.Title) を作成中..." -ForegroundColor Cyan
        $result = ask smapi create-catalog --title $cfg.Title --type $cfg.Type --usage $cfg.Usage 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  !! カタログ作成失敗: $result" -ForegroundColor Red
            exit 1
        }
        $parsed = $result | ConvertFrom-Json
        $newId = $parsed.id
        Set-Variable -Name $cfg.Param -Value $newId
        Write-Host "  -> 作成完了: $newId" -ForegroundColor Green
    } else {
        Write-Host "  -> $($cfg.Title): $currentId (既存)" -ForegroundColor DarkGray
    }
}

# ===== Step 3: スキルとの関連付け =====
Write-Host ""
Write-Host "[3/4] スキルとの関連付け..." -ForegroundColor Yellow

foreach ($cfg in $catalogConfig) {
    $catId = Get-Variable -Name $cfg.Param -ValueOnly
    if (-not [string]::IsNullOrEmpty($catId)) {
        Write-Host "  -> $($cfg.Title) を関連付け中..."
        $assocResult = ask smapi associate-catalog-with-skill --skill-id $SkillId --catalog-id $catId 2>&1
        if ($LASTEXITCODE -ne 0) {
            # 既に関連付け済みの場合もエラーになるが問題なし
            Write-Host "  -> $($cfg.Title): 既に関連付け済みまたは完了" -ForegroundColor DarkGray
        } else {
            Write-Host "  -> $($cfg.Title): 関連付け完了" -ForegroundColor Green
        }
    }
}

# ===== Step 4: カタログデータのアップロード =====
Write-Host ""
Write-Host "[4/4] カタログデータをアップロード中..." -ForegroundColor Yellow

$uploadMap = @(
    @{ Param = "TrackCatalogId";    File = "catalog_tracks.json";    Name = "トラック" }
    @{ Param = "ArtistCatalogId";   File = "catalog_artists.json";   Name = "アーティスト" }
    @{ Param = "PlaylistCatalogId"; File = "catalog_playlists.json"; Name = "プレイリスト" }
)

foreach ($item in $uploadMap) {
    $catId = Get-Variable -Name $item.Param -ValueOnly
    $filePath = Join-Path $OutputDir $item.File
    if ([string]::IsNullOrEmpty($catId)) {
        Write-Host "  !! $($item.Name): カタログIDが未設定、スキップ" -ForegroundColor DarkYellow
        continue
    }
    if (-not (Test-Path $filePath)) {
        Write-Host "  !! $($item.Name): ファイル未検出 ($filePath)" -ForegroundColor Red
        continue
    }
    Write-Host "  -> $($item.Name) をアップロード中..."
    $uploadResult = ask smapi upload-catalog --catalog-id $catId --file $filePath 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  !! $($item.Name): アップロード失敗: $uploadResult" -ForegroundColor Red
    } else {
        Write-Host "  -> $($item.Name): アップロード完了" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " 完了！" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "カタログID一覧（次回実行時に指定可能）:" -ForegroundColor DarkGray
Write-Host "  -TrackCatalogId    `"$TrackCatalogId`""
Write-Host "  -ArtistCatalogId   `"$ArtistCatalogId`""
Write-Host "  -PlaylistCatalogId `"$PlaylistCatalogId`""
