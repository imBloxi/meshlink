// In Electron, navigator.serial.requestPort() makes the main process send us
// the port list; the user picks here and we answer with chooseSerialPort().
import type { SerialPortChoice } from "@shared/api";
import { Badge, Button, cn } from "@ui/primitives";
import { ChevronRight, Cpu } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { usbBridgeName } from "../lib/links";
import { api } from "../lib/platform";

/** Listen for port lists only while `active`, so two dialogs never both answer. */
export function useSerialPicker(active: boolean) {
  const [ports, setPorts] = useState<SerialPortChoice[] | null>(null);
  useEffect(() => (active ? api.onSerialPorts(setPorts) : undefined), [active]);
  const cancel = () => {
    if (ports) api.chooseSerialPort("");
    setPorts(null);
  };
  const choose = (id: string) => {
    api.chooseSerialPort(id);
    setPorts(null);
  };
  return { ports, cancel, choose };
}

export function ChoiceCard({ icon, title, text, onClick, disabled, badge }: {
  icon: ReactNode; title: string; text: string; onClick: () => void; disabled?: boolean; badge?: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full flex items-center gap-4 p-4 rounded-lg border border-line bg-raised text-left",
        "hover:border-accent-line hover:bg-accent-soft/40 transition-colors duration-(--dur-fast)",
        "disabled:opacity-50 disabled:pointer-events-none",
      )}
    >
      <span className="size-10 shrink-0 grid place-items-center rounded-lg bg-accent-soft text-accent [&_svg]:size-5">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2 font-medium">{title}{badge}</span>
        <span className="block text-sm text-muted">{text}</span>
      </span>
      <ChevronRight className="size-4 text-faint" />
    </button>
  );
}

export function PortList({ ports, onChoose, onBack }: {
  ports: SerialPortChoice[]; onChoose: (id: string) => void; onBack: () => void;
}) {
  return (
    <div className="space-y-2">
      {ports.length === 0 && (
        <p className="text-sm text-muted py-4">
          No serial ports found. Plug in the board with a data USB cable and check its driver (CH340 or CP210x).
        </p>
      )}
      {ports.map((p) => {
        const bridge = usbBridgeName(p.vendorId);
        return (
          <ChoiceCard
            key={p.portId}
            icon={<Cpu />}
            title={p.portName}
            text={p.displayName ?? "Serial device"}
            badge={bridge ? <Badge tone="accent">{bridge}</Badge> : undefined}
            onClick={() => onChoose(p.portId)}
          />
        );
      })}
      <div className="pt-2 flex justify-end">
        <Button variant="ghost" onClick={onBack}>Back</Button>
      </div>
    </div>
  );
}
