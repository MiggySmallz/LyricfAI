<template>
  <div>
    <UButton
      v-if="!connected"
      color="primary"
      variant="outline"
      icon="i-heroicons-wallet"
      :loading="connecting"
      @click="handleConnect"
    >
      Connect Wallet
    </UButton>

    <UDropdownMenu v-else :items="menuItems">
      <UButton color="neutral" variant="soft" icon="i-heroicons-wallet">
        {{ shortAddress }}
      </UButton>
    </UDropdownMenu>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const { connected, shortAddress, connect, disconnect } = useWallet();
const connecting = ref(false);
const error = ref('');

const menuItems = [
  [{ label: 'Disconnect', icon: 'i-heroicons-arrow-right-on-rectangle', onSelect: disconnect }],
];

async function handleConnect() {
  connecting.value = true;
  error.value = '';
  try {
    await connect();
  } catch (err) {
    error.value = err.message;
    // Surface the error briefly in console; a toast system could be wired in here
    console.error('Wallet connect failed:', err.message);
  } finally {
    connecting.value = false;
  }
}
</script>
