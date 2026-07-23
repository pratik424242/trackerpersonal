import { Link } from "@tanstack/react-router";
import { BookOpen, Wallet, LineChart, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useTheme } from "./theme-provider";

const nav = [
  { to: "/", label: "Journal", icon: BookOpen },
  { to: "/accounts", label: "Accounts", icon: Wallet },
  { to: "/insights", label: "Insights", icon: LineChart },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { theme, toggle } = useTheme();

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Desktop top nav */}
      <header className="hidden md:block sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-sm font-medium tracking-tight">
            Ledger
          </Link>
          <nav className="flex items-center gap-1">
            {nav.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className="px-3 py-1.5 text-sm text-muted-foreground rounded-md hover:text-foreground hover:bg-muted transition-colors"
                activeProps={{ className: "px-3 py-1.5 text-sm rounded-md text-foreground bg-muted" }}
                activeOptions={{ exact: true }}
              >
                {n.label}
              </Link>
            ))}
            <button
              onClick={toggle}
              aria-label="Toggle theme"
              className="ml-2 p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
          </nav>
        </div>
      </header>

      {/* Mobile top strip */}
      <header className="md:hidden sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-sm font-medium tracking-tight">Ledger</span>
          <button
            onClick={toggle}
            aria-label="Toggle theme"
            className="p-2 -mr-2 rounded-md text-muted-foreground hover:text-foreground"
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 md:px-6 py-5 md:py-10 pb-24 md:pb-16">
        {children}
      </main>


      {/* Mobile bottom bar */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-border/60 bg-background/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="grid grid-cols-3">
          {nav.map((n) => {
            const Icon = n.icon;
            return (
              <Link
                key={n.to}
                to={n.to}
                className="flex flex-col items-center gap-0.5 py-2.5 text-[11px] text-muted-foreground"
                activeProps={{ className: "flex flex-col items-center gap-0.5 py-2.5 text-[11px] text-foreground" }}
                activeOptions={{ exact: true }}
              >
                <Icon className="size-5" />
                {n.label}
              </Link>
            );
          })}
        </div>
      </nav>

    </div>
  );
}
