import { scanToken } from "@clearance/shared";
import type { Address, PublicClient } from "viem";

export async function scanTokenFor(client: PublicClient, address: Address) {
  try {
    return await scanToken(client, address);
  } catch (error) {
    return { error: (error as Error).message.split("\n")[0] ?? "Couldn't read this token" };
  }
}
