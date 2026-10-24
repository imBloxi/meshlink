import { cn } from "@ui/primitives";
import { CircleAlert, CircleCheck, Info, ShieldAlert, X } from "lucide-react";
import { useApp } from "../lib/store";

const icons = {
  info: <Info className="text-info" />,
  success: <CircleCheck className="text-success" />,
  warning: <ShieldAlert className="text-warning" />,
  error: <CircleAlert className="text-danger" />,
};

export function Toaster() {
  const { toasts, dismissToast } = useApp();
  return (
    <div aria-live="polite" className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[360px] max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.level === "error" || t.level === "warning" ? "alert" : "status"}
          className={cn(
            "flex gap-3 p-3.5 rounded-lg bg-raised border border-line shadow-3 animate-enter [&_svg]:size-[18px]",
            t.level === "warning" && "border-warning/40",
            t.level === "error" && "border-danger/40",
          )}
        >
          <span className="mt-0.5 shrink-0">{icons[t.level]}</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{t.title}</p>
            {t.body && <p className="text-[13px] text-muted mt-0.5 line-clamp-3 break-words">{t.body}</p>}
            {t.action && (
              <button
                className="mt-1.5 text-[13px] font-medium text-accent hover:underline"
                onClick={() => { t.action!.run(); dismissToast(t.id); }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="self-start text-faint hover:text-fg [&_svg]:size-4">
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}
