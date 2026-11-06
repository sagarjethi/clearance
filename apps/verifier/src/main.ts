import { WORLD_ACR, loadDeployment } from "@clearance/shared";
import { serve } from "@hono/node-server";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ModelProvider } from "./review";
import { verifierApp } from "./server";
import { Verifier } from "./verifier";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const deployment = loadDeployment(required("DEPLOYMENT_FILE"));
const provider = (process.env.MODEL_PROVIDER ?? "none") as ModelProvider;
const verifier = new Verifier({
  signer: privateKeyToAccount(required("VERIFIER_KEY") as Hex),
  client: createPublicClient({ transport: http(required("RPC_URL")) }),
  chainId: deployment.chainId,
  hook: deployment.hook,
  quoter: deployment.quoter,
  stateView: deployment.stateView,
  resolver: deployment.resolver,
  stableTokens: [deployment.usdc],
  review: {
    provider,
    model: process.env.MODEL_NAME,
    apiKey: process.env.MODEL_API_KEY,
    baseUrl: process.env.MODEL_BASE_URL,
  },
  human: process.env.WORLD_ISSUER
    ? {
        issuer: process.env.WORLD_ISSUER,
        jwksUri: required("WORLD_JWKS_URI"),
        clientId: required("WORLD_CLIENT_ID"),
        acceptedAcr: process.env.WORLD_ACCEPTED_ACR?.split(",") ?? WORLD_ACR,
      }
    : undefined,
});

const port = Number(required("PORT"));
serve({ fetch: verifierApp(verifier, { provider }).fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`verifier ${verifier.address} (${provider}) on :${port}`);
});
