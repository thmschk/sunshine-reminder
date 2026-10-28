// Base64url (wie im Server-Schlüssel der Erinnerung, /api/vapid) in Bytes, für pushManager.subscribe.
export function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
