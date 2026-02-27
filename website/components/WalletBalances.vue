<template>
  <div v-if="connected" class="flex items-center gap-4 py-2 px-4 border-b text-sm">
    <span class="text-gray-400 text-xs font-medium uppercase tracking-wide">Wallet</span>

    <div class="flex items-center gap-1.5">
      <span :class="solColor" class="w-2 h-2 rounded-full inline-block" />
      <span class="font-mono">{{ sol.toFixed(4) }} SOL</span>
    </div>

    <div class="flex items-center gap-1.5">
      <span :class="nosColor" class="w-2 h-2 rounded-full inline-block" />
      <span class="font-mono">{{ nos.toFixed(2) }} NOS</span>
    </div>

    <span v-if="loading" class="text-gray-400 text-xs">updating…</span>
    <span v-if="error" class="text-red-400 text-xs">{{ error }}</span>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';

const apiUrl = import.meta.env.VITE_API_URL;
const { connected, publicKey } = useWallet();

const sol = ref(0);
const nos = ref(0);
const loading = ref(false);
const error = ref('');

// SOL thresholds: red < 0.035, yellow 0.035–0.05, green >= 0.05
const solColor = computed(() => {
  if (sol.value >= 0.05)   return 'bg-green-500';
  if (sol.value >= 0.035)  return 'bg-yellow-400';
  return 'bg-red-500';
});

// NOS thresholds: red < 15, yellow 15–25, green >= 25
const nosColor = computed(() => {
  if (nos.value >= 25) return 'bg-green-500';
  if (nos.value >= 15) return 'bg-yellow-400';
  return 'bg-red-500';
});

let refreshTimer = null;

async function fetchBalances() {
  if (!publicKey.value) return;
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch(`${apiUrl}/wallet/${publicKey.value}/balances`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    sol.value = data.sol ?? 0;
    nos.value = data.nos ?? 0;
  } catch {
    error.value = 'Could not load balances';
  } finally {
    loading.value = false;
  }
}

watch(publicKey, (pk) => {
  clearInterval(refreshTimer);
  if (!pk) { sol.value = 0; nos.value = 0; return; }
  fetchBalances();
  refreshTimer = setInterval(fetchBalances, 30_000);
}, { immediate: true });

onUnmounted(() => clearInterval(refreshTimer));
</script>
