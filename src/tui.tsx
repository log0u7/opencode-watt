/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { Show, createSignal } from "solid-js";

type Context = Plugin.Context;
type Theme = Context["theme"];

import { WattRpc, budgetBar, formatSnapshot, type WattSnapshot } from "./rpc.js";

const REFRESH_MS = 10_000;
/** quota-style event refresh: debounced immediate refresh after activity. */
const EVENT_DEBOUNCE_MS = 150;

function themedFooter(theme: Theme, label: () => string | null): JSX.Element {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.text.base} wrapMode="none">
        <b>Watt</b>
      </text>
      <Show when={label()} keyed>
        {(text) => (
          <text fg={theme.text.muted} wrapMode="none">
            {text}
          </text>
        )}
      </Show>
    </box>
  );
}

function dialogBody(theme: Theme, snapshot: WattSnapshot): JSX.Element {
  const budget = budgetBar(snapshot.budget_used_ratio, 20);
  return (
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={theme.text.base}>
        <b>Watt — inference power</b>
      </text>
      <text fg={theme.text.muted}>
        Live power: {snapshot.watts === null ? "no meter" : `${Math.round(snapshot.watts)} W`}
      </text>
      <text fg={theme.text.muted}>
        Energy today: {snapshot.day_kwh === null ? "— kWh" : `${snapshot.day_kwh.toFixed(3)} kWh`}
      </text>
      <text fg={theme.text.muted}>
        Cost today:{" "}
        {snapshot.day_cost === null || !snapshot.currency
          ? "—"
          : (formatSnapshot(snapshot)?.split(" · ")[2] ?? "—")}
      </text>
      <Show when={budget} keyed>
        {(bar) => (
          <text fg={theme.text.muted}>
            Budget: {bar} of {snapshot.budget_kwh} kWh
          </text>
        )}
      </Show>
    </box>
  );
}

export default Plugin.define({
  id: "@log0u7/opencode-watt.tui",
  setup(context: Context) {
    const theme = context.theme;
    const [label, setLabel] = createSignal<string | null>(null);
    const [snapshot, setSnapshot] = createSignal<WattSnapshot | null>(null);

    const watt = context.client.rpc(WattRpc);
    const refresh = async () => {
      try {
        const next = (await watt.snapshot({})) as WattSnapshot;
        setSnapshot(next);
        setLabel(formatSnapshot(next));
      } catch {
        // server unreachable or v1 host: hide the footer, keep the last dialog data
        setLabel(null);
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    // Debounced event-driven refresh: a busy/complete session changes power draw.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), EVENT_DEBOUNCE_MS);
    };
    // context.client.event is an AsyncIterable of V2Event, not an EventEmitter.
    const events = context.client.event.subscribe();
    void (async () => {
      try {
        for await (const _event of events) {
          schedule();
        }
      } catch {
        // stream ended or errored: polling fallback stays active.
      }
    })();

    const unregister = context.ui.slot({
      append: "home.footer.status",
      render: () => themedFooter(theme, label),
    });

    // Keymap layers are disposed with the plugin; no manual disposer here.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "watt.status",
          title: "Watt status",
          group: "Watt",
          slash: { name: "watt" },
          palette: true,
          run: async () => {
            await refresh();
            const current = snapshot();
            if (!current) {
              context.ui.toast.show({
                title: "Watt",
                message: "No meter reporting",
                variant: "info",
              });
              return;
            }
            context.ui.dialog.show(() => dialogBody(theme, current));
            context.ui.dialog.set({ size: "medium" });
          },
        },
      ],
    }));

    return () => {
      clearTimeout(debounce);
      clearInterval(timer);
      unregister();
    };
  },
});
