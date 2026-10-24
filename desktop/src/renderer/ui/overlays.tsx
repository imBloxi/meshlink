// Dialog and Switch, built on Radix for focus management and keyboard support.
import * as RDialog from "@radix-ui/react-dialog";
import * as RSwitch from "@radix-ui/react-switch";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./primitives";

export function Dialog({ open, onOpenChange, title, description, children, size = "md", footer }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  size?: "md" | "lg" | "xl";
  footer?: ReactNode;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] animate-enter" />
        <RDialog.Content
          className={cn(
            "fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-2rem)]",
            "max-h-[calc(100vh-4rem)] flex flex-col rounded-xl bg-surface border border-line shadow-3 animate-enter",
            size === "md" && "max-w-md",
            size === "lg" && "max-w-2xl",
            size === "xl" && "max-w-4xl h-[min(640px,calc(100vh-4rem))]",
          )}
        >
          <header className="flex items-start gap-4 px-6 pt-5 pb-3">
            <div className="flex-1">
              <RDialog.Title className="text-lg font-semibold">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="text-sm text-muted mt-1">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{title}</RDialog.Description>
              )}
            </div>
            <RDialog.Close aria-label="Close" className="size-8 -mr-2 grid place-items-center rounded-md text-muted hover:text-fg hover:bg-sunken">
              <X className="size-4" />
            </RDialog.Close>
          </header>
          <div className="flex-1 min-h-0 overflow-auto px-6 pb-5">{children}</div>
          {footer && <footer className="flex justify-end gap-2 px-6 py-4 border-t border-line">{footer}</footer>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Switch({ checked, onCheckedChange, label, id }: {
  checked: boolean; onCheckedChange: (v: boolean) => void; label: string; id?: string;
}) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 rounded-full border border-line transition-colors duration-(--dur-base)",
        "bg-sunken data-[state=checked]:bg-accent data-[state=checked]:border-transparent",
      )}
    >
      <RSwitch.Thumb
        className={cn(
          "block size-[18px] rounded-full bg-white shadow-1 translate-x-[2px] mt-[2px]",
          "transition-transform duration-(--dur-base) ease-signal data-[state=checked]:translate-x-[18px]",
        )}
      />
    </RSwitch.Root>
  );
}
