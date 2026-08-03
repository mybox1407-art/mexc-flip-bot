import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { DexPair } from "../mexc/dexscreener.js";

export interface TokenMapping {
  mexcSymbol: string;
  baseCoin: string;
  chainId: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  quoteSymbol: string;
  dexPairAddress: string;
  dexId: string;
  liquidityUsd: number;
  pairCreatedAt?: number;
  mappedAt: string;
  status: "active" | "not_found" | "blacklisted";
}

export interface UpsertData {
  mexcSymbol: string;
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  quoteSymbol: string;
  liquidityUsd: number;
  volumeM5: number;
  priceUsd: number | null;
  status: "active" | "not_found" | "blacklisted";
  updatedAt: string;
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
    return [...this.mappings.values()].filter(
      (mapping) => mapping.status === "active"
    );
  }

  upsert(data: UpsertData): void {
    const existing = this.mappings.get(data.mexcSymbol);

    this.mappings.set(data.mexcSymbol, {
      mexcSymbol: data.mexcSymbol,
      baseCoin: existing?.baseCoin ?? "",
      chainId: data.chainId,
      baseTokenAddress: data.baseTokenAddress,
      quoteTokenAddress: data.quoteTokenAddress,
      quoteSymbol: data.quoteSymbol,
      dexPairAddress: data.pairAddress,
      dexId: data.dexId,
      liquidityUsd: data.liquidityUsd,
      pairCreatedAt: existing?.pairCreatedAt,
      mappedAt: existing?.mappedAt ?? data.updatedAt,
      status: data.status,
    });
  }

  async addFromPair(
    mexcSymbol: string,
    baseCoin: string,
    pair: DexPair
  ): Promise<TokenMapping> {
    const mapping: TokenMapping = {
      mexcSymbol,
      baseCoin,
      chainId: pair.chainId,
      baseTokenAddress: pair.baseTokenAddress,
      quoteTokenAddress: pair.quoteTokenAddress,
      quoteSymbol: pair.quoteSymbol,
      dexPairAddress: pair.pairAddress,
      dexId: pair.dexId,
      liquidityUsd: pair.liquidityUsd,
      pairCreatedAt: pair.pairCreatedAt,
      mappedAt: new Date().toISOString(),
      status: "active",
    };

    this.mappings.set(mexcSymbol, mapping);
    await this.save();
    return mapping;
  }

  async markNotFound(mexcSymbol: string, baseCoin: string): Promise<void> {
    this.mappings.set(mexcSymbol, {
      mexcSymbol,
      baseCoin,
      chainId: "",
      baseTokenAddress: "",
      quoteTokenAddress: "",
      quoteSymbol: "",
      dexPairAddress: "",
      dexId: "",
      liquidityUsd: 0,
      pairCreatedAt: undefined,
      mappedAt: new Date().toISOString(),
      status: "not_found",
    });

    await this.save();
  }
}
