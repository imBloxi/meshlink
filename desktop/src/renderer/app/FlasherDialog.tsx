// Flasher wizard: intro -> pick port -> flash (progress) -> done / error.
import { Dialog } from "@ui/overlays";
import { Badge, Button, cn } from "@ui/primitives";
import { Cable, CircleAlert, CircleCheck, Cpu, HardDriveDownload, MousePointerClick, RotateCcw, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flashFirmware, type FlashPhase } from "../lib/flasher";
import { requestPortByName, usbBridgeName, WebSerialLink } from "../lib/links";
import { useApp } from "../lib/store";
import { PortList, useSerialPicker } from "./PortPicker";

type Step =
  | { name: "intro" }
  | { name: "flashing"; phase: FlashPhase; chip?: string; progress: number }
  | { name: "done"; chip: string; port: SerialPort }
  | { name: "error"; message: string };

const phaseText: Record<FlashPhase, string> = {
  connecting: "Connecting to the board…",
  writing: "Writing firmware…",
  resetting: "Restarting the board…",
};

export function FlasherDialog() {
  const { panels, setPanel, firmware, conn, disconnect, connect, toast, usbDevices } = useApp();
  const usable = usbDevices.filter((d) => d.com && !d.driverMissing);
  const target = usable.length === 1 ? usable[0] : null;
  const open = panels.flasher;
  const [step, setStep] = useState<Step>({ name: "intro" });
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const busy = step.name === "flashing";
  const { ports, cancel, choose } = useSerialPicker(open);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (open) {
      setStep({ name: "intro" });
      setLog([]);
    }
  }, [open]);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  if (!firmware) return null;
  const { manifest, data } = firmware;

  const start = async () => {
    let port: SerialPort;
    try {
      // The chat link holds the port open; release it before asking for it again.
      if (conn.kind === "usb") await disconnect();
      port = target ? await requestPortByName(target.com!) : await navigator.serial.requestPort();
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") return; // cancelled
      setStep({ name: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    setLog([]);
    setStep({ name: "flashing", phase: "connecting", progress: 0 });
    try {
      const chip = await flashFirmware(port, data, manifest.offset, {
        onPhase: (phase, detail) => setStep((s) => ({
          name: "flashing", phase, progress: s.name === "flashing" ? s.progress : 0,
          chip: detail ?? (s.name === "flashing" ? s.chip : undefined),
        })),
        onProgress: (f) => setStep((s) => (s.name === "flashing" ? { ...s, progress: f } : s)),
        onLog: (line) => setLog((l) => [...l.slice(-300), line]),
      });
      setStep({ name: "done", chip, port });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStep({ name: "error", message: msg });
    }
  };

  const connectNow = async (port: SerialPort) => {
    setPanel("flasher", false);
    await connect(new WebSerialLink(port, usbBridgeName(port.getInfo().usbVendorId) ?? "USB serial"));
    toast({ level: "success", title: "Node ready", body: `Running MeshLink firmware v${manifest.version}.` });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return; // Never interrupt a flash half-way.
        if (!o) cancel();
        setPanel("flasher", o);
      }}
      title={ports ? "Choose the board" : "Flash MeshLink firmware"}
      description={ports ? "Pick the COM port of the ESP8266 to flash." : undefined}
      size="lg"
    >
      {ports ? (
        <PortList ports={ports} onChoose={choose} onBack={cancel} />
      ) : step.name === "intro" ? (
        <div className="space-y-5">
          <div className="flex items-center gap-4 p-4 rounded-lg bg-sunken">
            <span className="size-12 grid place-items-center rounded-lg bg-accent text-accent-fg"><HardDriveDownload className="size-6" /></span>
            <div className="flex-1 min-w-0">
              <p className="font-medium flex items-center gap-2">
                {manifest.name} <Badge tone="accent">v{manifest.version}</Badge>
              </p>
              <p className="text-xs text-muted mt-0.5">
                {manifest.chip} · {(manifest.size / 1024).toFixed(0)} KB · built {new Date(manifest.builtAt).toLocaleDateString()}
              </p>
              <p className="text-[11px] text-faint font-mono mt-0.5 truncate">sha256 {manifest.sha256.slice(0, 16)}…</p>
            </div>
          </div>
          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <Cable className="size-4 mt-0.5 text-accent shrink-0" />
              <span>Plug the ESP8266 in with a <strong>data</strong> USB cable. Charge-only cables show no port.</span>
            </li>
            <li className="flex gap-3">
              <Cpu className="size-4 mt-0.5 text-accent shrink-0" />
              <span>No port listed? Install the board&apos;s USB driver: CH340 (most clones) or CP210x.</span>
            </li>
            <li className="flex gap-3">
              <MousePointerClick className="size-4 mt-0.5 text-accent shrink-0" />
              <span>If connecting fails, hold the <strong>FLASH</strong> (or BOOT) button while you start.</span>
            </li>
          </ol>
          <div className={cn("flex items-center gap-3 p-3 rounded-lg border text-sm", target ? "border-accent-line bg-accent-soft" : "border-line")}>
            <Cpu className={cn("size-4", target ? "text-accent" : "text-faint")} />
            <span className="flex-1">
              {target
                ? <>Detected <strong>{target.bridge}</strong> board on <strong>{target.com}</strong></>
                : usable.length > 1
                  ? `${usable.length} boards detected: you will pick one.`
                  : "No board detected yet. Plug one in, or pick a port manually."}
            </span>
          </div>
          <p className="text-xs text-muted">Flashing replaces whatever the board runs now. Your chats and keys on this PC are not touched.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPanel("flasher", false)}>Cancel</Button>
            <Button variant="primary" icon={<Zap className="size-4" />} onClick={start}>
              {target ? `Flash ${target.com}` : "Choose board and flash"}
            </Button>
          </div>
        </div>
      ) : step.name === "flashing" ? (
        <div className="space-y-5 py-2" aria-live="polite">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{phaseText[step.phase]}</span>
            <span className="font-mono text-muted">{Math.round(step.progress * 100)}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(step.progress * 100)}
            aria-label="Flash progress"
            className="h-2.5 rounded-full bg-sunken overflow-hidden"
          >
            <div
              className={cn("h-full bg-accent rounded-full transition-[width] duration-(--dur-base)", step.phase === "connecting" && "animate-pulse")}
              style={{ width: `${step.phase === "connecting" ? 8 : Math.max(2, step.progress * 100)}%` }}
            />
          </div>
          {step.chip && <p className="text-xs text-muted">Detected {step.chip}</p>}
          <p className="text-xs text-warning">Keep the board plugged in until this finishes.</p>
          <LogView log={log} show={showLog} setShow={setShowLog} logRef={logRef} />
        </div>
      ) : step.name === "done" ? (
        <div className="flex flex-col items-center text-center gap-4 py-6">
          <span className="size-14 grid place-items-center rounded-full bg-success/15 text-success"><CircleCheck className="size-8" /></span>
          <div>
            <p className="text-lg font-semibold">Board flashed</p>
            <p className="text-sm text-muted mt-1">{step.chip} now runs MeshLink firmware v{manifest.version}.</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setStep({ name: "intro" })} icon={<RotateCcw className="size-4" />}>Flash another</Button>
            <Button variant="primary" onClick={() => connectNow(step.port)}>Connect to this node</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 py-2">
          <div role="alert" className="flex gap-3 p-4 rounded-lg bg-danger/8 border border-danger/30">
            <CircleAlert className="size-5 text-danger shrink-0" />
            <div className="text-sm">
              <p className="font-medium">Flashing failed</p>
              <p className="text-muted mt-1 break-words">{step.message}</p>
              <p className="text-muted mt-2">Try again while holding the FLASH button, use another USB cable, or close other apps using the port (Arduino IDE, serial monitors).</p>
            </div>
          </div>
          <LogView log={log} show={showLog} setShow={setShowLog} logRef={logRef} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPanel("flasher", false)}>Close</Button>
            <Button variant="primary" icon={<RotateCcw className="size-4" />} onClick={start}>Try again</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function LogView({ log, show, setShow, logRef }: {
  log: string[]; show: boolean; setShow: (v: boolean) => void; logRef: React.RefObject<HTMLPreElement | null>;
}) {
  if (!log.length) return null;
  return (
    <div>
      <button className="text-xs text-muted hover:text-fg underline-offset-2 hover:underline" onClick={() => setShow(!show)}>
        {show ? "Hide details" : "Show details"}
      </button>
      {show && (
        <pre ref={logRef} className="mt-2 h-40 overflow-auto rounded-md bg-sunken p-3 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
          {log.join("\n")}
        </pre>
      )}
    </div>
  );
}
