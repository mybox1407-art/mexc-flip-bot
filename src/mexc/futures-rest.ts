import { config } from "../config.js";
import { logger } from "../logger.js";
import type { MexcContract } from "../types.js";

interface ContractsResponse {
  success?: boolean;
  code?: number;
  data?: MexcContract[];
  message?: string;
}

export class MexcFuturesRestClient {
  async getContracts(): Promise<MexcContract[]> {
    const url = `${config.mexcRestUrl}/api/v1/contract/detail`;

    const response = await fetch(url, {
      headers: {
        accept: "application/json"
      },
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      throw new Error(`MEXC contract/detail failed: ${response.status}`);
    }

    const payload = (await response.json()) as ContractsResponse;

    if (!payload.success || !Array.isArray(payload.data)) {
      logger.warn({ payload }, "Unexpected MEXC contracts response");
      return [];
    }

    return payload.data.filter((contract) => Boolean(contract.symbol));
  }
}
