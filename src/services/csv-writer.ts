import {
  appendFile,
  mkdir,
  stat
} from "node:fs/promises";
import path from "node:path";
import type { CsvRow } from "../types.js";

function escapeCsv(value: CsvRow[string]): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);

  if (
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r")
  ) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

export class CsvWriter {
  private readonly filePath: string;
  private readonly fixedColumns?: readonly string[];

  private initialized = false;
  private columns?: string[];

  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    filePath: string,
    columns?: readonly string[]
  ) {
    this.filePath = filePath;
    this.fixedColumns = columns;
  }

  async appendRow(row: CsvRow): Promise<void> {
    this.writeQueue = this.writeQueue.then(
      () => this.writeRow(row),
      () => this.writeRow(row)
    );

    return this.writeQueue;
  }

  async close(): Promise<void> {
    await this.writeQueue;
  }

  private async writeRow(row: CsvRow): Promise<void> {
    await mkdir(path.dirname(this.filePath), {
      recursive: true
    });

    const exists = await this.fileExistsAndNotEmpty();

    if (!this.columns) {
      this.columns = this.fixedColumns
        ? [...this.fixedColumns]
        : Object.keys(row);
    }

    const columns = this.columns;

    const line = columns
      .map((column) => {
        const value = Object.prototype.hasOwnProperty.call(
          row,
          column
        )
          ? row[column]
          : "";

        return escapeCsv(value);
      })
      .join(",");

    let output = "";

    if (!exists && !this.initialized) {
      output += `${columns.join(",")}\n`;
    }

    output += `${line}\n`;

    await appendFile(
      this.filePath,
      output,
      "utf8"
    );

    this.initialized = true;
  }

  private async fileExistsAndNotEmpty(): Promise<boolean> {
    try {
      const fileStat = await stat(this.filePath);
      return fileStat.size > 0;
    } catch {
      return false;
    }
  }
}
