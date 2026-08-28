/**
 * Herdr event subscription over the raw socket.
 *
 * There is no `herdr api events` CLI - `herdr api` only exposes `snapshot` and
 * `schema` - so live status must come from the socket directly. That is the
 * documented purpose of the raw layer: "Use the raw socket API only when you
 * need direct request/response control or long-lived event subscriptions."
 *
 * Protocol: newline-delimited JSON. Send one `events.subscribe` request, then
 * read pushed `{"event": "...", "data": {...}}` frames until the socket
 * closes. Verified against herdr 0.8.2.
 *
 * `pane.agent_status_changed` requires a concrete `pane_id`, so each subagent
 * needs its own subscription. Rather than juggle one long-lived multiplexed
 * connection, this opens a short-lived watcher per subagent and closes it when
 * that agent reaches a terminal state. Subagent counts are small, and a
 * per-pane socket means one failed watcher cannot blind the others.
 */

import { connect, type Socket } from "node:net";

export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

export function socketPath(): string {
  return (
    process.env.HERDR_SOCKET_PATH ||
    `${process.env.HOME}/.config/herdr/herdr.sock`
  );
}

/**
 * Watch one pane's agent status until `onEvent` returns true (done) or
 * `stop()` is called.
 *
 * Errors are surfaced through `onError` rather than thrown: a subscription
 * dropping should degrade the widget, not take down the parent session.
 */
export function watchPane(
  paneId: string,
  onEvent: (e: HerdrEvent) => boolean | void,
  onError?: (err: Error) => void,
): { stop: () => void } {
  let sock: Socket | undefined;
  let stopped = false;
  let buf = "";

  const stop = () => {
    stopped = true;
    try {
      sock?.destroy();
    } catch {
      /* already gone */
    }
    sock = undefined;
  };

  try {
    sock = connect(socketPath());
  } catch (err) {
    onError?.(err as Error);
    return { stop };
  }

  sock.on("error", (err) => {
    if (!stopped) onError?.(err);
    stop();
  });

  sock.on("connect", () => {
    const req = {
      id: `sub-${paneId}`,
      method: "events.subscribe",
      params: {
        subscriptions: [
          { type: "pane.agent_status_changed", pane_id: paneId },
          { type: "pane.exited" },
          { type: "pane.closed" },
        ],
      },
    };
    sock?.write(`${JSON.stringify(req)}\n`);
  });

  sock.on("data", (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;

      let parsed: { event?: string; data?: Record<string, unknown>; error?: { message?: string } };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.error) {
        onError?.(new Error(parsed.error.message ?? "subscription error"));
        stop();
        return;
      }
      if (!parsed.event) continue; // the subscription_started ack

      const done = onEvent({ event: parsed.event, data: parsed.data ?? {} });
      if (done) {
        stop();
        return;
      }
    }
  });

  sock.on("close", () => {
    sock = undefined;
  });

  return { stop };
}
