export const usd = (units: bigint | number, dp = 2) =>
  `$${(Number(units) / 1e6).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

export function skuName(hex: string) {
  const bytes = hex.replace(/^0x/, "").match(/.{2}/g) ?? [];
  return bytes
    .map((b) => String.fromCharCode(parseInt(b, 16)))
    .join("")
    .replace(/\0+$/, "");
}

export function countdown(target: number, now: number) {
  let s = Math.max(0, target - now);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s - m * 60}s`;
}
