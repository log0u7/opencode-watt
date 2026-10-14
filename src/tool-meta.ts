// Single source of truth for the power_cost tool surface, consumed by both the
// v1 (zod) and v2 (JSON Schema) plugin entrypoints so they cannot drift apart.

export const TOOL_DESCRIPTION =
  "Report electric power and cost of local LLM inference measured by opencode-watt (watts now, kWh and money per session/day/all, idle baseline, probe statuses; scope/format args, json available). Warns once per day when the configured daily budget is exceeded.";

export const TOOL_SCOPES = ["session", "today", "all"] as const;
export const TOOL_FORMATS = ["text", "json"] as const;

export type Scope = (typeof TOOL_SCOPES)[number];
export type Format = (typeof TOOL_FORMATS)[number];

export const SCOPE_DESCRIPTION =
  "Report scope: current session (default), today, or all recorded days";

export const FORMAT_DESCRIPTION = "Output format: human-readable text (default) or JSON";
