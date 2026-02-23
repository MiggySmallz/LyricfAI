<template>
    <UModal fullscreen :title="song.name+' '+song?.date">
        <UButton label="View Lyrics" color="neutral" variant="subtle" />

        <template #body>
            <section class="max-w-3xl mx-auto">
                

                <div class="flex flex-col md:flex-row gap-6">
                    
                    
                    <div class="w-full md:w-1/2 flex flex-col items-center gap-4">
                        <!-- <div class="">
                            <h3 class="text-xl font-semibold mb-4">{{ song?.name }}</h3>
                            <p class="text-gray-500 mb-4">{{ song?.date }}</p>
                        </div> -->
                        <img :src="song?.cover" alt="Cover" class="rounded-lg shadow-md w-64 h-64 object-cover" />
                        <audio controls @loadedmetadata="e => e.target.volume = 0.25">
                        <source :src="song?.audio" type="audio/mp3" />
                        Your browser does not support the audio element.
                        </audio>
                    </div>

                    <div class="w-full md:w-1/2">
                        <h3 class="text-lg font-semibold mb-2">Lyrics</h3>
                        <p class="whitespace-pre-line text-sm text-gray-700">
                        {{ song?.lyrics || "Lyrics will appear here..." }}
                        </p>
                    </div>
                </div>
            </section>
        </template>
    </UModal>
</template>

<script setup>

defineProps({
//   showLyrics: {
//     required: true
//   },
    song:{
        type: Object,
        required: true
    },
    // history: {
    //     type: Array,
    //     required: true
    // },
})
</script>