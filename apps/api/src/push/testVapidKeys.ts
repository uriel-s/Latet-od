// A fresh VAPID key pair for the push tests. Test-only, like ../fakeDeps.ts: production never
// makes keys, Yoel makes them once with the `node -e` one-liner in apps/api/.env.example and puts
// them in env. This is that same recipe, so the tests also prove its output is accepted
// (including the ~1 key in 256 whose private key comes out a byte short).
import { createECDH } from 'node:crypto';

/** A random P-256 key pair in base64url, made exactly as the `.env.example` recipe makes it. */
export function makeVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey('base64url'),
    privateKey: ecdh.getPrivateKey('base64url'),
  };
}
