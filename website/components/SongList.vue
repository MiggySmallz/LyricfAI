<template>
  <section class="max-w-5xl mx-auto">
    <div class="flex justify-between items-center mb-4">
      <h2 class="text-lg font-semibold">Your LyricfAI Songs</h2>
      <UButton color="primary" variant="outline" icon="i-heroicons-arrow-down-tray" @click="exportForEffect">
        Export for Effect AI
      </UButton>
    </div>

    <p v-if="!history || history.length === 0" class="text-gray-500">
      No songs processed yet.
    </p>

    <div v-else class="space-y-4">
      <UCard
        v-for="(song, index) in history"
        :key="song.jobID || index"
        class="relative"
      >
        <UButton color="black" icon="i-heroicons-x-mark" class="absolute top-2 right-2" @click="$emit('delete-song', index)" />
        <div class="flex">
          <div class="flex items-center w-[80%] gap-4">
            <div>
              <img class="w-[100px] h-[100px]" :src="song.cover" alt="Artwork" />
            </div>
            <div>
              <p class="font-medium">{{ song.name }}</p>
              <p class="text-sm text-gray-500">{{ song.date }}</p>
            </div>
          </div>

          <div class="flex flex-col items-center justify-center gap-1">
            <LyricsModual
              v-model="showLyrics"
              :song="song"
            />
            <template v-if="song.lyrics">
              <p class="text-sm italic text-green-400">Lyrics Complete</p>
            </template>
            <template v-else-if="isFailed(song)">
              <p class="text-sm italic text-red-400">Generation failed</p>
              <UButton size="xs" color="primary" variant="soft" icon="i-heroicons-arrow-path" @click="$emit('retry-song', song)">
                Retry
              </UButton>
            </template>
            <template v-else>
              <p class="text-sm italic text-gray-400">Lyrics Pending...</p>
            </template>
            <a
              v-if="song.nosanaJob"
              :href="`https://dashboard.nosana.com/jobs/${song.nosanaJob}`"
              target="_blank"
              rel="noopener noreferrer"
              class="text-xs text-primary-400 hover:underline mt-1"
            >
              View on Nosana ↗
            </a>
          </div>
        </div>
      </UCard>
    </div>

    <!-- Effect AI campaign poster -->
    <UCard class="mt-6">
      <h3 class="text-base font-semibold mb-4">Post to Effect AI</h3>

      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-1">
          <label class="block text-sm font-medium">Dataset ID</label>
          <input
            v-model="effectForm.datasetId"
            class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            placeholder="e.g. 645649141271743"
          />
        </div>

        <div class="space-y-1">
          <label class="block text-sm font-medium">Fetcher index</label>
          <input
            v-model.number="effectForm.fetcherIndex"
            type="number"
            min="0"
            step="1"
            class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            placeholder="e.g. 1"
          />
        </div>

        <div class="col-span-2 space-y-1">
          <label class="block text-sm font-medium">Auth key</label>
          <input
            v-model="effectForm.authKey"
            type="password"
            class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            placeholder="Task-poster password"
          />
        </div>
      </div>

      <div v-if="effectResult" class="mt-4 rounded-md bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-700 dark:text-green-300">
        Campaign created! Dataset ID: <strong>{{ effectResult.datasetId }}</strong> · {{ effectResult.taskCount }} tasks queued.
      </div>

      <div v-if="effectError" class="mt-4 rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
        {{ effectError }}
      </div>

      <div v-if="effectStats" class="mt-4 rounded-md bg-blue-50 dark:bg-blue-900/20 p-3 text-sm text-blue-700 dark:text-blue-300">
        <p class="font-medium mb-2">Fetcher status</p>
        <div class="grid grid-cols-4 gap-2 text-center">
          <div><p class="text-lg font-bold">{{ effectStats.queue ?? '—' }}</p><p class="text-xs">Pending</p></div>
          <div><p class="text-lg font-bold">{{ effectStats.active ?? '—' }}</p><p class="text-xs">Active</p></div>
          <div><p class="text-lg font-bold text-green-600 dark:text-green-400">{{ effectStats.done ?? '—' }}</p><p class="text-xs">Done</p></div>
          <div><p class="text-lg font-bold text-red-600 dark:text-red-400">{{ effectStats.failed ?? '—' }}</p><p class="text-xs">Failed</p></div>
        </div>
      </div>

      <div v-if="effectStatsError" class="mt-4 rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
        {{ effectStatsError }}
      </div>

      <div class="mt-4 flex justify-end gap-2">
        <UButton
          color="neutral"
          variant="soft"
          icon="i-heroicons-chart-bar"
          :loading="effectStatsLoading"
          :disabled="!effectForm.datasetId || !effectForm.authKey"
          @click="checkEffectStats"
        >
          Check results
        </UButton>
        <UButton
          color="primary"
          icon="i-heroicons-cloud-arrow-up"
          :loading="effectPosting"
          :disabled="!effectForm.datasetId || !effectForm.authKey"
          @click="postToEffect"
        >
          Post campaign
        </UButton>
      </div>
    </UCard>
  </section>
</template>

<script setup>
import { ref, reactive, onUnmounted } from "vue";

// Songs with no lyrics that were submitted more than 30 minutes ago are considered failed
const FAILURE_TIMEOUT_MS = 30 * 60 * 1000;
function isFailed(song) {
  if (song.lyrics || song.jobID?.startsWith("pending-") || !song.createdAt) return false;
  return Date.now() - new Date(song.createdAt).getTime() > FAILURE_TIMEOUT_MS;
}

const apiUrl = import.meta.env.VITE_API_URL;

defineProps({
  history: {
    type: Array,
    required: true,
  },
});

defineEmits(["delete-song", "retry-song"]);

const showLyrics = ref(false);

const effectPosting = ref(false);
const effectResult = ref(null);
const effectError = ref(null);
const effectStats = ref(null);
const effectStatsError = ref(null);
const effectStatsLoading = ref(false);
const effectStatsInterval = ref(null);
const effectForm = reactive({
  datasetId: "",
  fetcherIndex: 1,
  authKey: "",
});

function stopStatsPolling() {
  if (effectStatsInterval.value) {
    clearInterval(effectStatsInterval.value);
    effectStatsInterval.value = null;
  }
}

onUnmounted(stopStatsPolling);

async function exportForEffect() {
  try {
    const response = await fetch(`${apiUrl}/exportForEffect`);
    if (!response.ok) {
      const text = await response.text();
      console.error(`Export failed (${response.status}):`, text);
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "songs_for_effect.csv";
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Export for Effect AI failed:", err);
  }
}

async function fetchEffectStats(showLoading = false) {
  if (showLoading) effectStatsLoading.value = true;
  try {
    const response = await fetch(`${apiUrl}/effectStats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authKey: effectForm.authKey,
        datasetId: effectForm.datasetId,
        fetcherIndex: effectForm.fetcherIndex,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      effectStatsError.value = data.error || "Unknown error";
      stopStatsPolling();
    } else {
      effectStats.value = data;
      effectStatsError.value = null;
    }
  } catch (err) {
    effectStatsError.value = err.message || "Request failed";
    stopStatsPolling();
  } finally {
    if (showLoading) effectStatsLoading.value = false;
  }
}

async function checkEffectStats() {
  effectStats.value = null;
  effectStatsError.value = null;
  stopStatsPolling();
  await fetchEffectStats(true);
  if (!effectStatsError.value) {
    effectStatsInterval.value = setInterval(() => fetchEffectStats(false), 10000);
  }
}

async function postToEffect() {
  effectResult.value = null;
  effectError.value = null;
  effectPosting.value = true;
  try {
    const response = await fetch(`${apiUrl}/postToEffect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authKey: effectForm.authKey,
        datasetId: effectForm.datasetId,
        fetcherIndex: effectForm.fetcherIndex,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      effectError.value = data.error || "Unknown error";
    } else {
      effectResult.value = data;
    }
  } catch (err) {
    effectError.value = err.message || "Request failed";
  } finally {
    effectPosting.value = false;
  }
}
</script>
