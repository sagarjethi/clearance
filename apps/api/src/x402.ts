import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ExactServerScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/hono";
import { createWalletClient, http, publicActions, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type X402Config = {
  network: `eip155:${number}`;
  chainId: number;
  usdc: Address;
  payTo: Address;
  /** Smallest USDC units. */
  priceRaw: string;
  /** A hosted facilitator such as Launa. When unset, this process settles with `facilitatorKey`. */
  facilitatorUrl?: string;
  facilitatorKey?: Hex;
  rpcUrl: string;
};

function localFacilitator(config: X402Config): FacilitatorClient {
  if (!config.facilitatorKey) throw new Error("X402 needs a facilitator URL or a facilitator key");
  const account = privateKeyToAccount(config.facilitatorKey);
  const wallet = createWalletClient({
    account,
    chain: {
      id: config.chainId,
      name: "clearance",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    },
    transport: http(config.rpcUrl),
  }).extend(publicActions);
  const signer = toFacilitatorEvmSigner({ ...wallet, address: account.address } as never);
  const facilitator = new x402Facilitator().register(config.network, new ExactFacilitatorScheme(signer));
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async () => facilitator.getSupported() as never,
  };
}

/** Charges for a swap check. A refused payment gets a 402 and the check doesn't run. */
export function x402Paywall(config: X402Config, route: string, description: string) {
  const client = config.facilitatorUrl ? new HTTPFacilitatorClient({ url: config.facilitatorUrl }) : localFacilitator(config);
  const server = new x402ResourceServer(client).register(config.network, new ExactServerScheme());
  return paymentMiddleware(
    {
      [route]: {
        accepts: [
          {
            scheme: "exact",
            network: config.network,
            payTo: config.payTo,
            price: { amount: config.priceRaw, asset: config.usdc, extra: { name: "USDC", version: "2" } },
          },
        ],
        description,
      },
    },
    server,
  );
}
