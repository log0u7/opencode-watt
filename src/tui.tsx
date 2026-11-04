/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";

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

    return context.ui.slot({
      append: "home.footer.status",
      render: () => null,
    });
  },
});
