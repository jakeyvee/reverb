import { Card, SectionHeader } from "@/components/ui/card";

const WEEKS = 16;
const DAYS = 7;

export function HeatmapModule() {
  return (
    <Card>
      <SectionHeader title="Activity" description={`Last ${WEEKS} weeks`} />
      <div
        role="img"
        aria-label="Activity heatmap placeholder"
        className="grid grid-flow-col gap-1"
        style={{
          gridTemplateRows: `repeat(${DAYS}, minmax(0, 1fr))`,
          gridAutoColumns: "minmax(0, 1fr)",
        }}
      >
        {Array.from({ length: WEEKS * DAYS }).map((_, i) => (
          <span
            key={i}
            className="aspect-square rounded-[3px] bg-surface-muted"
            style={{ opacity: 0.45 + ((i % 9) / 9) * 0.05 }}
          />
        ))}
      </div>
      <p className="mt-3 text-xs text-foreground-subtle">
        Each square is a day. Color intensity will reflect time studied.
      </p>
    </Card>
  );
}
