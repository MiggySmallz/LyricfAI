<template>
  <section class="max-w-5xl mx-auto">
    <h2 class="text-lg font-semibold mb-4">Your LyricfAI Songs</h2>

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
              <p class="text-sm italic text-green-400">
                {{ song.validatedLyrics ? 'Validated Lyrics' : 'Lyrics Complete' }}
              </p>
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
            <!-- Per-song Effect AI status toggle -->
            <button
              v-if="song.lyrics && !song.jobID?.startsWith('pending-')"
              class="text-xs text-blue-400 hover:underline mt-1 flex items-center gap-1"
              @click="toggleEffectStatus(song.jobID)"
            >
              <span>View on Effect AI</span>
              <span>{{ expandedEffectStatus.has(song.jobID) ? '▲' : '▼' }}</span>
            </button>
          </div>
        </div>

        <!-- Per-song Effect AI status panel -->
        <div
          v-if="expandedEffectStatus.has(song.jobID)"
          class="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700"
        >
          <div v-if="effectStatusLoadingMap[song.jobID]" class="text-sm text-gray-400">
            Loading Effect AI status...
          </div>
          <div v-else-if="effectStatusMap[song.jobID]?.error" class="text-sm text-red-400">
            {{ effectStatusMap[song.jobID].error }}
          </div>
          <div v-else-if="effectStatusMap[song.jobID]" class="text-sm">
            <div class="flex items-center gap-4 flex-wrap">
              <!-- Phase 1 progress bar -->
              <div class="flex-1 min-w-[160px]">
                <p class="text-xs text-gray-500 mb-1">
                  Phase 1 — Segment validation
                  <span v-if="!effectStatusMap[song.jobID].effectPhase1Posted" class="text-yellow-400">(not posted yet)</span>
                </p>
                <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                  <div
                    class="bg-blue-500 h-2 rounded-full transition-all"
                    :style="{ width: phase1ProgressPct(effectStatusMap[song.jobID]) + '%' }"
                  />
                </div>
                <p class="text-xs text-gray-400 mt-1">
                  {{ effectStatusMap[song.jobID].phase1.validated }} / {{ effectStatusMap[song.jobID].phase1.total }} segments validated
                </p>
              </div>
              <!-- Phase 2 badge -->
              <div class="text-xs">
                <span v-if="effectStatusMap[song.jobID].phase2.completed" class="inline-flex items-center gap-1 text-green-400 font-medium">
                  Phase 2 complete ✓
                </span>
                <span v-else-if="effectStatusMap[song.jobID].phase2.posted" class="text-blue-400">
                  Phase 2 posted — awaiting completion
                </span>
                <span v-else class="text-gray-400">Phase 2 pending</span>
              </div>
              <!-- Last scan + refresh -->
              <div class="flex items-center gap-2 w-full">
                <p v-if="effectStatusMap[song.jobID].phase1.lastScan" class="text-xs text-gray-400">
                  Last scan: {{ new Date(effectStatusMap[song.jobID].phase1.lastScan).toLocaleTimeString() }}
                </p>
                <button
                  class="text-xs text-blue-400 hover:underline ml-auto"
                  :disabled="effectStatusLoadingMap[song.jobID]"
                  @click="refreshEffectStatus(song.jobID)"
                >
                  ↻ Refresh
                </button>
              </div>
            </div>
          </div>
        </div>
      </UCard>
    </div>
  </section>
</template>

<script setup>
import { ref, reactive, onUnmounted } from "vue";

const FAILURE_TIMEOUT_MS = 30 * 60 * 1000;
function isFailed(song) {
  if (song.lyrics || song.jobID?.startsWith("pending-") || !song.createdAt) return false;
  if (song.failed) return true;
  return Date.now() - new Date(song.createdAt).getTime() > FAILURE_TIMEOUT_MS;
}

const apiUrl = import.meta.env.VITE_API_URL;

defineProps({
  history: { type: Array, required: true },
});
defineEmits(["delete-song", "retry-song"]);

const showLyrics = ref(false);

// ---------------------------
// Per-song Effect AI status
// ---------------------------
const expandedEffectStatus   = ref(new Set());
const effectStatusMap        = reactive({});  // jobID -> status object
const effectStatusLoadingMap = reactive({}); // jobID -> bool
const effectStatusIntervals  = {};            // jobID -> interval id (not reactive)

function phase1ProgressPct(status) {
  const total = status?.phase1?.total;
  const validated = status?.phase1?.validated;
  if (!total) return 0;
  return Math.min(100, Math.round((validated / total) * 100));
}

async function fetchEffectStatus(jobID) {
  effectStatusLoadingMap[jobID] = true;
  try {
    const response = await fetch(`${apiUrl}/effectStatus/${jobID}`);
    let data;
    try {
      data = await response.json();
    } catch {
      effectStatusMap[jobID] = { error: `Server returned an unexpected response (HTTP ${response.status}). The backend may need to be redeployed.` };
      return;
    }
    effectStatusMap[jobID] = response.ok ? data : { error: data.error || `HTTP ${response.status}` };
  } catch (err) {
    effectStatusMap[jobID] = { error: err.message || "Request failed" };
  } finally {
    effectStatusLoadingMap[jobID] = false;
  }
}

async function refreshEffectStatus(jobID) {
  effectStatusLoadingMap[jobID] = true;
  try {
    // Trigger a live scan against the task-poster first
    await fetch(`${apiUrl}/triggerScan`, { method: "POST" });
  } catch {
    // Non-fatal — still read whatever is in the cache
  }
  await fetchEffectStatus(jobID);
}

function toggleEffectStatus(jobID) {
  const next = new Set(expandedEffectStatus.value);
  if (next.has(jobID)) {
    next.delete(jobID);
    clearInterval(effectStatusIntervals[jobID]);
    delete effectStatusIntervals[jobID];
  } else {
    next.add(jobID);
    fetchEffectStatus(jobID);
    effectStatusIntervals[jobID] = setInterval(() => fetchEffectStatus(jobID), 60000);
  }
  expandedEffectStatus.value = next;
}

onUnmounted(() => {
  for (const id of Object.values(effectStatusIntervals)) clearInterval(id);
});
</script>
