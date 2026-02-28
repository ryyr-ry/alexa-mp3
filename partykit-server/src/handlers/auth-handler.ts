import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { TursoDb } from "../utils/db";
import { createSessionToken } from "../utils/session";
import { jsonResponse } from "../utils/json-response";

const RP_NAME = "Alexa MP3 Player";

// ---------- ステータス ----------

/** 認証状態を返す（needs-setup / needs-login） */
export async function handleAuthStatus(db: TursoDb): Promise<Response> {
  const count = await db.getCredentialCount();
  if (count === 0) {
    return jsonResponse({ status: "needs-setup" });
  }
  const userName = await db.getUserName();
  return jsonResponse({ status: "needs-login", userName });
}

// ---------- 登録フロー ----------

/** 登録オプション生成（先着1名: credentials > 0 なら403） */
export async function handleRegisterOptions(
  db: TursoDb,
  rpId: string,
  body: { userName: string },
): Promise<Response> {
  const count = await db.getCredentialCount();
  if (count > 0) {
    return jsonResponse({ error: "Registration closed" }, 403);
  }
  if (!body.userName?.trim()) {
    return jsonResponse({ error: "userName is required" }, 400);
  }

  const userId = crypto.randomUUID();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId,
    userName: body.userName.trim(),
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  // チャレンジを一時保存（challenge IDとしてuserIdを使用）
  const challengeId = crypto.randomUUID();
  await db.saveChallenge(challengeId, options.challenge, "register");

  return jsonResponse({
    options,
    challengeId,
    userId,
  });
}

/** 登録検証 */
export async function handleRegisterVerify(
  db: TursoDb,
  rpId: string,
  expectedOrigin: string,
  apiSecret: string,
  body: {
    challengeId: string;
    userId: string;
    userName: string;
    credential: unknown;
  },
): Promise<Response> {
  const count = await db.getCredentialCount();
  if (count > 0) {
    return jsonResponse({ error: "Registration closed" }, 403);
  }

  const challenge = await db.getAndDeleteChallenge(body.challengeId);
  if (!challenge) {
    return jsonResponse({ error: "Invalid or expired challenge" }, 400);
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: body.credential as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpId,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return jsonResponse({ error: "Verification failed" }, 400);
    }

    const { credential } = verification.registrationInfo;

    // 公開鍵をbase64urlで保存
    const publicKeyB64 = uint8ToBase64url(credential.publicKey);
    const transports = (
      (body.credential as { response?: { transports?: string[] } })?.response?.transports ?? []
    ).join(",");

    await db.saveCredential({
      id: credential.id,
      userId: body.userId,
      userName: body.userName.trim(),
      publicKey: publicKeyB64,
      counter: credential.counter,
      transports,
    });

    const token = await createSessionToken(apiSecret);
    return jsonResponse({ verified: true, token });
  } catch (err) {
    console.error("[Auth] Registration verification error:", err);
    return jsonResponse({ error: "Verification failed" }, 400);
  }
}

// ---------- ログインフロー ----------

/** ログインオプション生成 */
export async function handleLoginOptions(
  db: TursoDb,
  rpId: string,
): Promise<Response> {
  const credentials = await db.getCredentials();
  if (credentials.length === 0) {
    return jsonResponse({ error: "No credentials registered" }, 400);
  }

  const allowCredentials = credentials.map((c) => ({
    id: c.id,
    transports: (c.transports ? c.transports.split(",") : []) as ("internal" | "hybrid" | "ble" | "nfc" | "usb")[],
  }));

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials,
    userVerification: "preferred",
  });

  const challengeId = crypto.randomUUID();
  await db.saveChallenge(challengeId, options.challenge, "login");

  return jsonResponse({ options, challengeId });
}

/** ログイン検証 */
export async function handleLoginVerify(
  db: TursoDb,
  rpId: string,
  expectedOrigin: string,
  apiSecret: string,
  body: { challengeId: string; credential: unknown },
): Promise<Response> {
  const challenge = await db.getAndDeleteChallenge(body.challengeId);
  if (!challenge) {
    return jsonResponse({ error: "Invalid or expired challenge" }, 400);
  }

  const credResponse = body.credential as { id: string; rawId: string; response: unknown; type: string };
  const stored = await db.getCredentialById(credResponse.id);
  if (!stored) {
    return jsonResponse({ error: "Unknown credential" }, 400);
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response: credResponse as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpId,
      credential: {
        id: stored.id,
        publicKey: base64urlToUint8(stored.publicKey),
        counter: stored.counter,
        transports: (stored.transports ? stored.transports.split(",") : []) as ("internal" | "hybrid" | "ble" | "nfc" | "usb")[],
      },
    });

    if (!verification.verified) {
      return jsonResponse({ error: "Verification failed" }, 400);
    }

    await db.updateCredentialCounter(
      stored.id,
      verification.authenticationInfo.newCounter,
    );

    const token = await createSessionToken(apiSecret);
    return jsonResponse({ verified: true, token });
  } catch (err) {
    console.error("[Auth] Login verification error:", err);
    return jsonResponse({ error: "Verification failed" }, 400);
  }
}

// ---------- ヘルパー ----------

function uint8ToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToUint8(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
