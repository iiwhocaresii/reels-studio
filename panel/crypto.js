/* GitHub Secrets encryption: libsodium crypto_box_seal (X25519 + XSalsa20-Poly1305).
 * The box comes from tweetnacl, nonce = BLAKE2b-192(ephemeral_pk || recipient_pk).
 * Works in the browser (window.PodCrypto) and in Node (module.exports) for tests.
 */
(function (root) {
  const M = (1n << 64n) - 1n;
  const IV = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ];
  const SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  ];
  const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & M;

  function G(v, a, b, c, d, x, y) {
    v[a] = (v[a] + v[b] + x) & M; v[d] = rotr(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & M;     v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & M; v[d] = rotr(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & M;     v[b] = rotr(v[b] ^ v[c], 63n);
  }

  function compress(h, block, t, last) {
    const m = [];
    for (let i = 0; i < 16; i++) {
      let w = 0n;
      for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(block[i * 8 + j]);
      m.push(w);
    }
    const v = h.concat(IV);
    v[12] ^= t & M;
    v[13] ^= t >> 64n;
    if (last) v[14] ^= M;
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      G(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);   G(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
      G(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);  G(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
      G(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);  G(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
      G(v, 2, 7, 8, 13, m[s[12]], m[s[13]]); G(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }

  function blake2b(input, outlen) {
    const h = IV.slice();
    h[0] ^= 0x01010000n ^ BigInt(outlen);
    let t = 0n, offset = 0;
    while (input.length - offset > 128) {
      t += 128n;
      compress(h, input.subarray(offset, offset + 128), t, false);
      offset += 128;
    }
    const last = new Uint8Array(128);
    last.set(input.subarray(offset));
    t += BigInt(input.length - offset);
    compress(h, last, t, true);
    const out = new Uint8Array(outlen);
    for (let i = 0; i < outlen; i++) out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
    return out;
  }

  const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64encode = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };

  /** Encrypts text with the repository's public key (base64) → base64 for the GitHub API. */
  function sealSecret(nacl, publicKeyB64, plaintext) {
    const pk = b64decode(publicKeyB64);
    const eph = nacl.box.keyPair();
    const nonceInput = new Uint8Array(64);
    nonceInput.set(eph.publicKey);
    nonceInput.set(pk, 32);
    const nonce = blake2b(nonceInput, 24);
    const boxed = nacl.box(new TextEncoder().encode(plaintext), nonce, pk, eph.secretKey);
    const sealed = new Uint8Array(32 + boxed.length);
    sealed.set(eph.publicKey);
    sealed.set(boxed, 32);
    return b64encode(sealed);
  }

  const api = { blake2b, sealSecret, b64encode, b64decode };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PodCrypto = api;
})(typeof window !== "undefined" ? window : globalThis);
