<template>
  <section class="max-w-4xl mx-auto">
    <UCard class="mb-5">
      <template #header>
        <h2 class="text-lg font-semibold">Song Search</h2>
      </template>
      <p class="text-sm text-gray-500 mb-4">
        Paste a song URL from Audius to generate lyrics.
      </p>
      <form @submit.prevent="searchSong">
        <div class="mb-8 w-full flex items-center gap-3">
          <label class="font-medium whitespace-nowrap">Song URL:</label>
          <UInput
            class="flex-1"
            v-model="searchedSong"
            placeholder="https://audius.co/Skrillex/kliptown-empyrean-98562"
          />
        </div>
        <UButton class="w-full mt-2 justify-center" color="primary" variant="solid" type="submit">
          Search
        </UButton>
      </form>
    </UCard>

    <UCard v-if="searchedSongs.length > 0">
      <div class="relative px-10">
        <UCarousel v-slot="{ item }" :items="searchedSongs" arrows :ui="{ item: 'basis-1/3' }">
          <UCard>
            <div class="items-center justify-center text-center">
              <p class="font-medium truncate">{{ item.title }}</p>
              <p class="text-sm truncate mb-3">By: {{ item.user.name }}</p>
              <img :src="item.artwork['150x150']" width="150" height="150" class="rounded-lg mx-auto">
              <UButton class="mt-2" color="primary" variant="solid" @click="selectSong(item)" block>
                <span v-if="loading !== item.id">Generate Lyrics</span>
                <span v-else>Loading...</span>
              </UButton>
            </div>
          </UCard>
        </UCarousel>
      </div>
    </UCard>
  </section>
</template>

<script setup>
import { ref } from "vue";

const emit = defineEmits(["song-selected"]);

const searchedSong = ref("");
const loading = ref("");
const searchedSongs = ref([]);

async function searchSong() {
  searchedSongs.value = [];
  if (!searchedSong.value) return;
  try {
    // Accept either a full Audius URL or a plain search term
    if (searchedSong.value.startsWith("https")) {
      const parts = searchedSong.value.split("/").filter(Boolean);
      searchedSong.value = parts.pop();
    }
    const response = await fetch(
      `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(searchedSong.value)}`,
      { headers: { Accept: "application/json" } }
    );
    const result = await response.json();
    searchedSongs.value = result.data || [];
  } catch (err) {
    console.error("Search failed:", err);
  }
}

function selectSong(song) {
  loading.value = song.id;
  emit("song-selected", song);
  loading.value = "";
  searchedSong.value = "";
}
</script>
