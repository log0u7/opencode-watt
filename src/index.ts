import { WattV2 } from "./plugin-v2.js";
import { WattPlugin } from "./plugin.js";

/**
 * Dual entrypoint: v1 hosts call `server()`, v2 hosts call `setup()`
 * (see https://opencode.ai/v2/docs/build/plugins/migrate-v1).
 */
export const pluginModule = {
  ...WattV2,
  server: WattPlugin,
} satisfies { id: string; server: typeof WattPlugin; setup: (typeof WattV2)["setup"] };

export default pluginModule;
