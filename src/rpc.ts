import { Rpc } from "@opencode/plugin/rpc";

// The TUI reads one compact snapshot per tick over RPC. The pure helpers
// (snapshotFromReport, formatSnapshot) are testable without a renderer; the
// definition itself carries the wire schema.

export type WattSnapshot = {
  /** Live power draw summed across meters; null when no meter reports. */
  watts: number | null;
  /** Energy attributed today; null before the first busy tick. */
  day_kwh: number | null;
  /** Cost today at the active rate; null before the first busy tick. */
  day_cost: number | null;
  currency: string | null;
  /** Configured daily budget; null when unset. */
  budget_kwh: number | null;
  /** Fraction of the daily budget used; null when unset or zero budget. */
  budget_used_ratio: number | null;
};

/** Structural input: the engine's ReportData satisfies this without importing it. */
export type SnapshotInput = {
  meters: ReadonlyArray<{ watts: number }>;
  day: { attributed_kwh: number; cost: number } | null;
  rate: { currency: string } | null;
  budget: { budget_kwh: number; attributed_kwh: number } | null;
};

export function snapshotFromReport(data: SnapshotInput): WattSnapshot {
  const watts =
    data.meters.length > 0
      ? data.meters.reduce((sum, m) => sum + (Number.isFinite(m.watts) ? m.watts : 0), 0)
      : null;
  const budget_used_ratio =
    data.budget && data.budget.budget_kwh > 0
      ? data.budget.attributed_kwh / data.budget.budget_kwh
      : null;
  return {
    watts,
    day_kwh: data.day?.attributed_kwh ?? null,
    day_cost: data.day?.cost ?? null,
    currency: data.rate?.currency ?? null,
    budget_kwh: data.budget?.budget_kwh ?? null,
    budget_used_ratio,
  };
}

/** One footer line: "142 W · 0.050 kWh · €0.0123 · 3% of 2 kWh budget". Null when
 * there is nothing to show, so the slot stays hidden instead of rendering dashes. */
/** Budget bar for the /watt dialog: "█████░░░░░ 25%" at the given width.
 * Returns null when there is no budget, so the dialog omits the line. */
export function budgetBar(ratio: number | null, width: number): string | null {
  if (ratio === null) return null;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `${bar} ${Math.round(ratio * 100)}%`;
}

export function formatSnapshot(s: WattSnapshot): string | null {
  const parts: string[] = [];
  if (s.watts !== null) {
    parts.push(`${Math.round(s.watts)} W`);
  }
  if (s.day_kwh !== null) {
    parts.push(`${s.day_kwh.toFixed(3)} kWh`);
  }
  if (s.day_cost !== null && s.currency) {
    try {
      parts.push(
        new Intl.NumberFormat("en", { style: "currency", currency: s.currency }).format(s.day_cost),
      );
    } catch {
      parts.push(`${s.day_cost.toFixed(4)} ${s.currency}`);
    }
  }
  if (s.budget_used_ratio !== null && s.budget_kwh !== null) {
    parts.push(`${Math.round(s.budget_used_ratio * 100)}% of ${s.budget_kwh} kWh budget`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export const WattRpc = Rpc.define({
  id: "watt",
  methods: {
    snapshot: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          watts: { type: ["number", "null"], description: "Live power draw summed across meters" },
          day_kwh: { type: ["number", "null"], description: "Energy attributed today" },
          day_cost: { type: ["number", "null"], description: "Cost today at the active rate" },
          currency: { type: ["string", "null"], description: "Currency of the active rate" },
          budget_kwh: { type: ["number", "null"], description: "Configured daily budget" },
          budget_used_ratio: {
            type: ["number", "null"],
            description: "Fraction of the daily budget used",
          },
        },
        required: ["watts", "day_kwh", "day_cost", "currency", "budget_kwh", "budget_used_ratio"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
