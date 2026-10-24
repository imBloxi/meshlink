// MeshLink-specific identity patterns: Identicon, FingerprintDisplay, TrustBadge.
import { Check, Copy, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, cn, Tooltip } from "./primitives";

/** Deterministic 5x5 mirrored pattern from a hex fingerprint. Same key, same picture. */
export function Identicon({ fp, size = 36, className }: { fp: string; size?: number; className?: string }) {
  const { cells, hue } = useMemo(() => {
    const bytes = fp.match(/../g)!.map((h) => parseInt(h, 16));
    const bits: boolean[] = [];
    for (let i = 0; i < 15; i++) bits.push(((bytes[(i >> 3) + 1] >> (i & 7)) & 1) === 1);
    const cells: [number, number][] = [];
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 3; x++) {
        if (bits[y * 3 + x]) {
          cells.push([x, y]);
          if (x < 2) cells.push([4 - x, y]);
        }
      }
    }
    return { cells, hue: Math.round((bytes[0] / 255) * 360) };
  }, [fp]);
  return (
    <svg
      viewBox="-1 -1 7 7"
      width={size}
      height={size}
      aria-hidden
      className={cn("shrink-0 rounded-[28%]", className)}
      style={{ background: `oklch(0.9 0.05 ${hue} / 0.18)` }}
    >
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={`oklch(0.68 0.16 ${hue})`} />
      ))}
    </svg>
  );
}

/** Fingerprint in 4-character groups, monospace, with copy. Used to verify keys in person. */
export function FingerprintDisplay({ fp, size = "md", copyable = true }: {
  fp: string; size?: "sm" | "md" | "lg"; copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const groups = fp.toUpperCase().match(/.{1,4}/g)!;
  const copy = async () => {
    await navigator.clipboard.writeText(groups.join(" "));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="inline-flex items-center gap-2">
      <code
        aria-label={`Key fingerprint ${groups.join(" ")}`}
        className={cn(
          "font-mono tracking-wider text-fg grid grid-cols-4 gap-x-2",
          size === "sm" && "text-[11px] text-muted",
          size === "md" && "text-[13px]",
          size === "lg" && "text-lg gap-x-3",
        )}
      >
        {groups.map((g, i) => <span key={i}>{g}</span>)}
      </code>
      {copyable && (
        <Tooltip content={copied ? "Copied" : "Copy key"}>
          <button
            onClick={copy}
            aria-label="Copy key fingerprint"
            className="size-7 grid place-items-center rounded-md text-muted hover:text-fg hover:bg-sunken"
          >
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          </button>
        </Tooltip>
      )}
    </div>
  );
}

export type Trust = "verified" | "unverified" | "warning";

/** Trust is shown with icon + text, never color alone. */
export function TrustBadge({ trust, compact }: { trust: Trust; compact?: boolean }) {
  const map = {
    verified: { tone: "accent" as const, icon: <ShieldCheck />, text: "Verified" },
    unverified: { tone: "neutral" as const, icon: <ShieldQuestion />, text: "Unverified" },
    warning: { tone: "danger" as const, icon: <ShieldAlert />, text: "Key warning" },
  }[trust];
  if (compact) {
    return (
      <Tooltip content={map.text}>
        <span
          role="img"
          aria-label={map.text}
          className={cn(
            "[&_svg]:size-3.5",
            trust === "verified" && "text-accent",
            trust === "unverified" && "text-faint",
            trust === "warning" && "text-danger",
          )}
        >
          {map.icon}
        </span>
      </Tooltip>
    );
  }
  return <Badge tone={map.tone} icon={map.icon}>{map.text}</Badge>;
}
