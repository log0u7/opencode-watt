import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { normalizeConfig, type WattConfig } from "./config.js";
import { createEngine } from "./engine.js";
import type { Probe } from "./probes.js";
import { statePath } from "./store.js";
import {
  FORMAT_DESCRIPTION,
  SCOPE_DESCRIPTION,
  TOOL_DESCRIPTION,
  TOOL_FORMATS,
  TOOL_SCOPES,
} from "./tool-meta.js";

export type WattPluginOptions = WattConfig & {
  state_path?: string;
  probes?: Probe[];
};

export const WattPlugin: Plugin = async (input, rawOptions) => {
  const options = (rawOptions ?? {}) as Partial<WattPluginOptions>;
  const cfg: WattConfig = normalizeConfig(options);
  const stateFile = options?.state_path ?? statePath();
  const engine = createEngine(
    cfg,
    {
      log: async (level, message) => {
        try {
          await input.client.app.log({ body: { service: "opencode-watt", level, message } });
        } catch {
          // logging is best-effort
        }
      },
      notify: async (message) => {
        await input.client.tui.showToast({
          body: { title: "power_cost", message, variant: "info" },
        });
      },
    },
    stateFile,
    options?.probes,
  );

  const hooks: Hooks = {
    tool: {
      power_cost: tool({
        description: TOOL_DESCRIPTION,
        args: {
          scope: tool.schema
            .enum([...TOOL_SCOPES])
            .optional()
            .describe(SCOPE_DESCRIPTION),
          format: tool.schema
            .enum([...TOOL_FORMATS])
            .optional()
            .describe(FORMAT_DESCRIPTION),
        },
        execute: async (args, context) => {
          const scope = args.scope ?? "session";
          return args.format === "json"
            ? JSON.stringify(await engine.reportData(scope, context.sessionID), null, 2)
            : engine.report(scope, context.sessionID);
        },
      }),
    },
    event: async ({ event }) => {
      try {
        if (event.type === "session.status") {
          const { sessionID, status } = event.properties;
          engine.handleStatus(sessionID, status.type);
        } else if (event.type === "session.idle") {
          await engine.handleIdle(event.properties.sessionID);
        } else if (event.type === "session.deleted") {
          engine.forget(event.properties.info.id);
        }
      } catch (error) {
        try {
          await input.client.app.log({
            body: {
              service: "opencode-watt",
              level: "warn",
              message: `event handling failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          });
        } catch {
          // logging is best-effort
        }
      }
    },
    "chat.message": async (msg) => {
      if (msg.model) {
        engine.setModel(msg.sessionID, `${msg.model.providerID}/${msg.model.modelID}`);
      }
    },
    dispose: engine.dispose,
  };

  return hooks;
};
