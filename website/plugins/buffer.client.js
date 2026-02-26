import { Buffer } from 'buffer';

// @solana/web3.js requires Buffer to be available as a global in the browser
if (typeof window !== 'undefined') {
  window.Buffer = Buffer;
}
globalThis.Buffer = Buffer;

export default defineNuxtPlugin(() => {});
