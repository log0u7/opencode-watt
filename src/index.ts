import { WattV2 } from "./plugin-v2.js";

type V1Plugin = typeof import("./plugin.js").WattPlugin;

/**
 * Dual entrypoint: v1 hosts call `server()`, v2 hosts call `setup()`
 * (see https://opencode.ai/v2/docs/build/plugins/migrate-v1).
 *
 * The v1 implementation imports `@opencode-ai/plugin`, which only v1 hosts
 * resolve. It must stay out of the static import graph or v2 hosts reject the
 * whole package at load time, so `server()` loads it lazily; a v2 host never
 * calls `server()` and therefore never resolves it.
 */
export const pluginModule = {
  ...WattV2,
  async server(...args: Parameters<V1Plugin>): Promise<Awaited<ReturnType<V1Plugin>>> {
    const { WattPlugin } = await import("./plugin.js");
    return WattPlugin(...args);
  },
} satisfies { id: string; server: V1Plugin; setup: (typeof WattV2)["setup"] };

export default pluginModule;
