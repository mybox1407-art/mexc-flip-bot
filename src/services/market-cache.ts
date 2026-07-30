import { config } from "../config.js";
import type { MexcTicker, PricePoint } from "../types.js";

export class MarketCache {
  private readonly tickerBySymbol = new Map<string, MexcTicker>();
  private readonly pricesBySymbol = new Map<string, PricePoint[]>();

  updateTicker(ticker: MexcTicker): void {
    this.tickerBySymbol.set(ticker.symbol, ticker);

    if (ticker.lastPrice <= 0) {
      return;
    }

    const points = this.pricesBySymbol.get(ticker.symbol) ?? [];

    points.push({
      price: ticker.lastPrice,
      timestamp: ticker.timestamp || Date.now()
    });

    const cutoff = Date.now() - config.signalWindowMs * 2;
    const trimmed = points.filter((point) => point.timestamp >= cutoff);

    this.pricesBySymbol.set(ticker.symbol, trimmed);
  }

  getTicker(symbol: string): MexcTicker | undefined {
    return this.tickerBySymbol.get(symbol);
  }

  getReferencePrice(symbol: string): number | null {
    const points = this.pricesBySymbol.get(symbol);

    if (!points || points.length < 2) {
      return null;
    }

    const targetTime = Date.now() - config.signalWindowMs;

    let closest = points[0];
    let smallestDistance = Math.abs(points[0].timestamp - targetTime);

    for (const point of points) {
      const distance = Math.abs(point.timestamp - targetTime);

      if (distance < smallestDistance) {
        closest = point;
        smallestDistance = distance;
      }
    }

    return closest.price;
  }
}
