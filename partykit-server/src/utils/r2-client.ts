/**
 * Cloudflare R2 クライアント（S3互換API）
 *
 * DI対応: コンストラクタで設定を注入（globalThis汚染なし）
 *
 * 設定値:
 *   endpoint   - R2のS3互換エンドポイント (例: https://<account_id>.r2.cloudflarestorage.com)
 *   bucket     - バケット名
 *   accessKey  - APIトークンのアクセスキーID
 *   secretKey  - APIトークンのシークレットアクセスキー
 */

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** S3署名のリージョン（Cloudflare R2は'auto'） */
  region?: string;
}

export class R2Client {
  constructor(private readonly config: R2Config) {}

  /** R2にオブジェクトを保存 */
  async put(
    key: string,
    data: ArrayBuffer | Uint8Array | string,
    contentType = "application/octet-stream"
  ): Promise<void> {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const url = `${this.config.endpoint}/${this.config.bucket}/${encodedKey}`;
    const body =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
    const bodyBuf = toArrayBuffer(body);

    const headers: Record<string, string> = { "Content-Type": contentType };
    const signedHeaders = await this.signRequest("PUT", key, headers, bodyBuf);

    const res = await fetch(url, {
      method: "PUT",
      headers: signedHeaders,
      body: bodyBuf,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[R2] PUT ${key} failed: ${res.status} ${errBody}`);
      throw new Error(`R2 PUT failed: ${res.status}`);
    }
  }

  /** R2からオブジェクトを取得 */
  async get(key: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const url = `${this.config.endpoint}/${this.config.bucket}/${encodedKey}`;
    const headers: Record<string, string> = {};
    const signedHeaders = await this.signRequest("GET", key, headers, null);

    const res = await fetch(url, { method: "GET", headers: signedHeaders });
    if (!res.ok) {
      if (res.status !== 404) {
        console.error(`[R2] GET ${key} failed: ${res.status}`);
      }
      return null;
    }

    return {
      data: await res.arrayBuffer(),
      contentType: res.headers.get("Content-Type") ?? "application/octet-stream",
    };
  }

  /** R2からオブジェクトを削除 */
  async delete(key: string): Promise<void> {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const url = `${this.config.endpoint}/${this.config.bucket}/${encodedKey}`;
    const headers: Record<string, string> = {};
    const signedHeaders = await this.signRequest("DELETE", key, headers, null);

    const res = await fetch(url, { method: "DELETE", headers: signedHeaders });
    if (!res.ok && res.status !== 404) {
      const errBody = await res.text().catch(() => "");
      console.error(`[R2] DELETE ${key} failed: ${res.status} ${errBody}`);
      throw new Error(`R2 DELETE failed: ${res.status}`);
    }
  }

  // ===========================================================
  // AWS Signature V4
  // ===========================================================

  private async signRequest(
    method: string,
    path: string,
    inputHeaders: Record<string, string>,
    body: ArrayBuffer | null
  ): Promise<Record<string, string>> {
    // caller側のheadersオブジェクトを変異させないためコピー
    const headers = { ...inputHeaders };
    const url = new URL(
      `${this.config.endpoint}/${this.config.bucket}/${path}`
    );
    const now = new Date();
    const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
    // ISO8601コンパクト形式: YYYYMMDDTHHmmssZ
    const amzDate =
      dateStamp +
      "T" +
      now.toISOString().slice(11, 19).replace(/:/g, "") +
      "Z";
    const region = this.config.region ?? "auto";
    const service = "s3";

    headers["x-amz-date"] = amzDate;
    headers["host"] = url.host;

    const payloadHash = await sha256Hex(body ?? new ArrayBuffer(0));
    headers["x-amz-content-sha256"] = payloadHash;

    const signedHeaderKeys = Object.keys(headers)
      .map((k) => k.toLowerCase())
      .sort();
    const signedHeaders = signedHeaderKeys.join(";");

    const canonicalHeaderLines =
      signedHeaderKeys
        .map((lk) => {
          const origKey = Object.keys(headers).find(
            (k) => k.toLowerCase() === lk
          );
          if (!origKey) return `${lk}:`;
          return `${lk}:${headers[origKey]!.trim()}`;
        })
        .join("\n") + "\n";

    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const canonicalUri = `/${this.config.bucket}/${encodedPath}`;
    const canonicalRequest = [
      method,
      canonicalUri,
      "", // query string
      canonicalHeaderLines,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      await sha256Hex(new TextEncoder().encode(canonicalRequest)),
    ].join("\n");

    const kDate = await hmacSha256(
      new TextEncoder().encode(`AWS4${this.config.secretKey}`),
      dateStamp
    );
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    const kSigning = await hmacSha256(kService, "aws4_request");
    const signature = await hmacSha256Hex(kSigning, stringToSign);

    headers[
      "Authorization"
    ] = `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return headers;
  }
}

// ===========================================================
// 暗号ヘルパー
// ===========================================================

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? toArrayBuffer(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(
  key: ArrayBuffer | Uint8Array,
  message: string
): Promise<ArrayBuffer> {
  const keyBuf = key instanceof Uint8Array ? toArrayBuffer(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message)
  );
}

async function hmacSha256Hex(
  key: ArrayBuffer | Uint8Array,
  message: string
): Promise<string> {
  const sig = await hmacSha256(key, message);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Uint8Arrayから安全にArrayBufferを取得（サブアレイ対応） */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  if (arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength) {
    return arr.buffer as ArrayBuffer;
  }
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}
