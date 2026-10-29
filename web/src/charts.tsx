import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Sankey,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { Day, ManagerOverview } from "./api";
import { hm, shortDate, weekLabel } from "./format";

// Reference categorical palette, fixed order (validated: adjacent pairs pass CVD checks).
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const OTHER = "#a8a69f";
export const STATUS_COLOR: Record<string, string> = {
  Done: "#0ca30c",
  "In progress": "#2a78d6",
  Stalled: "#ec835a",
  "No Jira key": "#a8a69f",
};
const AXIS = { stroke: "#7a7873", fontSize: 12, tickLine: false, axisLine: false } as const;
const GRID = <CartesianGrid stroke="#ebe8e1" vertical={false} />;

// Developer colors follow the developer (their position in the full list), never their rank.
export function devColor(name: string, all: { name: string }[]) {
  const i = all.findIndex((d) => d.name === name);
  return i >= 0 && i < SERIES.length ? SERIES[i] : OTHER;
}

function Tip({ active, payload, label, format }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      {label !== undefined && <div className="t">{format?.label ? format.label(label) : label}</div>}
      {payload.map((p: any) => (
        <div key={p.name ?? p.dataKey}>
          <span className="sw" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: p.color ?? p.payload?.fill, marginRight: 6 }} />
          {p.name}: <b>{format?.value ? format.value(p.value) : p.value}</b>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.name}>
          <span className="sw" style={{ background: i.color }} />
          {i.name}
        </span>
      ))}
    </div>
  );
}

// Pie with legend; slices beyond the eight slots are already folded into "Other tasks" by the server.
export function HoursPie({ data, colorFor }: { data: { name: string; hours: number }[]; colorFor: (name: string, i: number) => string }) {
  if (data.length === 0) return <div className="empty">No data yet — press Collect now.</div>;
  const total = data.reduce((a, d) => a + d.hours, 0);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 16, alignItems: "center" }}>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={data} dataKey="hours" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={data.length > 1 ? 1 : 0} stroke="#fcfcfb" strokeWidth={data.length > 1 ? 2 : 0} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={d.name} fill={colorFor(d.name, i)} />
            ))}
          </Pie>
          <Tooltip content={<Tip format={{ value: (v: number) => `${v} h (${Math.round((v / total) * 100)}%)` }} />} />
        </PieChart>
      </ResponsiveContainer>
      <table>
        <tbody>
          {data.map((d, i) => (
            <tr key={d.name}>
              <td style={{ padding: "4px 6px" }}>
                <span className="sw" style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: colorFor(d.name, i), marginRight: 8 }} />
                {d.name}
              </td>
              <td className="num" style={{ padding: "4px 6px" }}>{d.hours} h</td>
              <td className="num muted" style={{ padding: "4px 6px" }}>{Math.round((d.hours / total) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FlowSankey({ data, devs }: { data: ManagerOverview["sankey"]; devs: { name: string }[] }) {
  if (data.links.length === 0) return <div className="empty">No task activity in this range.</div>;
  const colorOf = (n: { name: string; kind: string }) =>
    n.kind === "developer" ? devColor(n.name, devs) : n.kind === "status" ? STATUS_COLOR[n.name] ?? OTHER : "#52514e";
  const height = Math.max(260, data.nodes.filter((n) => n.kind === "task").length * 34);
  const Node = (props: any) => {
    const { x, y, width, height: h, payload } = props;
    const isLeft = payload.kind === "developer";
    const isRight = payload.kind === "status";
    return (
      <g>
        <rect x={x} y={y} width={width} height={h} fill={colorOf(payload)} rx={2} />
        <text
          x={isRight ? x - 6 : x + width + 6}
          y={y + h / 2}
          dy="0.35em"
          textAnchor={isRight ? "end" : "start"}
          fontSize={12}
          fill="#0b0b0b"
          style={{ pointerEvents: "none" }}
        >
          {payload.name}
          {isLeft || isRight ? ` · ${Math.round(payload.value * 10) / 10} h` : ""}
        </text>
      </g>
    );
  };
  return (
    <ResponsiveContainer width="100%" height={height}>
      <Sankey
        data={data}
        node={<Node />}
        nodePadding={18}
        nodeWidth={10}
        margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
        link={{ stroke: "#2a78d6", strokeOpacity: 0.18 }}
      >
        <Tooltip content={<Tip format={{ value: (v: number) => `${Math.round(v * 10) / 10} h` }} />} />
      </Sankey>
    </ResponsiveContainer>
  );
}

export function WeeklyDoneBars({ data, devs, all }: { data: Record<string, string | number>[]; devs: string[]; all: { name: string }[] }) {
  if (!data.some((w) => devs.some((d) => Number(w[d]) > 0))) {
    return <div className="empty">No tasks merged in the last 6 weeks.</div>;
  }
  return (
    <>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} barCategoryGap="30%">
          {GRID}
          <XAxis dataKey="week" tickFormatter={weekLabel} {...AXIS} />
          <YAxis allowDecimals={false} {...AXIS} width={30} />
          <Tooltip cursor={{ fill: "rgba(0,0,0,0.03)" }} content={<Tip format={{ label: (w: string) => `Week of ${weekLabel(w)}` }} />} />
          {devs.map((d, i) => (
            <Bar key={d} dataKey={d} stackId="done" fill={devColor(d, all)} stroke="#fcfcfb" strokeWidth={2} radius={i === devs.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      {devs.length > 1 && <Legend items={devs.map((d) => ({ name: d, color: devColor(d, all) }))} />}
    </>
  );
}

export function LoadLines({ data, devs, all, threshold }: { data: Record<string, string | number>[]; devs: string[]; all: { name: string }[]; threshold: number }) {
  return (
    <>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data}>
          {GRID}
          <XAxis dataKey="date" tickFormatter={(d) => shortDate(d).split(",")[0]} {...AXIS} minTickGap={24} />
          <YAxis domain={[0, 100]} {...AXIS} width={30} />
          <Tooltip content={<Tip format={{ label: shortDate }} />} />
          <Line dataKey={() => threshold} name="Threshold" stroke="#a8a69f" strokeDasharray="4 4" dot={false} strokeWidth={1} isAnimationActive={false} />
          {devs.map((d) => (
            <Line key={d} dataKey={d} stroke={devColor(d, all)} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <Legend items={[...devs.map((d) => ({ name: d, color: devColor(d, all) })), { name: `Overload threshold (${threshold})`, color: "#a8a69f" }]} />
    </>
  );
}

// Load vs output: one point per developer per week. Single color; identity is in the tooltip
// (more than three series cannot be told apart reliably in a scatter).
export function LoadOutputScatter({ data }: { data: ManagerOverview["scatter"] }) {
  if (data.length === 0) return <div className="empty">No weekly data yet.</div>;
  const ScatterTip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    return (
      <div className="chart-tooltip">
        <div className="t">{p.developer}</div>
        <div>Week of {weekLabel(p.week)}</div>
        <div>{p.hours} h hands-on · {p.tasksDone} tasks done</div>
      </div>
    );
  };
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
        <CartesianGrid stroke="#ebe8e1" />
        <XAxis type="number" dataKey="hours" name="Hands-on hours" unit=" h" {...AXIS} label={{ value: "Hands-on hours per week", position: "insideBottom", offset: -8, fontSize: 12, fill: "#52514e" }} />
        <YAxis type="number" dataKey="tasksDone" name="Tasks done" allowDecimals={false} {...AXIS} width={30} />
        <ZAxis range={[80, 80]} />
        <Tooltip content={<ScatterTip />} />
        <Scatter data={data} fill="#2a78d6" stroke="#fcfcfb" strokeWidth={2} isAnimationActive={false} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}

export function CycleTimeLine({ data }: { data: ManagerOverview["cycleTrend"] }) {
  if (!data.some((d) => d.medianCycleDays != null)) return <div className="empty">No finished tasks yet.</div>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data}>
        {GRID}
        <XAxis dataKey="week" tickFormatter={weekLabel} {...AXIS} />
        <YAxis {...AXIS} width={30} unit="d" />
        <Tooltip content={<Tip format={{ label: (w: string) => `Week of ${weekLabel(w)}`, value: (v: number) => `${v} days` }} />} />
        <Line dataKey="medianCycleDays" name="Median cycle time" stroke="#2a78d6" strokeWidth={2} dot={{ r: 4 }} connectNulls isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function WeeklyProgressBars({ data }: { data: { week: string; tasksDone: number; activeHours: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} barCategoryGap="30%">
        {GRID}
        <XAxis dataKey="week" tickFormatter={weekLabel} {...AXIS} />
        <YAxis allowDecimals={false} {...AXIS} width={30} />
        <Tooltip cursor={{ fill: "rgba(0,0,0,0.03)" }} content={<Tip format={{ label: (w: string) => `Week of ${weekLabel(w)}` }} />} />
        <Bar dataKey="tasksDone" name="Tasks done" fill="#2a78d6" radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const blockStyle = (b: { start: number; end: number }) => ({
  left: `${(b.start / 1440) * 100}%`,
  width: `${(Math.max(b.end - b.start, 4) / 1440) * 100}%`,
});
const blockLabel = (b: { start: number; end: number }) =>
  `${pad(Math.floor(b.start / 60))}:${pad(b.start % 60)} – ${pad(Math.floor(b.end / 60) % 24)}:${pad(b.end % 60)} (${hm(b.end - b.start)})`;

// 14-day activity timeline: one row per day, your blocks over Claude's working time, across 24 hours.
export function ActivityTimeline({ days, lateHour }: { days: Day[]; lateHour: number }) {
  return (
    <div className="timeline">
      {[...days].reverse().map((d) => (
        <div className="tl-row" key={d.date}>
          <div className="secondary">{shortDate(d.date)}</div>
          <div className="track" title={`You ${hm(d.activeMinutes)} · agents ${hm(d.agentMinutes)}`}>
            <div className="late-zone" style={{ left: `${(lateHour / 24) * 100}%` }} />
            {d.agentBlocks.map((b, i) => (
              <div key={`a${i}`} className="blk agent" style={blockStyle(b)} title={`Claude ${blockLabel(b)}`} />
            ))}
            {d.blocks.map((b, i) => (
              <div key={i} className={`blk${b.start >= lateHour * 60 || b.start < 360 ? " late" : ""}`} style={blockStyle(b)} title={`You ${blockLabel(b)}`} />
            ))}
          </div>
          <div className="num" style={{ textAlign: "right" }}>{d.activeMinutes ? hm(d.activeMinutes) : "—"}</div>
        </div>
      ))}
      <div className="axis">
        <div />
        <div className="ticks">
          {["00", "04", "08", "12", "16", "20", "24"].map((h) => (
            <span key={h}>{h}:00</span>
          ))}
        </div>
        <div />
      </div>
      <Legend
        items={[
          { name: "You", color: "#2a78d6" },
          { name: "Claude working", color: "#9ec5f4" },
          { name: `You, late night (after ${lateHour}:00 or before 06:00)`, color: "#e34948" },
        ]}
      />
    </div>
  );
}

export function LoadTrendSingle({ days, threshold }: { days: Day[]; threshold: number }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={days.map((d) => ({ date: d.date, Load: d.loadScore, threshold }))}>
        {GRID}
        <XAxis dataKey="date" tickFormatter={(d) => shortDate(d).split(",")[0]} {...AXIS} minTickGap={24} />
        <YAxis domain={[0, 100]} {...AXIS} width={30} />
        <Tooltip content={<Tip format={{ label: shortDate }} />} />
        <Line dataKey="threshold" name="Overload threshold" stroke="#a8a69f" strokeDasharray="4 4" dot={false} strokeWidth={1} isAnimationActive={false} />
        <Line dataKey="Load" name="Load score" stroke="#2a78d6" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
