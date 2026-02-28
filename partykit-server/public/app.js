// =====================================================
// Alexa MP3 プレイヤー — Web UI
// =====================================================

// ---------- 設定 ----------
const PARTYKIT_HOST = location.host;
const ROOM_ID = "alexa-mp3-main";

/** トラックIDからアートワークURLを構築 */
function artUrl(trackId) {
  return `/party/${ROOM_ID}/api/art/${trackId}.jpg`;
}

// ---------- 状態 ----------
let state = { activeTracks: [], playlists: [], artists: [] };
let ws = null;
let searchQuery = "";
let sessionToken = null;

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const connectionDot  = $(".conn-dot");
const connectionText = $("#connectionText");
const pageTitle      = $("#pageTitle");
const trackCount     = $("#trackCount");
const addBtn         = $("#addBtn");
const uploadSheet    = $("#uploadSheet");
const uploadZone     = $("#uploadZone");
const fileInput      = $("#fileInput");
const uploadBar      = $("#uploadBar");
const uploadBarFill  = $("#uploadBarFill");
const uploadBarText  = $("#uploadBarText");
const trackList      = $("#trackList");
const playlistList   = $("#playlistList");
const playlistModal  = $("#playlistModal");
const playlistName   = $("#playlistName");
const trackSelector  = $("#trackSelector");
const searchInput    = $("#searchInput");
const toastContainer = $("#toastContainer");

// =====================================================
// トースト通知
// =====================================================
function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// =====================================================
// 確認ダイアログ
// =====================================================
function confirmAction(message, actionLabel = "削除") {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "confirm-backdrop";
    backdrop.innerHTML = `
      <div class="confirm-sheet">
        <p class="confirm-message">${esc(message)}</p>
        <div class="confirm-actions">
          <button class="btn-flat" id="confirmCancel">キャンセル</button>
          <button class="btn-danger" id="confirmOk">${esc(actionLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));

    backdrop.querySelector("#confirmCancel").onclick = () => {
      backdrop.remove();
      resolve(false);
    };
    backdrop.querySelector("#confirmOk").onclick = () => {
      backdrop.remove();
      resolve(true);
    };
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) { backdrop.remove(); resolve(false); }
    });
  });
}

// =====================================================
// WebSocket
// =====================================================
let reconnectAttempts = 0;

/** WS接続がOPENになるまで待つ（指数バックオフ上限内） */
function waitForConnection(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) return resolve();
    const start = Date.now();
    const check = () => {
      if (ws && ws.readyState === WebSocket.OPEN) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("WS reconnect timeout"));
      setTimeout(check, 500);
    };
    check();
  });
}

/** WS送信（指数バックオフリトライ付き、最大5回） */
async function safeSend(data, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      return true;
    }
    if (attempt === maxRetries) break;
    const delay = Math.min(1000 * Math.pow(2, attempt), 16000);
    console.log(`[Upload] WS未接続。${delay / 1000}秒後にリトライ (${attempt + 1}/${maxRetries})`);
    showToast(`接続待ち… (${attempt + 1}/${maxRetries})`, "info");
    try {
      await waitForConnection(delay + 5000);
    } catch {
      // タイムアウト — 次のリトライへ
    }
  }
  showToast("接続を回復できませんでした。ページを再読み込みしてください", "error");
  return false;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${PARTYKIT_HOST}/party/${ROOM_ID}?token=${encodeURIComponent(sessionToken || "")}`);

  ws.onopen = () => {
    connectionDot.className = "conn-dot connected";
    if (connectionText) connectionText.textContent = "接続中";
    reconnectAttempts = 0;
  };

  ws.onclose = (ev) => {
    connectionDot.className = "conn-dot disconnected";
    // セッション無効（4001 Unauthorized）→ 認証画面に戻す
    if (ev.code === 4001) {
      localStorage.removeItem("session");
      sessionToken = null;
      appMain.hidden = true;
      authScreen.hidden = false;
      boot();
      return;
    }
    reconnectAttempts++;
    const delay = Math.min(3000 * reconnectAttempts, 15000);
    if (connectionText) connectionText.textContent = `再接続中 (${Math.ceil(delay/1000)}秒後)...`;
    setTimeout(connect, delay);
  };

  ws.onerror = () => {
    connectionDot.className = "conn-dot disconnected";
  };

  ws.onmessage = (ev) => {
    // バイナリはスキップ
    if (typeof ev.data !== "string") return;

    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { return; }

    if (msg.type === "state-update") {
      state = msg.state;
      renderTracks();
      renderPlaylists();
      renderArtists();
    }

    if (msg.type === "track-added" && pendingUploads.length > 0) {
      const pending = pendingUploads.shift();
      if (pending) {
        uploadMp3(msg.track.id, pending.file).catch((err) => {
          console.error("[Upload] MP3アップロード失敗:", err);
          showToast("MP3アップロードに失敗しました", "error");
          uploadResolve?.();
        });
      }
    }

    if (msg.type === "error") {
      showToast(msg.message, "error");
    }

    if (msg.type === "upload-complete") {
      uploadResolve?.();
    }
  };
}

// =====================================================
// ファイルアップロード
// =====================================================
let uploadSheetOpen = false;
const pendingUploads = [];
let uploadResolve = null;

addBtn.addEventListener("click", () => {
  uploadSheetOpen = !uploadSheetOpen;
  uploadSheet.hidden = !uploadSheetOpen;
});

uploadZone.addEventListener("click", () => fileInput.click());

uploadZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadZone.classList.add("drag-over");
});

uploadZone.addEventListener("dragleave", () => {
  uploadZone.classList.remove("drag-over");
});

uploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadZone.classList.remove("drag-over");
  handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener("change", (e) => {
  handleFiles(e.target.files);
  fileInput.value = "";
});

let isUploading = false;

async function handleFiles(fileList) {
  if (isUploading) {
    showToast("アップロード中です。完了までお待ちください", "error");
    return;
  }
  const files = Array.from(fileList).filter(
    (f) => f.type === "audio/mpeg" || f.name.endsWith(".mp3")
  );
  if (!files.length) return;

  isUploading = true;
  uploadBar.hidden = false;
  uploadBarFill.style.width = "0%";

  for (let i = 0; i < files.length; i++) {
    uploadBarFill.style.width = `${((i + 1) / files.length) * 100}%`;
    uploadBarText.textContent = `${i + 1} / ${files.length} — ${files[i].name}`;
    await addTrackFromFile(files[i]);
  }

  isUploading = false;
  uploadBarText.textContent = "アップロード完了";
  showToast(`${files.length}曲をアップロードしました`, "success");
  setTimeout(() => { uploadBar.hidden = true; }, 2500);
}

async function addTrackFromFile(file) {
  // ID3タグとdurationを並行取得
  const [tags, duration] = await Promise.all([readId3(file), readDuration(file)]);
  const input = {
    title:      tags.title  || file.name.replace(/\.mp3$/i, ""),
    artist:     tags.artist || "不明なアーティスト",
    album:      tags.album  || "",
    duration:   Math.round(duration),
    artDataUrl: tags.art    || null,
  };

  pendingUploads.push({ file });
  const sent = await safeSend(JSON.stringify({ type: "add-track", input }));

  if (!sent) {
    // リトライ上限超え: pending除去して次に進む
    pendingUploads.pop();
    return;
  }

  // upload-complete を待って resolve
  return new Promise((resolve) => {
    uploadResolve = resolve;
  });
}

/** Audio要素でMP3のduration（秒）を取得 */
function readDuration(file) {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      resolve(isFinite(audio.duration) ? audio.duration : 0);
      URL.revokeObjectURL(audio.src);
    };
    audio.onerror = () => { URL.revokeObjectURL(audio.src); resolve(0); };
    audio.src = URL.createObjectURL(file);
  });
}

function readId3(file) {
  return new Promise((resolve) => {
    if (typeof jsmediatags === "undefined") {
      resolve({ title: null, artist: null, album: null, art: null });
      return;
    }
    jsmediatags.read(file, {
      onSuccess: (tag) => {
        const t = tag.tags;
        resolve({
          title: t.title || null,
          artist: t.artist || null,
          album: t.album || null,
          art: extractArt(t.picture),
        });
      },
      onError: () => resolve({ title: null, artist: null, album: null, art: null }),
    });
  });
}

function extractArt(picture) {
  if (!picture) return null;
  try {
    const { data, format } = picture;
    let bin = "";
    for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
    return `data:${format};base64,${btoa(bin)}`;
  } catch { return null; }
}

async function uploadMp3(trackId, file) {
  const buf = await file.arrayBuffer();
  const meta = new TextEncoder().encode(JSON.stringify({ action: "upload-mp3", trackId }));
  const mp3  = new Uint8Array(buf);
  const msg  = new Uint8Array(meta.length + 1 + mp3.length);
  msg.set(meta, 0);
  msg[meta.length] = 0;
  msg.set(mp3, meta.length + 1);
  safeSend(msg.buffer);
}

// =====================================================
// 検索 / フィルター
// =====================================================
if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value.toLowerCase();
    renderTracks();
  });
}

function filteredTracks() {
  if (!searchQuery) return state.activeTracks;
  return state.activeTracks.filter((t) =>
    t.title.toLowerCase().includes(searchQuery) ||
    t.artist.toLowerCase().includes(searchQuery) ||
    (t.album && t.album.toLowerCase().includes(searchQuery))
  );
}

// =====================================================
// レンダリング
// =====================================================
function renderTracks() {
  const tracks = filteredTracks();

  // 曲数カウント更新
  if (trackCount) {
    trackCount.textContent = `${state.activeTracks.length}曲`;
  }

  if (!tracks.length) {
    const emptyMsg = searchQuery ? "検索結果がありません" : "曲がまだありません";
    const emptySub = searchQuery ? "検索条件を変更してください" : "右上の＋ボタンからMP3を追加してください";
    trackList.innerHTML = `
      <div class="empty">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        </div>
        <p class="empty-title">${emptyMsg}</p>
        <p class="empty-sub">${emptySub}</p>
      </div>`;
    return;
  }

  trackList.innerHTML = tracks.map((t, i) => `
    <div class="track-row" data-track-id="${esc(t.id)}" data-track-title="${esc(t.title)}">
      <span class="track-num">${i + 1}</span>
      <div class="track-thumb">
        <img src="${artUrl(t.id)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <span class="track-thumb-placeholder" style="display:none">♪</span>
      </div>
      <div class="track-meta">
        <div class="track-name">${esc(t.title)}</div>
        <div class="track-sub">${esc(t.artist)}</div>
      </div>
      <span class="track-album">${esc(t.album)}</span>
      <button class="track-edit" data-action="edit" title="編集">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="track-remove" data-action="archive" title="削除">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join("");

  // イベント委譲: data属性ベースでXSS安全
  trackList.querySelectorAll("[data-action='edit']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.closest(".track-row")?.dataset.trackId;
      if (id) startEditTrack(id);
    });
  });
  trackList.querySelectorAll("[data-action='archive']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = btn.closest(".track-row");
      if (row) archiveTrack(row.dataset.trackId, row.dataset.trackTitle);
    });
  });
  trackList.querySelectorAll(".track-row").forEach((row) => {
    row.addEventListener("dblclick", () => {
      if (row.dataset.trackId) startEditTrack(row.dataset.trackId);
    });
  });
}

function renderPlaylists() {
  if (!state.playlists.length) {
    playlistList.innerHTML = `
      <div class="empty" style="grid-column: 1/-1">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/></svg>
        </div>
        <p class="empty-title">プレイリストがありません</p>
        <p class="empty-sub">右下の＋ボタンから作成できます</p>
      </div>`;
    return;
  }

  playlistList.innerHTML = state.playlists.map((pl) => `
    <div class="playlist-card" data-pl-id="${esc(pl.id)}" data-pl-name="${esc(pl.name)}">
      <button class="playlist-card-remove" data-action="archive-pl" title="削除">✕</button>
      <div class="playlist-card-art">♫</div>
      <div class="playlist-card-name">${esc(pl.name)}</div>
      <div class="playlist-card-count">${pl.trackIds.length}曲</div>
    </div>
  `).join("");

  // イベント委譲: data属性ベースでXSS安全
  playlistList.querySelectorAll(".playlist-card").forEach((card) => {
    card.addEventListener("click", () => {
      if (card.dataset.plId) openPlaylistEdit(card.dataset.plId);
    });
  });
  playlistList.querySelectorAll("[data-action='archive-pl']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = btn.closest(".playlist-card");
      if (card) archivePlaylist(card.dataset.plId, card.dataset.plName);
    });
  });
}

// =====================================================
// アクション
// =====================================================
async function archiveTrack(id, title) {
  const confirmed = await confirmAction(`「${title}」を削除しますか？この操作は取り消せません。`);
  if (!confirmed) return;
  safeSend(JSON.stringify({ type: "archive-track", trackId: id }));
}

async function archivePlaylist(id, name) {
  const confirmed = await confirmAction(`プレイリスト「${name}」を削除しますか？`);
  if (!confirmed) return;
  safeSend(JSON.stringify({ type: "archive-playlist", playlistId: id }));
}

// =====================================================
// ナビゲーション
// =====================================================
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".content-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById(`${tab}Tab`).classList.add("active");
    const titles = { tracks: "すべての曲", playlists: "プレイリスト", artists: "アーティスト" };
    pageTitle.textContent = titles[tab] || tab;
  });
});

// =====================================================
// プレイリスト作成/編集モーダル
// =====================================================
let editingPlaylistId = null;

$("#createPlaylistBtn").addEventListener("click", () => openPlaylistModal());
$("#cancelPlaylist").addEventListener("click", () => { playlistModal.hidden = true; });
playlistModal.addEventListener("click", (e) => {
  if (e.target === playlistModal) playlistModal.hidden = true;
});

function openPlaylistModal(playlist = null) {
  editingPlaylistId = playlist?.id ?? null;
  const modalTitle = $("#modalTitle");
  const saveBtn = $("#savePlaylist");

  if (modalTitle) modalTitle.textContent = playlist ? "プレイリスト編集" : "新規プレイリスト";
  if (saveBtn) saveBtn.textContent = playlist ? "保存" : "作成";

  playlistName.value = playlist?.name ?? "";

  const selectedIds = new Set(playlist?.trackIds ?? []);
  // 編集時: 選択済み曲を上に、未選択を下に並べる
  const orderedTracks = playlist
    ? [...playlist.trackIds.map((id) => state.activeTracks.find((t) => t.id === id)).filter(Boolean),
       ...state.activeTracks.filter((t) => !selectedIds.has(t.id))]
    : state.activeTracks;

  trackSelector.innerHTML = orderedTracks.map((t) => `
    <label class="modal-track-item" draggable="true" data-id="${esc(t.id)}">
      <span class="drag-handle">≡</span>
      <input type="checkbox" value="${esc(t.id)}" ${selectedIds.has(t.id) ? "checked" : ""}>
      <div>
        <div class="modal-track-label">${esc(t.title)}</div>
        <div class="modal-track-sub">${esc(t.artist)}</div>
      </div>
    </label>
  `).join("");
  enableDragSort(trackSelector);
  playlistModal.hidden = false;
}

function openPlaylistEdit(playlistId) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  if (pl) openPlaylistModal(pl);
}

$("#savePlaylist").addEventListener("click", () => {
  const name = playlistName.value.trim();
  if (!name) return playlistName.focus();
  // D&D並び替え後のDOM順序でチェック済みIDを取得
  const ids = [...trackSelector.querySelectorAll(".modal-track-item")]
    .filter((el) => el.querySelector("input:checked"))
    .map((el) => el.dataset.id);
  if (!ids.length) {
    showToast("曲を1つ以上選択してください", "error");
    return;
  }

  if (editingPlaylistId) {
    safeSend(JSON.stringify({
      type: "update-playlist",
      playlistId: editingPlaylistId,
      name,
      trackIds: ids,
    }));
    showToast("プレイリストを更新中…", "info");
  } else {
    safeSend(JSON.stringify({ type: "create-playlist", name, trackIds: ids }));
    showToast("プレイリストを作成中…", "info");
  }
  playlistModal.hidden = true;
});

// =====================================================
// ユーティリティ
// =====================================================
function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// =====================================================
// メタデータインライン編集
// =====================================================
function startEditTrack(trackId) {
  const track = state.activeTracks.find((t) => t.id === trackId);
  if (!track) return;

  const row = document.querySelector(`[data-track-id="${CSS.escape(trackId)}"]`);
  if (!row || row.classList.contains("editing")) return;
  row.classList.add("editing");

  const meta = row.querySelector(".track-meta");
  const albumEl = row.querySelector(".track-album");

  const origTitle = track.title;
  const origArtist = track.artist;
  const origAlbum = track.album;

  meta.innerHTML = `
    <input class="edit-input edit-title" value="${esc(origTitle)}" placeholder="曲名">
    <div class="autocomplete-wrap">
      <input class="edit-input edit-artist" value="${esc(origArtist)}" placeholder="アーティスト" autocomplete="off">
    </div>`;
  if (albumEl) {
    albumEl.innerHTML = `<input class="edit-input edit-album" value="${esc(origAlbum)}" placeholder="アルバム">`;
  }

  const titleInput = meta.querySelector(".edit-title");
  titleInput.focus();
  titleInput.select();

  // アーティストオートコンプリート
  const artistInput = meta.querySelector(".edit-artist");
  const acWrap = meta.querySelector(".autocomplete-wrap");
  setupArtistAutocomplete(artistInput, acWrap);

  let saved = false;

  function saveEdit() {
    if (saved) return;
    saved = true;
    const newTitle = meta.querySelector(".edit-title")?.value.trim() || origTitle;
    const newArtist = meta.querySelector(".edit-artist")?.value.trim() || origArtist;
    const newAlbum = albumEl?.querySelector(".edit-album")?.value.trim() ?? origAlbum;

    if (newTitle !== origTitle || newArtist !== origArtist || newAlbum !== origAlbum) {
      safeSend(JSON.stringify({
        type: "update-track",
        trackId,
        title: newTitle,
        artist: newArtist,
        album: newAlbum,
      }));
      showToast("曲情報を更新中…", "info");
    }
    renderTracks();
  }

  function handleKeydown(e) {
    if (e.key === "Enter") { saveEdit(); }
    if (e.key === "Escape") { renderTracks(); }
  }

  row.querySelectorAll(".edit-input").forEach((input) => {
    input.addEventListener("keydown", handleKeydown);
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (!saved && !row.querySelector(".edit-input:focus")) saveEdit();
      }, 100);
    });
  });
}

// =====================================================
// プレイリストモーダル内 D&D 並び替え
// =====================================================
function enableDragSort(container) {
  let dragged = null;

  container.addEventListener("dragstart", (e) => {
    dragged = e.target.closest(".modal-track-item");
    if (!dragged) return;
    dragged.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });

  container.addEventListener("dragend", () => {
    if (dragged) dragged.classList.remove("dragging");
    dragged = null;
    container.querySelectorAll(".modal-track-item").forEach((el) => el.classList.remove("drag-above"));
  });

  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    const target = e.target.closest(".modal-track-item");
    if (!target || target === dragged) return;
    container.querySelectorAll(".modal-track-item").forEach((el) => el.classList.remove("drag-above"));
    target.classList.add("drag-above");
  });

  container.addEventListener("drop", (e) => {
    e.preventDefault();
    const target = e.target.closest(".modal-track-item");
    if (!target || target === dragged) return;
    container.insertBefore(dragged, target);
    container.querySelectorAll(".modal-track-item").forEach((el) => el.classList.remove("drag-above"));
  });
}



// =====================================================
// アーティスト
// =====================================================
const artistList = $("#artistList");
const artistModal = $("#artistModal");
const artistNameInput = $("#artistNameInput");
const keywordInput = $("#keywordInput");
const keywordTags = $("#keywordTags");
const keywordTagWrap = $("#keywordTagWrap");
const artistTrackList = $("#artistTrackList");
let editingArtistId = null;
let currentKeywords = [];

/** artist_idのハッシュ値から一意のグラデーション角度と色相を算出 */
function artistGradient(artistId) {
  let h = 0;
  for (let i = 0; i < artistId.length; i++) h = (h * 31 + artistId.charCodeAt(i)) & 0xffffffff;
  const hue1 = h % 360;
  const hue2 = (hue1 + 40 + (h >> 8) % 40) % 360;
  const angle = (h >> 16) % 360;
  return `linear-gradient(${angle}deg, hsla(${hue1},70%,50%,0.25), hsla(${hue2},70%,45%,0.2))`;
}

function renderArtists() {
  if (!state.artists || !state.artists.length) {
    artistList.innerHTML = `
      <div class="empty" style="grid-column: 1/-1">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <p class="empty-title">アーティストがいません</p>
        <p class="empty-sub">曲をアップロードすると自動で追加されます</p>
      </div>`;
    return;
  }

  artistList.innerHTML = state.artists.map((a) => {
    const keywords = a.keywords ? a.keywords.split(",").filter(Boolean) : [];
    const pills = keywords.map((kw) =>
      `<span class="artist-keyword-pill">${esc(kw.trim())}</span>`
    ).join("");
    return `
      <div class="artist-card" data-artist-id="${esc(a.id)}" data-artist-name="${esc(a.name)}">
        <button class="artist-card-remove" data-action="archive-artist" title="削除">✕</button>
        <div class="artist-card-art" style="background:${artistGradient(a.id)}">♪</div>
        <div class="artist-card-name">${esc(a.name)}</div>
        <div class="artist-card-keywords">${pills || '<span style="color:var(--text-tertiary);font-size:11px">キーワード未設定</span>'}</div>
        <div class="artist-card-count">${a.trackCount}曲</div>
      </div>`;
  }).join("");

  artistList.querySelectorAll(".artist-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action='archive-artist']")) return;
      openArtistModal(card.dataset.artistId);
    });
  });
  artistList.querySelectorAll("[data-action='archive-artist']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = btn.closest(".artist-card");
      if (card) archiveArtistAction(card.dataset.artistId, card.dataset.artistName);
    });
  });
}

async function archiveArtistAction(id, name) {
  const confirmed = await confirmAction(`アーティスト「${name}」を削除しますか？所属曲は「不明なアーティスト」に変更されます。`);
  if (!confirmed) return;
  safeSend(JSON.stringify({ type: "archive-artist", artistId: id }));
}

// --- アーティストモーダル ---
$("#createArtistBtn").addEventListener("click", () => openArtistModal());
$("#cancelArtist").addEventListener("click", () => { artistModal.hidden = true; });
artistModal.addEventListener("click", (e) => {
  if (e.target === artistModal) artistModal.hidden = true;
});

function openArtistModal(artistId = null) {
  const artist = artistId ? state.artists.find((a) => a.id === artistId) : null;
  editingArtistId = artist?.id ?? null;

  const title = $("#artistModalTitle");
  const saveBtn = $("#saveArtist");
  if (title) title.textContent = artist ? "アーティスト編集" : "新規アーティスト";
  if (saveBtn) saveBtn.textContent = artist ? "保存" : "作成";

  artistNameInput.value = artist?.name ?? "";
  currentKeywords = artist?.keywords ? artist.keywords.split(",").filter(Boolean).map((s) => s.trim()) : [];
  renderKeywordTags();

  // 所属曲
  if (artist) {
    const tracks = state.activeTracks.filter((t) => t.artistId === artist.id);
    if (tracks.length > 0) {
      artistTrackList.innerHTML = `
        <div class="artist-track-list-title">所属曲 (${tracks.length})</div>
        ${tracks.map((t) => `<div class="artist-track-item"><span class="artist-track-item-title">${esc(t.title)}</span></div>`).join("")}`;
    } else {
      artistTrackList.innerHTML = "";
    }
  } else {
    artistTrackList.innerHTML = "";
  }

  artistModal.hidden = false;
  artistNameInput.focus();
}

function renderKeywordTags() {
  keywordTags.innerHTML = currentKeywords.map((kw, i) =>
    `<span class="tag-pill">${esc(kw)}<button class="tag-pill-remove" data-idx="${i}">✕</button></span>`
  ).join("");
  keywordTags.querySelectorAll(".tag-pill-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentKeywords.splice(Number(btn.dataset.idx), 1);
      renderKeywordTags();
    });
  });
}

keywordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addKeywordFromInput();
  }
  if (e.key === "Backspace" && !keywordInput.value && currentKeywords.length > 0) {
    currentKeywords.pop();
    renderKeywordTags();
  }
});

keywordInput.addEventListener("blur", () => addKeywordFromInput());
keywordTagWrap.addEventListener("click", () => keywordInput.focus());

function addKeywordFromInput() {
  const val = keywordInput.value.replace(/,/g, "").trim();
  if (val && !currentKeywords.includes(val)) {
    currentKeywords.push(val);
    renderKeywordTags();
  }
  keywordInput.value = "";
}

$("#saveArtist").addEventListener("click", () => {
  const name = artistNameInput.value.trim();
  if (!name) return artistNameInput.focus();

  const keywords = currentKeywords.join(",");
  if (editingArtistId) {
    safeSend(JSON.stringify({
      type: "update-artist",
      artistId: editingArtistId,
      name,
      keywords,
    }));
    showToast("アーティストを更新中…", "info");
  } else {
    safeSend(JSON.stringify({ type: "create-artist", name, keywords }));
    showToast("アーティストを作成中…", "info");
  }
  artistModal.hidden = true;
});

// =====================================================
// アーティストオートコンプリート
// =====================================================
function setupArtistAutocomplete(input, wrap) {
  let dropdown = null;

  function showDropdown(query) {
    removeDropdown();
    const q = query.toLowerCase().replace(/\s+/g, "");
    const matches = (state.artists || []).filter((a) => {
      const normName = a.name.toLowerCase().replace(/\s+/g, "");
      const normKw = (a.keywords || "").toLowerCase().replace(/\s+/g, "");
      return normName.includes(q) || normKw.includes(q);
    }).slice(0, 8);

    const exactMatch = matches.some(
      (a) => a.name.toLowerCase().replace(/\s+/g, "") === q
    );

    dropdown = document.createElement("div");
    dropdown.className = "autocomplete-dropdown";

    let html = matches.map((a) =>
      `<div class="autocomplete-item" data-artist-name="${esc(a.name)}">
        <span class="autocomplete-item-name">${esc(a.name)}</span>
        <span class="autocomplete-item-count">${a.trackCount}曲</span>
      </div>`
    ).join("");

    if (query.trim() && !exactMatch) {
      html += `<div class="autocomplete-item autocomplete-item-create" data-artist-name="${esc(query.trim())}">
        <span>「${esc(query.trim())}」を新規作成</span>
      </div>`;
    }

    if (!html) { removeDropdown(); return; }
    dropdown.innerHTML = html;
    wrap.appendChild(dropdown);

    dropdown.querySelectorAll(".autocomplete-item").forEach((item) => {
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = item.dataset.artistName;
        removeDropdown();
      });
    });
  }

  function removeDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
  }

  input.addEventListener("input", () => {
    if (input.value.trim()) showDropdown(input.value);
    else removeDropdown();
  });

  input.addEventListener("focus", () => {
    if (input.value.trim()) showDropdown(input.value);
  });

  input.addEventListener("blur", () => {
    setTimeout(removeDropdown, 150);
  });
}

// =====================================================
// 認証
// =====================================================
const authScreen = $("#authScreen");
const authSetup = $("#authSetup");
const authLogin = $("#authLogin");
const authError = $("#authError");
const appMain = $("#appMain");

function apiUrl(path) {
  return `/party/${ROOM_ID}${path}`;
}

function showAuthError(msg) {
  authError.textContent = msg;
  authError.hidden = false;
}
function hideAuthError() { authError.hidden = true; }

function b64urlToUint8(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function uint8ToB64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function credentialToJSON(cred) {
  const response = {};
  if (cred.response.attestationObject) response.attestationObject = uint8ToB64url(cred.response.attestationObject);
  if (cred.response.clientDataJSON) response.clientDataJSON = uint8ToB64url(cred.response.clientDataJSON);
  if (cred.response.authenticatorData) response.authenticatorData = uint8ToB64url(cred.response.authenticatorData);
  if (cred.response.signature) response.signature = uint8ToB64url(cred.response.signature);
  if (cred.response.userHandle) response.userHandle = uint8ToB64url(cred.response.userHandle);
  if (cred.response.getTransports) response.transports = cred.response.getTransports();
  return {
    id: cred.id,
    rawId: uint8ToB64url(cred.rawId),
    response,
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment,
  };
}

async function registerPasskey(userName) {
  hideAuthError();
  const btn = $("#setupBtn");
  btn.disabled = true;
  btn.textContent = "登録中…";
  try {
    const optRes = await fetch(apiUrl("/api/auth/register-options"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userName }),
    });
    if (!optRes.ok) { const e = await optRes.json(); throw new Error(e.error || "失敗"); }
    const optData = await optRes.json();
    const { options, challengeId, userId } = optData;
    options.challenge = b64urlToUint8(options.challenge);
    options.user.id = b64urlToUint8(options.user.id);
    if (options.excludeCredentials) {
      options.excludeCredentials = options.excludeCredentials.map((c) => ({ ...c, id: b64urlToUint8(c.id) }));
    }
    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) throw new Error("パスキーの作成がキャンセルされました");
    const verifyRes = await fetch(apiUrl("/api/auth/register-verify"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, userId, userName, credential: credentialToJSON(credential) }),
    });
    const result = await verifyRes.json();
    if (!result.verified) throw new Error(result.error || "検証失敗");
    localStorage.setItem("session", result.token);
    startApp(result.token);
  } catch (err) {
    console.error("[Auth] Register:", err);
    showAuthError(err.message || "登録に失敗しました");
    btn.disabled = false;
    btn.innerHTML = 'パスキーを登録';
  }
}

async function loginPasskey() {
  hideAuthError();
  const btn = $("#loginBtn");
  btn.disabled = true;
  btn.textContent = "認証中…";
  try {
    const optRes = await fetch(apiUrl("/api/auth/login-options"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!optRes.ok) throw new Error("ログインオプション取得失敗");
    const { options, challengeId } = await optRes.json();
    options.challenge = b64urlToUint8(options.challenge);
    if (options.allowCredentials) {
      options.allowCredentials = options.allowCredentials.map((c) => ({ ...c, id: b64urlToUint8(c.id) }));
    }
    const credential = await navigator.credentials.get({ publicKey: options });
    if (!credential) throw new Error("認証がキャンセルされました");
    const verifyRes = await fetch(apiUrl("/api/auth/login-verify"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, credential: credentialToJSON(credential) }),
    });
    const result = await verifyRes.json();
    if (!result.verified) throw new Error(result.error || "認証失敗");
    localStorage.setItem("session", result.token);
    startApp(result.token);
  } catch (err) {
    console.error("[Auth] Login:", err);
    showAuthError(err.message || "ログインに失敗しました");
    btn.disabled = false;
    btn.innerHTML = 'ログイン';
  }
}

function startApp(token) {
  sessionToken = token;
  authScreen.hidden = true;
  appMain.hidden = false;
  connect();
}

$("#setupBtn").addEventListener("click", () => {
  const userName = $("#setupUserName").value.trim();
  if (!userName) return $("#setupUserName").focus();
  registerPasskey(userName);
});
$("#setupUserName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("#setupBtn").click(); }
});
$("#loginBtn").addEventListener("click", () => loginPasskey());

// =====================================================
// 起動
// =====================================================
async function boot() {
  const saved = localStorage.getItem("session");
  if (saved) {
    try {
      const res = await fetch(apiUrl("/api/tracks"), { headers: { Authorization: `Bearer ${saved}` } });
      if (res.ok) { startApp(saved); return; }
    } catch { /* ignore */ }
    localStorage.removeItem("session");
  }
  try {
    const res = await fetch(apiUrl("/api/auth/status"));
    const data = await res.json();
    if (data.status === "needs-setup") {
      authSetup.hidden = false;
      authLogin.hidden = true;
      $("#setupUserName").focus();
    } else {
      authSetup.hidden = true;
      authLogin.hidden = false;
      if (data.userName) $("#authGreeting").textContent = `おかえり、${data.userName}`;
    }
  } catch (err) {
    console.error("[Auth] Status:", err);
    showAuthError("サーバーに接続できません");
  }
}

boot();

