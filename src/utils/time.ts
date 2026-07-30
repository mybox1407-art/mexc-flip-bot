export function isoNow(): string {
  return new Date().toISOString();
}

export function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
