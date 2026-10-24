// Core "Signal" components. Tokens come from styles.css; no raw colors here.
import * as RTooltip from "@radix-ui/react-tooltip";
import clsx from "clsx";
import { LoaderCircle } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

export const cn = clsx;

// ---- Button ----

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 active:brightness-95 shadow-1",
  secondary: "bg-raised text-fg border border-line hover:border-line-strong hover:bg-sunken",
  ghost: "text-muted hover:text-fg hover:bg-sunken",
  danger: "bg-danger text-white hover:brightness-110",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-md",
  md: "h-10 px-4 text-sm gap-2 rounded-md",
  lg: "h-12 px-6 text-[15px] gap-2 rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center font-medium select-none whitespace-nowrap",
        "transition-[background,filter,border-color,color] duration-(--dur-fast) ease-signal",
        "disabled:opacity-50 disabled:pointer-events-none",
        variants[variant], sizes[size], className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ---- IconButton (always has an accessible label + tooltip) ----

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: "sm" | "md";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, size = "md", className, children, ...rest },
  ref,
) {
  return (
    <Tooltip content={label}>
      <button
        ref={ref}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "inline-flex items-center justify-center rounded-md text-muted",
          "hover:text-fg hover:bg-sunken transition-colors duration-(--dur-fast)",
          "disabled:opacity-40 disabled:pointer-events-none",
          active && "text-accent bg-accent-soft hover:text-accent",
          size === "sm" ? "size-7 [&_svg]:size-4" : "size-9 [&_svg]:size-[18px]",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});

// ---- Input ----

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { leading?: ReactNode }>(
  function Input({ className, leading, ...rest }, ref) {
    return (
      <label className={cn(
        "flex items-center gap-2 h-10 px-3 rounded-md bg-sunken border border-transparent text-sm",
        "focus-within:border-accent-line focus-within:bg-surface transition-colors duration-(--dur-fast)",
        className,
      )}>
        {leading && <span className="text-faint [&_svg]:size-4">{leading}</span>}
        <input ref={ref} className="flex-1 min-w-0 bg-transparent outline-none placeholder:text-faint" {...rest} />
      </label>
    );
  },
);

// ---- Badge ----

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
const tones: Record<Tone, string> = {
  neutral: "bg-sunken text-muted",
  accent: "bg-accent-soft text-accent",
  success: "bg-success/12 text-success",
  warning: "bg-warning/14 text-warning",
  danger: "bg-danger/12 text-danger",
  info: "bg-info/12 text-info",
};

export function Badge({ tone = "neutral", icon, children, className }: {
  tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 h-5 px-1.5 rounded-sm text-[11px] font-semibold tracking-wide [&_svg]:size-3",
      tones[tone], className,
    )}>
      {icon}
      {children}
    </span>
  );
}

// ---- Status dot ----

export function StatusDot({ status, className }: { status: "online" | "idle" | "offline"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 rounded-full",
        status === "online" && "bg-success",
        status === "idle" && "bg-warning",
        status === "offline" && "bg-faint",
        className,
      )}
    />
  );
}

// ---- Kbd ----

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded-sm border border-line bg-sunken font-mono text-[11px] text-muted">
      {children}
    </kbd>
  );
}

// ---- Empty state ----

export function EmptyState({ icon, title, children, action }: {
  icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 p-8 max-w-sm mx-auto">
      <div className="size-14 rounded-xl grid place-items-center bg-accent-soft text-accent [&_svg]:size-7">{icon}</div>
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <p className="text-sm text-muted leading-relaxed">{children}</p>}
      {action}
    </div>
  );
}

// ---- Segmented control (radio group) ----

export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-0.5 rounded-md bg-sunken border border-line">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-3 rounded-[7px] text-[13px] font-medium [&_svg]:size-3.5",
            "transition-colors duration-(--dur-fast)",
            value === o.value ? "bg-raised text-fg shadow-1" : "text-muted hover:text-fg",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- Tooltip ----

export function Tooltip({ content, children, side = "top" }: {
  content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <RTooltip.Root delayDuration={400}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 px-2 py-1 rounded-sm bg-fg text-bg text-xs font-medium shadow-2 animate-enter"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export const TooltipProvider = RTooltip.Provider;
