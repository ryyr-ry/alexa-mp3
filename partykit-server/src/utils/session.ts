/**
 * セッショントークン（HMAC-SHA256署名）
 *
 * 形式: {base64url(payload)}.{base64url(signature)}
 * payload: JSON { exp: number } (UNIX timestamp)
 * signature: HMAC-SHA256(secret, payloadB64)
 *
 * Web Crypto API使用（エッジランタイム互換）
 */

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7日

/** セッショントークン生成 */
export async function createSessionToken(secret: string): Promise<string> {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_DURATION_MS });
  const payloadB64 = base64urlEncode(new TextEncoder().encode(payload));
  const sig = await hmacSign(secret, payloadB64);
  const sigB64 = base64urlEncode(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

/** セッショントークン検証（有効期限チェック込み） */
export async function verifySessionToken(
  token: string,
  secret: string
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return false;

  // 署名検証
  const expectedSig = await hmacSign(secret, payloadB64);
  const expectedB64 = base64urlEncode(new Uint8Array(expectedSig));
  if (sigB64 !== expectedB64) return false;

  // 有効期限チェック
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64urlDecode(payloadB64))
    ) as { exp: number };
    return typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
}

// ---------- ヘルパー ----------

async function hmacSign(secret: string, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
