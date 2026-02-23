<template>
  <UContainer>
    <header class="flex justify-between items-center py-4 border-b">
      <h1 class="text-2xl font-bold text-primary">LyricfAI</h1>
      <UTabs v-model="activeTab" :items="tabs" />
    </header>

    <main class="flex-grow py-8">
      <UploadModule
        v-if="activeTab === 'upload'"
        @song-selected="addSong"
      />

      <SongList
        v-if="activeTab === 'history'"
        :history="history"
        @delete-song="deleteSong"
      />
    </main>

    <footer class="py-4 text-center text-sm text-gray-500 border-t">
      2025 LyricfAI ~ An Effect AI project.
    </footer>
  </UContainer>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import UploadModule from './components/UploadModule.vue';
import SongList from './components/SongList.vue';

const apiUrl = import.meta.env.VITE_API_URL;

const tabs = [
  { label: 'Upload Song', value: 'upload' },
  { label: 'Song History', value: 'history' }
];

const activeTab = ref('upload');
const history = ref([]);

// Map of jobID -> WebSocket to avoid duplicate connections
const wsMap = new Map();

// Interval ID for polling fallback
let pollInterval = null;

onMounted(() => {
  const stored = JSON.parse(localStorage.getItem("songHistory") || "[]");
  history.value = stored;

  // Open WebSocket subscriptions for any jobs still pending (skip temp placeholders)
  stored.filter(s => !s.lyrics && !s.jobID?.startsWith("pending-")).forEach(s => tryOpenWSForJob(s.jobID));

  // Polling fallback in case WebSocket is unavailable
  pollInterval = setInterval(checkForLyrics, 5000);
});

onBeforeUnmount(() => {
  for (const ws of wsMap.values()) {
    try { ws.close(); } catch {}
  }
  wsMap.clear();
  if (pollInterval) clearInterval(pollInterval);
});

// Called by UploadModule when the user clicks Generate Lyrics
async function addSong(audiusSong) {
  // Build and save the entry immediately so it appears in history right away
  const tempID = `pending-${Date.now()}`;
  const newEntry = {
    jobID: tempID,
    name: audiusSong.title,
    cover: audiusSong.artwork?.["150x150"] || "",
    audio: `https://api.audius.co/v1/tracks/${audiusSong.id}/stream`,
    songID: audiusSong.id,
    date: new Date().toLocaleDateString(),
    lyrics: "",
  };
  const current = JSON.parse(localStorage.getItem("songHistory") || "[]");
  current.push(newEntry);
  localStorage.setItem("songHistory", JSON.stringify(current));
  history.value = current;
  activeTab.value = "history";

  // Fetch the real jobID from the API (app.vue stays mounted, so this always completes)
  try {
    const response = await fetch(`${apiUrl}/songurl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedSongID: audiusSong.id }),
    });
    const result = await response.json();

    // Replace the temp placeholder with the real jobID
    const songs = JSON.parse(localStorage.getItem("songHistory") || "[]");
    const idx = songs.findIndex(s => s.jobID === tempID);
    if (idx !== -1) {
      songs[idx].jobID = result.jobID;
      localStorage.setItem("songHistory", JSON.stringify(songs));
      history.value = songs;
    }
    tryOpenWSForJob(result.jobID);
  } catch (err) {
    console.error("Error posting /songurl:", err);
  }
}

// Called by SongList when the user clicks the delete button
function deleteSong(index) {
  const current = [...history.value];
  const removed = current.splice(index, 1)[0];
  localStorage.setItem("songHistory", JSON.stringify(current));
  history.value = current;
  // Close any open WebSocket for that job
  if (removed?.jobID && wsMap.has(removed.jobID)) {
    try { wsMap.get(removed.jobID).close(); } catch {}
    wsMap.delete(removed.jobID);
  }
}

// Open a single WebSocket per jobID; app.vue is the sole owner of all sockets
function tryOpenWSForJob(jobID) {
  if (!jobID || wsMap.has(jobID)) return;

  try {
    const wsUrl = apiUrl.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsUrl}?jobID=${jobID}`);

    ws.onopen = () => console.log("WS opened for job:", jobID);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === "lyrics_ready" && msg?.data) {
          applyLyricsToHistory(jobID, msg.data.lyrics);
          try { ws.close(); } catch {}
          wsMap.delete(jobID);
        }
      } catch (err) {
        console.warn("WS message parse error:", err);
      }
    };

    ws.onerror = () => {
      try { ws.close(); } catch {}
      wsMap.delete(jobID);
    };

    ws.onclose = () => wsMap.delete(jobID);

    wsMap.set(jobID, ws);
  } catch (err) {
    console.warn("Failed to open WebSocket for job", jobID, err);
  }
}

// Polling fallback for jobs whose WebSocket may have been missed
async function checkForLyrics() {
  const current = JSON.parse(localStorage.getItem("songHistory") || "[]");
  if (!current.length) return;

  // Keep history in sync with localStorage
  history.value = current;

  for (const entry of current) {
    if (entry.lyrics || entry.jobID?.startsWith("pending-")) continue;
    try {
      const response = await fetch(`${apiUrl}/checkJob`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobID: entry.jobID }),
      });
      const result = await response.json();
      if (result.status === 200 && result.lyrics) {
        applyLyricsToHistory(entry.jobID, result.lyrics);
      }
    } catch (err) {
      console.warn("checkForLyrics error:", err);
    }
  }
}

function applyLyricsToHistory(jobID, lyrics) {
  const songs = JSON.parse(localStorage.getItem("songHistory") || "[]");
  const idx = songs.findIndex(s => s.jobID === jobID);
  if (idx !== -1) {
    songs[idx].lyrics = lyrics;
    localStorage.setItem("songHistory", JSON.stringify(songs));
    history.value = songs;
  }
}
</script>
