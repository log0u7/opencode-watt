import { WattPlugin } from "./plugin.js";

const pluginModule = {
  id: "@log0u7/opencode-watt",
  server: WattPlugin,
} satisfies { id: string; server: typeof WattPlugin };

export default pluginModule;
