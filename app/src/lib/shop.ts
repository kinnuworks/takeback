// The shop's public on-chain setup (written by scripts/setup-shop.mjs after the genesis
// transaction). Holds no secrets: addresses, public keys and the receipt category.
import mainnet from "../shop/mainnet.json" with { type: "json" };
import chipnet from "../shop/chipnet.json" with { type: "json" };

export interface ShopConfig {
  network: "mainnet" | "chipnet";
  name: string;
  category: string;
  minterAddress: string;
  minterTokenAddress: string;
  merchantAddress: string;
  merchantPkh: string;
  refundPk: string;
  ownerPk: string;
  minters: number;
  floatEach: string;
  bcmrUrl: string;
  genesisTxid?: string;
}

const all: Record<string, unknown> = { mainnet, chipnet };

export function loadShop(network: "mainnet" | "chipnet"): ShopConfig | undefined {
  const c = all[network] as (ShopConfig & { notSetUp?: boolean }) | undefined;
  return c && !c.notSetUp ? c : undefined;
}
