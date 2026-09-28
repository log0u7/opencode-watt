// Approximate residential retail prices, early 2026, taxes included.
// Order-of-magnitude defaults only: override with price_per_kwh for an exact tariff.
export type Tariff = { currency: string; kwh: number };

export const TARIFFS: Record<string, Tariff> = {
  FR: { currency: "EUR", kwh: 0.2016 },
  DE: { currency: "EUR", kwh: 0.39 },
  IT: { currency: "EUR", kwh: 0.35 },
  ES: { currency: "EUR", kwh: 0.26 },
  NL: { currency: "EUR", kwh: 0.31 },
  BE: { currency: "EUR", kwh: 0.31 },
  PT: { currency: "EUR", kwh: 0.23 },
  AT: { currency: "EUR", kwh: 0.29 },
  IE: { currency: "EUR", kwh: 0.36 },
  CH: { currency: "CHF", kwh: 0.28 },
  GB: { currency: "GBP", kwh: 0.27 },
  NO: { currency: "NOK", kwh: 1.2 },
  SE: { currency: "SEK", kwh: 1.2 },
  DK: { currency: "DKK", kwh: 2.2 },
  PL: { currency: "PLN", kwh: 1.15 },
  US: { currency: "USD", kwh: 0.17 },
  CA: { currency: "CAD", kwh: 0.12 },
};

const ZONE_COUNTRY: Record<string, string> = {
  "Europe/Paris": "FR",
  "Europe/Berlin": "DE",
  "Europe/Rome": "IT",
  "Europe/Madrid": "ES",
  "Europe/Lisbon": "PT",
  "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE",
  "Europe/Vienna": "AT",
  "Europe/Dublin": "IE",
  "Europe/Zurich": "CH",
  "Europe/London": "GB",
  "Europe/Oslo": "NO",
  "Europe/Stockholm": "SE",
  "Europe/Copenhagen": "DK",
  "Europe/Warsaw": "PL",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Phoenix": "US",
  "America/Los_Angeles": "US",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
};

const DEFAULT_COUNTRY = "FR";
const MINUTES_PER_DAY = 24 * 60;

export type RateWindow = { start: string; end: string; price_per_kwh: number };

export type PricingConfig = {
  country?: string | null;
  price_per_kwh?: number | null;
  currency?: string | null;
  windows?: RateWindow[];
};

export type Rate = { price_per_kwh: number; currency: string; label: string };

export function systemTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

export function detectCountry(tz: string | null): string | null {
  return (tz !== null && ZONE_COUNTRY[tz]) || null;
}

function minutesOfDay(d: Date, tz: string | null): number {
  // Format the instant in the local zone without depending on the host zone.
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz ?? undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return 0;
  }
  return ((hour % 24) * 60 + minute) % MINUTES_PER_DAY;
}

function parseHhMm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function inWindow(minutes: number, start: string, end: string): boolean {
  const s = parseHhMm(start);
  const e = parseHhMm(end);
  if (s === null || e === null) return false;
  if (s === e) return true; // degenerate window: treat as always-on
  if (s < e) return minutes >= s && minutes < e;
  return minutes >= s || minutes < e; // wraps midnight
}

export function resolveRate(
  cfg: PricingConfig,
  at: Date,
  meterCountry?: string | null,
  tz?: string | null,
): Rate {
  const zone = tz ?? systemTimezone();
  const country = meterCountry ?? cfg.country ?? detectCountry(zone) ?? DEFAULT_COUNTRY;
  const fallback = TARIFFS[DEFAULT_COUNTRY] ?? { currency: "EUR", kwh: 0.2016 };
  const tableCurrency = TARIFFS[country]?.currency ?? fallback.currency;
  const tablePrice = TARIFFS[country]?.kwh ?? fallback.kwh;

  if (typeof cfg.price_per_kwh === "number" && Number.isFinite(cfg.price_per_kwh)) {
    return {
      price_per_kwh: cfg.price_per_kwh,
      currency: cfg.currency ?? tableCurrency,
      label: "custom",
    };
  }

  const now = minutesOfDay(at, zone);
  for (const w of cfg.windows ?? []) {
    if (inWindow(now, w.start, w.end)) {
      return {
        price_per_kwh: w.price_per_kwh,
        currency: cfg.currency ?? tableCurrency,
        label: `${w.start}-${w.end}`,
      };
    }
  }

  return { price_per_kwh: tablePrice, currency: tableCurrency, label: country };
}

export function cost(joules: number, rate: Rate): number {
  return (joules * rate.price_per_kwh) / 3_600_000;
}
