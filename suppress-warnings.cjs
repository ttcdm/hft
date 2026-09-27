/* eslint-disable */
// Suppress benign bigint-buffer native binding fallback notice
const originalWarn = console.warn;
console.warn = function (...args) {
  if (
    typeof args[0] === 'string' &&
    args[0].includes('bigint: Failed to load bindings')
  ) {
    return;
  }
  originalWarn.apply(console, args);
};

const originalError = console.error;
console.error = function (...args) {
  if (
    typeof args[0] === 'string' &&
    args[0].includes('bigint: Failed to load bindings')
  ) {
    return;
  }
  originalError.apply(console, args);
};

