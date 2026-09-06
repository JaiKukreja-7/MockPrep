export interface HeatmapCell {
  /** ISO date, yyyy-mm-dd. */
  date: string;
  /** Rounds practised that day. */
  count: number;
  /** Column index in the grid, 0-based. */
  column: number;
  /** Row index, 0 = Monday. */
  row: number;
}

export interface HeatmapMonth {
  label: string;
  column: number;
}

export interface HeatmapProps {
  cells: HeatmapCell[];
  months: HeatmapMonth[];
  columns: number;
}

/**
 * Twelve months of practice, one square per day.
 *
 * Single hue at five steps and no legend: the ramp reads as more/less
 * without a key, and a key would be the only boxed, bordered thing on the
 * screen. Structure is hairline rules above and below — the cells carry no
 * borders and no radius, like every other flat block in the system.
 */
export function Heatmap({ cells, months, columns }: HeatmapProps) {
  return (
    <div className="flex flex-col gap-2">
      <div
        aria-hidden
        className="grid text-u-micro"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {months.map((month) => (
          <span
            key={`${month.label}-${month.column}`}
            style={{ gridColumn: `${month.column + 1} / span 4` }}
          >
            {month.label}
          </span>
        ))}
      </div>

      <div className="border-y border-y-rule py-2">
        <div
          className="grid grid-flow-col gap-[2px]"
          style={{
            gridTemplateRows: "repeat(7, minmax(0, 1fr))",
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          }}
        >
          {cells.map((cell) => (
            <span
              key={cell.date}
              className="aspect-square w-full"
              style={{
                gridColumn: cell.column + 1,
                gridRow: cell.row + 1,
                background: `var(--heat-${heatStep(cell.count)})`,
              }}
            />
          ))}
        </div>
      </div>

      {/* The grid is decorative; the number is the accessible version. */}
      <p className="text-u-micro">
        <span className="numeric">{totalRounds(cells)}</span> rounds in the last
        12 months
      </p>
    </div>
  );
}

/** Four filled steps. Anything past three reads the same — that is the point. */
function heatStep(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 4;
}

function totalRounds(cells: HeatmapCell[]) {
  return cells.reduce((sum, cell) => sum + cell.count, 0);
}
