import { getAddress, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const HAZARD_SIGNATURES = [
  "blacklist(address)",
  "addBlackList(address)",
  "setBlacklist(address,bool)",
  "mint(address,uint256)",
  "pause()",
  "setFee(uint256)",
  "setTax(uint256)",
] as const;

const HAZARDS = HAZARD_SIGNATURES.map((signature) => ({
  signature,
  selector: toFunctionSelector(`function ${signature}`).slice(2),
}));

/** Finds admin-function selectors pushed in runtime code. A real PUSH4 prefix (0x63) avoids most false hits. */
export function scanHazards(code: Hex): string[] {
  const body = code.toLowerCase().slice(2);
  return HAZARDS.filter(({ selector }) => {
    for (let i = body.indexOf(`63${selector}`); i !== -1; i = body.indexOf(`63${selector}`, i + 1)) {
      if (i % 2 === 0) return true;
    }
    return false;
  }).map((h) => h.signature);
}

/** Reads a token's code, following an EIP-1967 proxy, and lists admin functions found in it. */
export async function scanToken(client: PublicClient, address: Address): Promise<{ address: Address; hazards: string[] }> {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error("no contract at this address");
  let hazards = scanHazards(code);
  const slot = await client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION_SLOT });
  if (slot && BigInt(slot) !== 0n) {
    const implementation = getAddress(`0x${slot.slice(-40)}`);
    const implementationCode = await client.getCode({ address: implementation });
    if (implementationCode) hazards = [...new Set([...hazards, ...scanHazards(implementationCode)])];
  }
  return { address, hazards };
}
