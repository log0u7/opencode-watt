/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import { Show, createSignal } from "solid-js";
import { WattRpc, formatSnapshot, type WattSnapshot } from "./rpc.js";

const REFRESH_MS = 10_000;

export default Plugin.define({
  id: "@log0u7/opencode-watt.tui",
  setup(context) {
    context.ui.toast.show({ message: "opencode-watt loaded", variant: "info", duration: 2000 });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "watt.status",
          title: "Power status",
          group: "Watt",
          slash: { name: "watt" },
          palette: true,
          run: async () => {
            context.ui.toast.show({
              title: "Watt",
              message: "Power monitoring available",
              variant: "info",
            });
          },
        },
      ],
    }));

    // Live footer: poll the server-side snapshot over RPC. On a v1 host (no RPC)
    // or while the server is unreachable, the slot stays hidden.
    const [label, setLabel] = createSignal<string | null>(null);
    const watt = context.client.rpc(WattRpc);
    const refresh = async () => {
      try {
        setLabel(formatSnapshot((await watt.snapshot({})) as WattSnapshot));
      } catch {
        setLabel(null);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    const unregister = context.ui.slot({
      append: "home.footer.status",
      render: () => (
        <Show when={label()} keyed>
          {(text) => <text>{text}</text>}
        </Show>
      ),
    });

    return () => {
      clearInterval(timer);
      unregister();
    };
  },
});
