import { approvalNonce, checkHumanApproval, type Action, type HumanIssuerConfig, actionHash } from "@clearance/shared";
import { createHash, randomBytes } from "node:crypto";
import type { Hex } from "viem";
import type { Checkpoint, Store } from "./store";

export type HumanGateConfig = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  acceptedAcr: string[];
  /** The browser-facing dashboard, where the owner lands after the issuer. */
  returnUrl?: string;
};

type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };

const CHECKPOINT_SECONDS = 300;

/** A World ID step-up checkpoint: a fresh login, bound to one action, validated on the backend. */
export class HumanGate {
  private discovery?: Discovery;

  constructor(
    private config: HumanGateConfig,
    private store: Store,
  ) {}

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const response = await fetch(`${this.config.issuer}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error(`issuer discovery failed with ${response.status}`);
    const doc = (await response.json()) as Discovery;
    if (doc.issuer !== this.config.issuer) throw new Error("issuer discovery returned a different issuer");
    this.discovery = doc;
    return doc;
  }

  private async issuerConfig(): Promise<HumanIssuerConfig> {
    const doc = await this.discover();
    return { issuer: doc.issuer, jwksUri: doc.jwks_uri, clientId: this.config.clientId, acceptedAcr: this.config.acceptedAcr };
  }

  create(action: Action): Checkpoint {
    const checkpoint: Checkpoint = {
      id: randomBytes(12).toString("hex"),
      actionHash: actionHash(action),
      action,
      status: "pending",
      state: randomBytes(24).toString("base64url"),
      salt: `0x${randomBytes(32).toString("hex")}`,
      codeVerifier: randomBytes(48).toString("base64url"),
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.store.saveCheckpoint(checkpoint);
    return checkpoint;
  }

  /** Reads a checkpoint, expiring it if the owner took too long. */
  read(id: string): Checkpoint | undefined {
    const checkpoint = this.store.checkpoint(id);
    if (!checkpoint) return undefined;
    if (checkpoint.status === "pending" && Date.now() / 1000 - checkpoint.createdAt > CHECKPOINT_SECONDS) {
      const expired: Checkpoint = { ...checkpoint, status: "expired" };
      this.store.saveCheckpoint(expired);
      return expired;
    }
    return checkpoint;
  }

  async authorizationUrl(checkpoint: Checkpoint): Promise<string> {
    const doc = await this.discover();
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: "openid",
      state: checkpoint.state,
      nonce: approvalNonce(checkpoint.actionHash as Hex, checkpoint.salt as Hex),
      code_challenge: createHash("sha256").update(checkpoint.codeVerifier).digest("base64url"),
      code_challenge_method: "S256",
      max_age: "0",
      prompt: "login",
      acr_values: this.config.acceptedAcr.join(" "),
    }).toString();
    return url.toString();
  }

  /** Handles the issuer's redirect. Anything other than a fully valid approval ends as denied. */
  async callback(params: {
    state?: string;
    code?: string;
    error?: string;
    iss?: string;
  }, ownerSub: string): Promise<Checkpoint | undefined> {
    if (!params.state) return undefined;
    const checkpoint = this.store.checkpointByState(params.state);
    if (!checkpoint) return undefined;
    if (checkpoint.status !== "pending") return checkpoint;

    const finish = (status: "approved" | "denied", detail: string, idToken?: string) => {
      const next: Checkpoint = { ...checkpoint, status, detail, idToken };
      this.store.saveCheckpoint(next);
      return next;
    };

    const doc = await this.discover();
    if (params.iss && params.iss !== doc.issuer) return finish("denied", "Response came from the wrong issuer");
    if (params.error) return finish("denied", `The owner did not approve (${params.error})`);
    if (!params.code) return finish("denied", "The issuer returned no code");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: checkpoint.codeVerifier,
    });
    if (this.config.clientSecret) body.set("client_secret", this.config.clientSecret);
    const response = await fetch(doc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) return finish("denied", `Token exchange failed with ${response.status}`);
    const tokens = (await response.json()) as { id_token?: string };
    if (!tokens.id_token) return finish("denied", "The issuer returned no id_token");

    const check = await checkHumanApproval(await this.issuerConfig(), tokens.id_token, {
      actionHash: checkpoint.actionHash as Hex,
      salt: checkpoint.salt as Hex,
      ownerSub,
    });
    if (!check.ok) return finish("denied", check.reason);
    return finish("approved", "Fresh approval from the owner", tokens.id_token);
  }

  get returnUrl(): string | undefined {
    return this.config.returnUrl;
  }
}
