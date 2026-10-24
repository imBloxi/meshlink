// Settings-style layout pieces shared by Settings, Admin, Networks and Account.
import { Check, Copy } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Switch } from "./overlays";
import { cn, Tooltip } from "./primitives";

export function Row({ title, text, children }: { title: string; text?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 py-4 border-b border-line last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {text && <p className="text-[13px] text-muted mt-0.5 leading-relaxed">{text}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SwitchRow({ title, text, checked, onChange, disabled }: {
  title: string; text?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  const id = useId();
  return (
    <Row title={title} text={text}>
      <span className={cn(disabled && "opacity-50 pointer-events-none")}>
        <Switch id={id} label={title} checked={checked} onCheckedChange={onChange} />
      </span>
    </Row>
  );
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</h3>
        {action}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <div id={id}>{children}</div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** A code (invite, network key) with a copy button. Monospace, wraps. */
export function CopyCode({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-sunken">
      <code className="flex-1 min-w-0 font-mono text-[12px] leading-relaxed break-all select-all">{value}</code>
      <Tooltip content={copied ? "Copied" : label}>
        <button onClick={copy} aria-label={label} className="size-8 shrink-0 grid place-items-center rounded-md text-muted hover:text-fg hover:bg-surface">
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </button>
      </Tooltip>
    </div>
  );
}

/** QR code image (generated locally, never fetched). */
export function Qr({ value, size = 200, label }: { value: string; size?: number; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, { margin: 1, width: size * 2, errorCorrectionLevel: "M", color: { dark: "#0B0F14", light: "#FFFFFF" } })
      .then((url) => live && setSrc(url))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [value, size]);
  return (
    <div className="inline-block p-2 rounded-lg bg-white shadow-1" style={{ width: size + 16, height: size + 16 }}>
      {src && <img src={src} width={size} height={size} alt={label} />}
    </div>
  );
}
