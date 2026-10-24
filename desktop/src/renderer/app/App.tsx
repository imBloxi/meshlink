import { TooltipProvider } from "@ui/primitives";
import { useEffect } from "react";
import { useApp } from "../lib/store";
import { AccountDialog } from "./AccountDialog";
import { AdminDialog } from "./AdminDialog";
import { ConnectDialog } from "./ConnectDialog";
import { Conversation } from "./Conversation";
import { DetailsPanel } from "./DetailsPanel";
import { FlasherDialog } from "./FlasherDialog";
import { NetworksDialog } from "./NetworksDialog";
import { Onboarding } from "./Onboarding";
import { NewRoomDialog, RoomInviteDialog } from "./RoomDialogs";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { Toaster } from "./Toaster";

/** Applies appearance settings to <html> so tokens in styles.css switch. */
function useAppearance() {
  const { theme, accent, density, fontScale } = useApp((s) => s.settings);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    root.dataset.accent = accent;
    root.dataset.density = density;
    root.style.setProperty("--font-scale", String(fontScale));
  }, [theme, accent, density, fontScale]);
}

function useShortcuts() {
  const setPanel = useApp((s) => s.setPanel);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === ",") {
        e.preventDefault();
        setPanel("settings", true);
      } else if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.getElementById("contact-search")?.focus();
      } else if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setPanel("newRoom", true);
      } else if (e.key.toLowerCase() === "i") {
        e.preventDefault();
        setPanel("details", !useApp.getState().panels.details);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPanel]);
}

export function App() {
  const { ready, identity, init } = useApp();
  const detailsOpen = useApp((s) => s.panels.details && !!s.selected);
  useEffect(() => {
    init();
  }, [init]);
  useAppearance();
  useShortcuts();

  if (!ready) return <div className="h-screen bg-bg" />;

  return (
    <TooltipProvider>
      {!identity ? (
        <Onboarding />
      ) : (
        <div className="h-screen flex bg-bg text-fg">
          <Sidebar />
          <main className="flex-1 min-w-0 flex">
            <Conversation />
            {detailsOpen && <DetailsPanel />}
          </main>
          <ConnectDialog />
          <FlasherDialog />
          <SettingsDialog />
          <NewRoomDialog />
          <RoomInviteDialog />
          <AdminDialog />
          <NetworksDialog />
          <AccountDialog />
        </div>
      )}
      <Toaster />
    </TooltipProvider>
  );
}
