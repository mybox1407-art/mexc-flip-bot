import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { DexPair } from "../mexc/dexscreener.js";

export interface TokenMapping {
  mexcSymbol: string;
  baseCoin: string;
  solanaTokenAddress: string;
  dexPairAddress: string;
  dexId: string;
  liquidityUsd: number;
  mappedAt: string;
  status: "active" | "not_found" | "blacklisted";
}

export class DexMapper {
  private readonly mappings = new Map<string, TokenMapping>();
  private readonly filePath: string;

  constructor() {
    this.filePath = path.join(config.dataDir, "dex-mapping.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const rows = JSON.parse(raw) as TokenMapping[];

      for (const row of rows) {
        this.mappings.set(row.mexcSymbol, row);
      }

      logger.info({ count: this.mappings.size }, "DEX mappings loaded");
    } catch {
      logger.info("No existing DEX mapping file, starting fresh");
    }
  }

  async save(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(
      this.filePath,
      JSON.stringify([...this.mappings.values()], null, 2),
      "utf8"
    );
  }

  get(mexcSymbol: string): TokenMapping | undefined {
    return this.mappings.get(mexcSymbol);
  }

  getActive(): TokenMapping[] {
    return [...this.mappings.values()].filter((m) => m.status === "active");
  }

  async addFromPair(mexcSymbol: string, baseCoin: string, pair: DexPair): Promise<TokenMapping> {
    const mapping: TokenMapping = {
      mexcSymbol,
      baseCoin,
      solanaTokenAddress: pair.baseTokenAddress,
      dexPairAddress: pair.pairAddress,
      dexId: pair.dexId,
      liquidityUsd: pair.liquidityUsd,
      mappedAt: new Date().toISOString(),
      status: "active"
    };

    this.mappings.set(mexcSymbol, mapping);
    await this.save();
    return mapping;
  }

  async markNotFound(mexcSymbol: string, baseCoin: string): Promise<void> {
    this.mappings.set(mexcSymbol, {
      mexcSymbol,
      baseCoin,
      solanaTokenAddress: "",
      dexPairAddress: "",
      dexId: "",
      liquidityUsd: 0,
      mappedAt: new Date().toISOString(),
      status: "not_found"
    });
    await this.save();
  }
}
