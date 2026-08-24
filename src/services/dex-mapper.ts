import {
  readFile,
  writeFile,
  mkdir
} from "node:fs/promises";

import path from "node:path";

import { config } from "../config.js";
import { logger } from "../logger.js";
import type { DexPair } from "../mexc/dexscreener.js";

export interface TokenMapping {
  mexcContractId?: number | string;
  mexcSymbol: string;
  baseCoin: string;
  mexcQuoteCoin?: string;

  chainId: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  quoteSymbol: string;
  dexPairAddress: string;
  dexId: string;

  contractSize?: number;
  contractMultiplier?: number;

  liquidityUsd: number;
  volumeM5?: number;
  priceUsd?: number;
  pairCreatedAt?: number;

  mappedAt: string;
  status: "active" | "not_found" | "blacklisted";

  /**
   * Оставлено для совместимости
   * со старым dex-mapping.json.
   *
   * Не использовать как ключ состояния
   * SpreadEngine.
   */
  normalizedDexKey?: string;
}

export interface UpsertData {
  mexcContractId?: number | string;
  mexcSymbol: string;
  baseCoin: string;
  mexcQuoteCoin?: string;

  chainId: string;
  dexId: string;

  pairAddress: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  quoteSymbol: string;

  contractSize?: number;
  contractMultiplier?: number;

  liquidityUsd: number;
  volumeM5: number;
  priceUsd: number | null;
  pairCreatedAt?: number;

  status: "active" | "not_found" | "blacklisted";
  updatedAt: string;
  normalizedDexKey?: string;
}

function normalizeSymbol(
  value: string
): string {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[_\-/\s]/g, "");
}

export class DexMapper {
  private readonly mappings =
    new Map<string, TokenMapping>();

  private readonly filePath: string;

  constructor() {
    this.filePath = path.join(
      config.dataDir,
      "dex-mapping.json"
    );
  }

  async load(): Promise<void> {
    try {
      const raw =
        await readFile(
          this.filePath,
          "utf8"
        );

      const rows =
        JSON.parse(raw) as TokenMapping[];

      for (const row of rows) {
        if (row.status !== "active") {
          continue;
        }

        const normalized =
          normalizeSymbol(
            row.mexcSymbol
          );

        this.mappings.set(
          normalized,
          {
            ...row,

            baseCoin:
              row.baseCoin ?? "",

            contractMultiplier:
              row.contractMultiplier ??
              1,

            volumeM5:
              row.volumeM5 ?? 0,

            priceUsd:
              row.priceUsd
          }
        );
      }

      //logger.info(
      //  {
      //    count: this.mappings.size
      //  },
      //  "DEX mappings loaded"
      //);
    } catch {
      //logger.info(
      //  "No existing DEX mapping file, starting fresh"
      //);
    }
  }

  async save(): Promise<void> {
    await mkdir(
      config.dataDir,
      {
        recursive: true
      }
    );

    const activeMappings =
      [...this.mappings.values()]
        .filter(
          (mapping) =>
            mapping.status === "active"
        );

    await writeFile(
      this.filePath,
      JSON.stringify(
        activeMappings,
        null,
        2
      ),
      "utf8"
    );
  }

  get(
    mexcSymbol: string
  ): TokenMapping | undefined {
    const normalized =
      normalizeSymbol(mexcSymbol);

    return this.mappings.get(
      normalized
    );
  }

  getActive(): TokenMapping[] {
    return [
      ...this.mappings.values()
    ].filter(
      (mapping) =>
        mapping.status === "active"
    );
  }

  upsert(
    data: UpsertData
  ): void {
    const normalized =
      normalizeSymbol(
        data.mexcSymbol
      );

    const existing =
      this.mappings.get(
        normalized
      );

    const mapping: TokenMapping = {
      mexcContractId:
        data.mexcContractId ??
        existing?.mexcContractId,

      mexcSymbol:
        data.mexcSymbol,

      baseCoin:
        data.baseCoin ||
        existing?.baseCoin ||
        "",

      mexcQuoteCoin:
        data.mexcQuoteCoin ??
        existing?.mexcQuoteCoin,

      chainId:
        data.chainId,

      baseTokenAddress:
        data.baseTokenAddress,

      quoteTokenAddress:
        data.quoteTokenAddress,

      quoteSymbol:
        data.quoteSymbol,

      dexPairAddress:
        data.pairAddress,

      dexId:
        data.dexId,

      contractSize:
        data.contractSize ??
        existing?.contractSize,

      contractMultiplier:
        data.contractMultiplier ??
        existing?.contractMultiplier ??
        1,

      liquidityUsd:
        data.liquidityUsd,

      volumeM5:
        data.volumeM5,

      priceUsd:
        data.priceUsd ??
        existing?.priceUsd,

      pairCreatedAt:
        data.pairCreatedAt ??
        existing?.pairCreatedAt,

      mappedAt:
        data.updatedAt,

      status:
        data.status,

      normalizedDexKey:
        data.normalizedDexKey ??
        existing?.normalizedDexKey
    };

    this.mappings.set(
      normalized,
      mapping
    );
  }

  async addFromPair(
    mexcSymbol: string,
    baseCoin: string,
    pair: DexPair
  ): Promise<TokenMapping> {
    const normalized =
      normalizeSymbol(mexcSymbol);

    // Фильтр: baseCoin.length < 2
    if (baseCoin.length < 2) {
      logger.debug(
        {
          mexcSymbol,
          baseCoin
        },
        "Skipping DEX mapping: baseCoin too short"
      );

      throw new Error("baseCoin too short");
    }

    const mapping: TokenMapping = {
      mexcSymbol,

      baseCoin,

      mexcQuoteCoin:
        undefined,

      chainId:
        pair.chainId,

      baseTokenAddress:
        pair.baseTokenAddress,

      quoteTokenAddress:
        pair.quoteTokenAddress,

      quoteSymbol:
        pair.quoteSymbol,

      dexPairAddress:
        pair.pairAddress,

      dexId:
        pair.dexId,

      contractSize:
        undefined,

      contractMultiplier:
        1,

      liquidityUsd:
        pair.liquidityUsd,

      volumeM5:
        pair.volumeM5,

      priceUsd:
        pair.priceUsd,

      pairCreatedAt:
        pair.pairCreatedAt,

      mappedAt:
        new Date().toISOString(),

      status:
        "active",

      normalizedDexKey:
        normalizeSymbol(
          `${baseCoin}_${pair.quoteSymbol}`
        )
    };

    this.mappings.set(
      normalized,
      mapping
    );

    await this.save();

    return mapping;
  }

  async markNotFound(
    mexcSymbol: string,
    baseCoin: string
  ): Promise<void> {
    void mexcSymbol;
    void baseCoin;

    /**
     * Не сохраняем not_found в файл.
     * Повторный поиск будет выполняться
     * согласно логике ContractWatcher.
     */
  }
}
