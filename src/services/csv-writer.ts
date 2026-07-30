import { appendFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { CsvRow } from "../types.js";

function escapeCsv(value: CsvRow[string]): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);

  if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }

  return text;
}

export class CsvWriter {
  private readonly initialized = new Set<string>();

  async append(fileName: string, row: CsvRow): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });

    const fullPath = path.join(config.dataDir, fileName);
    const columns = Object.keys(row);
    const exists = await this.fileExistsAndNotEmpty(fullPath);

    const header = columns.join(",");
    const line = columns.map((column) => escapeCsv(row[column])).join(",");

    const output =
      !exists && !this.initialized.has(fullPath)
        ? `${header}\n${line}\n`
        : `${line}\n`;

    await appendFile(fullPath, output, "utf8");
    this.initialized.add(fullPath);
  }

  private async fileExistsAndNotEmpty(filePath: string): Promise<boolean> {
    try {
      const file = await stat(filePath);
      return file.size > 0;
    } catch {
      return false;
    }
  }
}
