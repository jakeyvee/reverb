import { DailySessionModule } from "@/components/home/daily-session";
import { CoupleStreaksModule } from "@/components/home/couple-streaks";
import { HeatmapModule } from "@/components/home/heatmap";
import { WeeklyXpModule } from "@/components/home/weekly-xp";

export default function HomePage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Welcome back</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Pick up where you left off, or upload a new lesson to expand your deck.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DailySessionModule />
        <CoupleStreaksModule />
        <WeeklyXpModule />
        <HeatmapModule />
      </div>
    </div>
  );
}
