import { Plugin } from "@opencode/plugin";

import { normalizeConfig } from "./config.js";
import { createEngine, kwh, WH_TO_J } from "./engine.js";
import type { WattPluginOptions } from "./plugin.js";
import { statePath } from "./store.js";

export const WattV2 = Plugin.define({
  id: "@log0u7/opencode-watt",
  async setup(ctx) {
    const options = ctx.options as Partial<WattPluginOptions>;
    const cfg = normalizeConfig(options);
    const stateFile = options?.state_path ?? statePath();
    const controller = new AbortController();
    const engine = createEngine(
      cfg,
      {
        log: async (level, message) => {
          console[level === "info" ? "info" : level](`[opencode-watt] ${message}`);
        },
        notify: async (message) => {
          // No server-to-TUI toast channel in the v2 plugin context; surface through the log.
          console.info(`[opencode-watt] ${message}`);
        },
      },
      stateFile,
      options?.probes,
    );

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "power_cost",
        description:
          "Report electric power and cost of local LLM inference measured by opencode-watt (watts now, kWh and money per session/day/all).",
        input: {
          type: "object",
          properties: {
            scope: {
              type: "string",
              enum: ["session", "today", "all"],
              description: "Report scope: current session (default), today, or all recorded days",
            },
          },
          additionalProperties: false,
        },
        async execute(input, context) {
          const scope = (input as { scope?: "session" | "today" | "all" }).scope;
          return { content: await engine.report(scope ?? "session", context.sessionID) };
        },
      });
    });

    await ctx.session.hook("model.request", (event) => {
      engine.setModel(event.sessionID, `${event.model.providerID}/${event.model.id}`);
    });

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.status") {
          engine.handleStatus(event.data.sessionID, event.data.status.type);
        } else if (event.type === "session.idle") {
          await engine.handleIdle(event.data.sessionID);
        } else if (event.type === "session.deleted") {
          engine.forget(event.data.sessionID);
        }
      }
    })().catch(() => {
      // subscription ends on cleanup; failures are best-effort
    });

    const cleanup = async () => {
      controller.abort();
      await engine.dispose();
    };
    return cleanup;
  },
});

export { kwh, WH_TO_J };
