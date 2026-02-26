import { ref, computed } from 'vue';

// Singleton state shared across all composable calls
const _provider = ref(null);
const _publicKey = ref(null);

function detectProvider() {
  if (typeof window === 'undefined') return null;
  // Prefer Phantom's namespaced injection, fall back to legacy window.solana
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solflare?.isSolflare) return window.solflare;
  if (window.solana) return window.solana;
  return null;
}

export function useWallet() {
  const connected = computed(() => !!_publicKey.value);
  const publicKey = computed(() => _publicKey.value);
  const shortAddress = computed(() => {
    const pk = _publicKey.value;
    if (!pk) return null;
    return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
  });

  async function connect() {
    const provider = detectProvider();
    if (!provider) {
      throw new Error('No Solana wallet found. Please install Phantom or Solflare.');
    }
    await provider.connect();
    _provider.value = provider;
    _publicKey.value = provider.publicKey.toBase58();

    // Keep state in sync if the user switches accounts or disconnects
    provider.on?.('accountChanged', (newKey) => {
      _publicKey.value = newKey ? newKey.toBase58() : null;
    });
    provider.on?.('disconnect', () => {
      _publicKey.value = null;
      _provider.value = null;
    });
  }

  async function disconnect() {
    await _provider.value?.disconnect?.();
    _publicKey.value = null;
    _provider.value = null;
  }

  /**
   * Sign and broadcast a partially-signed transaction returned by /buildJobTx.
   * Returns the base58 transaction signature.
   */
  async function signAndSend(base64tx) {
    if (!_provider.value) throw new Error('Wallet not connected');

    const { Transaction } = await import('@solana/web3.js');
    const txBytes = Buffer.from(base64tx, 'base64');
    const tx = Transaction.from(txBytes);

    const { signature } = await _provider.value.signAndSendTransaction(tx);
    return signature;
  }

  return { connected, publicKey, shortAddress, connect, disconnect, signAndSend };
}
