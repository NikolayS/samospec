import { hmacHex, timingSafeStringEqual } from "./codes";

// HMAC-signed session cookies for the spec gate. The cookie value is
// HMAC(SESSION_SECRET, "spec:" + hash + ":" + code_hash); the server
// secret is generated once on first container boot and lives in
// /etc/samospec/samospec.env. Verifying requires the secret AND the
// row's current code_hash, so:
//   - a DB read leak cannot forge cookies (no secret)
//   - rotating the code via re-publish invalidates outstanding cookies

function getSessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "SESSION_SECRET is unset or too short. The container init script " +
        "generates one on first boot; check /etc/samospec/samospec.env.",
    );
  }
  return s;
}

export async function signSessionCookie(
  hash: string,
  codeHash: string,
): Promise<string> {
  return hmacHex(getSessionSecret(), `spec:${hash}:${codeHash}`);
}

export async function verifySessionCookie(
  cookieValue: string,
  hash: string,
  codeHash: string,
): Promise<boolean> {
  const expected = await signSessionCookie(hash, codeHash);
  return timingSafeStringEqual(cookieValue, expected);
}
