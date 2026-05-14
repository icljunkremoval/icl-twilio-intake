import { Header } from "@/components/Header";
import { TabBar } from "@/components/TabBar";
import { WeekNav } from "@/components/WeekNav";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 pb-24 pt-4">
      <Header />
      <div className="mt-4">
        <WeekNav />
      </div>
      <main className="mt-4 flex-1 space-y-4">{children}</main>
      <TabBar />
    </div>
  );
}
