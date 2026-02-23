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
            <p v-if="!song.lyrics" class="text-sm italic text-gray-400">Lyrics Pending...</p>
            <p v-else class="text-sm italic text-green-400">Lyrics Complete</p>
          </div>
        </div>
      </UCard>
    </div>
  </section>
</template>

<script setup>
import { ref } from "vue";

const apiUrl = import.meta.env.VITE_API_URL;

defineProps({
  history: {
    type: Array,
    required: true,
  },
});

defineEmits(["delete-song"]);

const showLyrics = ref(false);

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
</script>
