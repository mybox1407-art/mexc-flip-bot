// src/services/csv-writer.ts — новая версия
import { appendFile, close as fsClose, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import type { CsvRow } from "../types.js";

function escapeCsv(value: CsvRow[string]): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export class CsvWriter {
  private readonly filePath: string;
  private initialized = false;
  private fd?: import("node:fs/promises").FileHandle;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async appendRow(row: CsvRow): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const columns = Object.keys(row);
    const exists = await this.fileExistsAndNotEmpty();
    const line = columns.map((c) => escapeCsv(row[c])).join(",");
    const output = (!exists && !this.initialized)
      ? `${columns.join(",")}\n${line}\n`
      : `${line}\n`;
    await appendFile(this.filePath, output, "utf8");
    this.initialized = true;
  }

  async close(): Promise<void> {
    // appendFile не держит хендл открытым — ничего закрывать не нужно
  }

  private async fileExistsAndNotEmpty(): Promise<boolean> {
    try {
      const s = await stat(this.filePath);
      return s.size > 0;
    } catch {
      return false;
    }
  }
}
