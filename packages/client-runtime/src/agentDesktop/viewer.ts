// @effect-diagnostics globalTimers:off - This browser and WebView transport runs without an Effect runtime.
/// <reference path="./novnc.d.ts" />
/**
 * Shows an agent desktop's VNC stream in a DOM element with noVNC, and keeps
 * the viewer's input switched off unless it took control. The stream also
 * carries JSON text frames saying who has control; they are taken out here
 * before noVNC sees the bytes.
 *
 * Framework-free, so the web app and the mobile app's WebView share it.
 *
 * @module agentDesktop/viewer
 */
import RFB from "@novnc/novnc";
import type { AgentDesktopStreamCommand, AgentDesktopStreamStatus } from "@t3tools/contracts";

import type { AgentDesktopControl } from "./control.ts";

export { type AgentDesktopControl, agentDesktopControlLabel } from "./control.ts";

/** connecting → live; `refused` means the stream never opened, usually an expired ticket. */
export type AgentDesktopViewerStatus = "connecting" | "live" | "refused" | "gone";

export interface AgentDesktopViewerOptions {
  readonly container: HTMLElement;
  /** The stream's WebSocket URL, with `desktopId`, `viewer` and any ticket. */
  readonly url: string;
  readonly interactive: boolean;
  readonly onControl?: (control: AgentDesktopControl) => void;
  readonly onStatus?: (status: AgentDesktopViewerStatus) => void;
}

/** Keys a phone's soft keyboard reports without a character. */
export type AgentDesktopSpecialKey = "Backspace" | "Enter" | "Tab" | "Escape";

export interface AgentDesktopViewer {
  readonly takeControl: () => void;
  readonly releaseControl: () => void;
  /** Types text as key presses, for soft keyboards; only while in control. */
  readonly typeText: (text: string) => void;
  readonly pressKey: (key: AgentDesktopSpecialKey) => void;
  readonly destroy: () => void;
}

const SPECIAL_KEYSYMS: Record<AgentDesktopSpecialKey, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
};

/** X11 keysyms: Latin-1 maps directly, other characters through the Unicode range. */
const keysymFor = (codePoint: number) =>
  codePoint >= 0x20 && codePoint <= 0xff ? codePoint : 0x01000000 + codePoint;

const RECONNECT_DELAY_MS = 1_000;
/** `AGENT_DESKTOP_GONE_CODE`; a type-only import keeps the contracts out of the mobile bundle. */
const GONE_CODE = 4404;

/**
 * A WebSocket-shaped channel for noVNC that hands it only the binary frames.
 * noVNC checks for these properties by name, so they are all declared here.
 */
class VncChannel {
  binaryType: BinaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { readonly data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly socket: WebSocket;

  constructor(socket: WebSocket, onStatus: (status: AgentDesktopStreamStatus) => void) {
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", (event) => this.onopen?.(event));
    socket.addEventListener("error", (event) => this.onerror?.(event));
    socket.addEventListener("close", (event) => this.onclose?.(event));
    socket.addEventListener("message", (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === "string") {
        try {
          const status = JSON.parse(event.data) as AgentDesktopStreamStatus;
          if (status.type === "control") onStatus(status);
        } catch {
          // Not a status frame; nothing else is sent as text.
        }
        return;
      }
      this.onmessage?.({ data: event.data });
    });
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: ArrayBufferLike | ArrayBufferView): void {
    this.socket.send(data as ArrayBuffer);
  }

  close(): void {
    this.socket.close();
  }
}

export function createAgentDesktopViewer(options: AgentDesktopViewerOptions): AgentDesktopViewer {
  let destroyed = false;
  let socket: WebSocket | null = null;
  let rfb: RFB | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let controller: AgentDesktopStreamStatus["state"] = "agent";

  const inControl = () => options.interactive && controller === "you";

  const send = (command: AgentDesktopStreamCommand) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
  };

  const applyControl = () => {
    if (rfb === null) return;
    rfb.viewOnly = !inControl();
    rfb.focusOnClick = inControl();
    // Host apps leave keys alone in text boxes; without this, an app that sends
    // stray typing to its own input (T3's composer) takes the desktop's keys.
    const canvas = options.container.querySelector("canvas");
    if (inControl()) {
      canvas?.setAttribute("role", "textbox");
      canvas?.setAttribute("aria-label", "Remote desktop");
      rfb.focus({ preventScroll: true });
    } else {
      canvas?.removeAttribute("role");
      canvas?.removeAttribute("aria-label");
      rfb.blur();
    }
  };

  // Pasting while in control types the text on the desktop's clipboard.
  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!inControl() || !text || rfb === null) return;
    event.preventDefault();
    rfb.clipboardPasteFrom(text);
  };
  options.container.addEventListener("paste", onPaste);

  const connect = () => {
    if (destroyed) return;
    options.onStatus?.("connecting");
    let opened = false;
    const current = new WebSocket(options.url);
    socket = current;
    current.addEventListener("open", () => {
      opened = true;
    });
    const channel = new VncChannel(current, (status) => {
      controller = status.state;
      applyControl();
      options.onControl?.({ canOperate: options.interactive, controller });
    });
    const client = new RFB(options.container, channel, { shared: true });
    rfb = client;
    client.scaleViewport = true;
    client.resizeSession = false;
    client.clipViewport = false;
    client.focusOnClick = false;
    client.showDotCursor = false;
    client.qualityLevel = 6;
    client.compressionLevel = 2;
    client.background = "transparent";
    client.viewOnly = true;
    client.addEventListener("connect", () => {
      options.onStatus?.("live");
      applyControl();
    });
    client.addEventListener("clipboard", (event) => {
      const text = (event as CustomEvent<{ readonly text: string }>).detail.text;
      if (inControl()) void navigator.clipboard?.writeText(text).catch(() => undefined);
    });
    current.addEventListener("close", (event) => {
      if (socket !== current || destroyed) return;
      rfb = null;
      socket = null;
      if (event.code === GONE_CODE) {
        options.onStatus?.("gone");
        return;
      }
      if (!opened) {
        options.onStatus?.("refused");
        return;
      }
      options.onStatus?.("connecting");
      reconnect = setTimeout(connect, RECONNECT_DELAY_MS);
    });
  };

  connect();

  const pressKeysym = (keysym: number) => {
    if (!inControl() || rfb === null) return;
    rfb.sendKey(keysym, null, true);
    rfb.sendKey(keysym, null, false);
  };

  return {
    takeControl: () => send({ type: "takeControl" }),
    releaseControl: () => send({ type: "releaseControl" }),
    typeText: (text) => {
      for (const character of text) {
        if (character === "\n") pressKeysym(SPECIAL_KEYSYMS.Enter);
        else pressKeysym(keysymFor(character.codePointAt(0)!));
      }
    },
    pressKey: (key) => pressKeysym(SPECIAL_KEYSYMS[key]),
    destroy: () => {
      destroyed = true;
      if (reconnect !== null) clearTimeout(reconnect);
      options.container.removeEventListener("paste", onPaste);
      const client = rfb;
      rfb = null;
      socket = null;
      client?.disconnect();
    },
  };
}
