import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { encodePacked, keccak256, type Hex } from "viem";

export const WORLD_ACR = ["https://world.org/oidc/acr/orb", "https://world.org/oidc/acr/orb-face"];
export const MAX_APPROVAL_AGE_SECONDS = 300;

export type HumanIssuerConfig = {
  issuer: string;
  jwksUri: string;
  clientId: string;
  acceptedAcr: string[];
};

export type HumanCheck =
  | { ok: true; sub: string; authTime: number; acr: string }
  | { ok: false; reason: string };

/** Binds a human approval to one exact action: the id_token's nonce commits to the action hash. */
export function approvalNonce(actionHash: Hex, salt: Hex): string {
  return keccak256(encodePacked(["bytes32", "bytes32"], [actionHash, salt]));
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function jwksFor(uri: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, jwks);
  }
  return jwks;
}

/**
 * Checks an id_token is a fresh approval of this action by the owner. Each verifier runs this
 * itself, so a compromised API can't invent an approval.
 */
export async function checkHumanApproval(
  config: HumanIssuerConfig,
  idToken: string,
  expected: { actionHash: Hex; salt: Hex; ownerSub: string },
  now: number = Math.floor(Date.now() / 1000),
): Promise<HumanCheck> {
  try {
    const { payload } = await jwtVerify(idToken, jwksFor(config.jwksUri), {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ["RS256"],
      currentDate: new Date(now * 1000),
    });
    if (payload.nonce !== approvalNonce(expected.actionHash, expected.salt)) {
      return { ok: false, reason: "approval was for a different action" };
    }
    if (typeof payload.acr !== "string" || !config.acceptedAcr.includes(payload.acr)) {
      return { ok: false, reason: "approval assurance level is too low" };
    }
    if (typeof payload.auth_time !== "number" || now - payload.auth_time > MAX_APPROVAL_AGE_SECONDS) {
      return { ok: false, reason: "approval is not fresh" };
    }
    if (!expected.ownerSub || payload.sub !== expected.ownerSub) {
      return { ok: false, reason: "approved by someone other than the owner" };
    }
    return { ok: true, sub: payload.sub, authTime: payload.auth_time, acr: payload.acr };
  } catch (error) {
    return { ok: false, reason: `token rejected: ${(error as Error).message}` };
  }
}
