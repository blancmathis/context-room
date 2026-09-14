// Some supported tablets receive their system WebView separately from Android.
// Keep the portable protocol unchanged and supply only missing standard helpers.
if (!Object.hasOwn) Object.defineProperty(Object, 'hasOwn', { value: (object, key) => Object.prototype.hasOwnProperty.call(object, key), configurable: true, writable: true });
if (!Array.prototype.at) Object.defineProperty(Array.prototype, 'at', { value(index) {
  const length = this.length, offset = Math.trunc(Number(index) || 0), position = offset < 0 ? length + offset : offset;
  return position < 0 || position >= length ? undefined : this[position];
}, configurable: true, writable: true });
if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value() {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}, configurable: true });
