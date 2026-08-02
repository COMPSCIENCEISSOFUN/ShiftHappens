/**
 * Chart primitives.
 *
 * A chart is easy to get wrong in ways that look fine: arcs drawn from the
 * wrong start angle still make a circle, and a heatmap that scales zero still
 * produces a pretty grid. These tests pin the properties that are invisible on
 * inspection.
 *
 * They also pin the accessibility contract, which is the part that silently
 * rots — every chart here has to carry a text equivalent, because a picture
 * with no numbers in the DOM is unreadable to anyone not looking at it.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  BarList,
  CoverageHeatmap,
  Donut,
  Meter,
  StackedBar,
} from "@/components/charts/chart-primitives";
import { CATEGORICAL, ORDINAL, SEQUENTIAL, sequentialStep } from "@/components/charts/palette";

const slices = [
  { key: "a", label: "Free", value: 3, colour: ORDINAL[0] },
  { key: "b", label: "Pro", value: 1, colour: ORDINAL[1] },
];

function arcs(container: HTMLElement) {
  // The first circle is the track; the rest are data.
  return [...container.querySelectorAll("circle")].slice(1);
}

describe("Donut", () => {
  it("shows the total in the middle, not a slice value", () => {
    render(<Donut slices={slices} centreLabel="organisations" />);
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("draws each arc from where the previous one ended", () => {
    // Offsets are precomputed rather than accumulated during render. If that
    // ever regresses to a mutable counter, a re-render reuses a stale closure
    // and every arc after the first starts in the wrong place — which still
    // looks like a donut.
    const { container } = render(<Donut slices={slices} />);
    const [first, second] = arcs(container);

    expect(first.getAttribute("stroke-dashoffset")).toBe("0");
    expect(second.getAttribute("stroke-dashoffset")).toBe("-75");
  });

  it("omits a slice with no value rather than drawing a zero-width arc", () => {
    const { container } = render(
      <Donut slices={[...slices, { key: "c", label: "Enterprise", value: 0, colour: ORDINAL[2] }]} />
    );
    expect(arcs(container)).toHaveLength(2);
  });

  it("still lists a zero category in the legend", () => {
    // Absent from the ring but present in the key: "Enterprise: 0" is
    // information, and dropping it makes the reader wonder if the tier exists.
    render(
      <Donut slices={[...slices, { key: "c", label: "Enterprise", value: 0, colour: ORDINAL[2] }]} />
    );
    // Twice on purpose: once in the visible legend, once in the screen-reader
    // table. Both are the point.
    expect(screen.getAllByText("Enterprise")).toHaveLength(2);
  });

  it("does not notch the ring when one slice is everything", () => {
    // The inter-segment gap is subtracted from each arc. At 100% that would
    // carve a wedge out of a complete ring for no reason.
    const { container } = render(
      <Donut slices={[{ key: "a", label: "Only", value: 5, colour: ORDINAL[0] }]} />
    );
    expect(arcs(container)[0].getAttribute("stroke-dasharray")).toBe("100 0");
  });

  it("says it is empty rather than drawing a ring of nothing", () => {
    render(
      <Donut
        slices={[{ key: "a", label: "Free", value: 0, colour: ORDINAL[0] }]}
        emptyMessage="No organisations yet"
      />
    );
    expect(screen.getByText("No organisations yet")).toBeInTheDocument();
  });

  it("carries a text equivalent of the picture", () => {
    render(<Donut slices={slices} centreLabel="organisations" />);
    const table = screen.getByRole("table", { hidden: true });
    expect(within(table).getByRole("rowheader", { name: "Free", hidden: true })).toBeInTheDocument();
  });

  it("names each arc for a pointer, with its share", () => {
    const { container } = render(<Donut slices={slices} />);
    expect(arcs(container)[0].querySelector("title")?.textContent).toBe("Free: 3 (75%)");
  });
});

describe("StackedBar", () => {
  it("sizes segments by share of the total", () => {
    const { container } = render(<StackedBar slices={slices} />);
    const segments = container.querySelectorAll("[title]");
    expect((segments[0] as HTMLElement).style.width).toBe("75%");
  });

  it("shows a percentage beside every legend entry", () => {
    render(<StackedBar slices={slices} />);
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("reports empty rather than rendering a bar of nothing", () => {
    render(
      <StackedBar
        slices={[{ key: "a", label: "Free", value: 0, colour: CATEGORICAL[0] }]}
        emptyMessage="Nothing yet"
      />
    );
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
  });
});

describe("BarList", () => {
  const rows = [
    { key: "a", label: "Hour limits", value: 2 },
    { key: "b", label: "Certifications", value: 6 },
  ];

  it("sorts descending regardless of input order", () => {
    render(<BarList rows={rows} />);
    const table = screen.getByRole("table", { hidden: true });
    const headers = within(table).getAllByRole("rowheader", { hidden: true });
    expect(headers[0]).toHaveTextContent("Certifications");
  });

  it("scales bars against the largest value, not the total", () => {
    const { container } = render(<BarList rows={rows} />);
    const fills = [...container.querySelectorAll("div[title]")] as HTMLElement[];
    expect(fills[0].style.width).toBe("100%");
  });

  it("gives a tiny value a visible minimum width", () => {
    // A bar of 0.4% is indistinguishable from no bar, which misreads as zero.
    const { container } = render(
      <BarList rows={[{ key: "a", label: "Big", value: 500 }, { key: "b", label: "Small", value: 1 }]} />
    );
    const fills = [...container.querySelectorAll("div[title]")] as HTMLElement[];
    expect(fills[1].style.width).toBe("3%");
  });

  it("says nothing was recorded rather than drawing empty tracks", () => {
    render(<BarList rows={[]} emptyMessage="No overrides" />);
    expect(screen.getByText("No overrides")).toBeInTheDocument();
  });

  it("treats all-zero rows as nothing recorded", () => {
    render(<BarList rows={[{ key: "a", label: "Hour limits", value: 0 }]} emptyMessage="No overrides" />);
    expect(screen.getByText("No overrides")).toBeInTheDocument();
  });
});

describe("Meter", () => {
  it("renders an em dash for a null percentage", () => {
    // Null means "nothing to divide". Rendering 0% would read as total failure.
    render(<Meter label="Ranked first" percentage={null} detail="0 of 0" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("describes itself for a screen reader", () => {
    render(<Meter label="Ranked first" percentage={80} detail="4 of 5 still on the shift" />);
    expect(
      screen.getByRole("img", { name: /Ranked first: 80 percent\. 4 of 5/ })
    ).toBeInTheDocument();
  });

  it("clamps a percentage above 100 rather than overflowing the track", () => {
    const { container } = render(<Meter label="x" percentage={140} detail="d" />);
    const fill = container.querySelector('[role="img"] > div') as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });
});

describe("sequentialStep", () => {
  it("pins zero to the palest step", () => {
    // Zero must look identical in a quiet week and a busy one. If it scaled,
    // an empty hour could take the same shade as a well-staffed hour elsewhere.
    expect(sequentialStep(0, 10)).toBe(SEQUENTIAL[0]);
    expect(sequentialStep(0, 1)).toBe(SEQUENTIAL[0]);
  });

  it("never puts a non-zero value on the zero step", () => {
    // 1 out of 100 is very little, but it is not nothing, and it must not
    // render as an empty cell.
    expect(sequentialStep(1, 100)).toBe(SEQUENTIAL[1]);
  });

  it("puts the maximum on the darkest step", () => {
    expect(sequentialStep(10, 10)).toBe(SEQUENTIAL[SEQUENTIAL.length - 1]);
  });

  it("survives a max of zero without dividing by it", () => {
    expect(sequentialStep(0, 0)).toBe(SEQUENTIAL[0]);
  });
});

describe("CoverageHeatmap", () => {
  const cells = [
    { dayOfWeek: 1, hour: 9, count: 4 },
    { dayOfWeek: 1, hour: 10, count: 2 },
    { dayOfWeek: 3, hour: 18, count: 1 },
  ];

  it("draws a cell for every hour of every day, not only the ones with data", () => {
    // Gaps are the point of a coverage map. Rendering only populated cells
    // would collapse the grid and hide exactly what it exists to show.
    const { container } = render(<CoverageHeatmap cells={cells} />);
    expect(container.querySelectorAll("[title]")).toHaveLength(7 * 24);
  });

  it("names the busiest hour", () => {
    render(<CoverageHeatmap cells={cells} />);
    expect(screen.getByText(/Busiest: Mon 09:00/)).toBeInTheDocument();
  });

  it("labels each cell with its day, hour and count", () => {
    const { container } = render(<CoverageHeatmap cells={cells} />);
    expect(container.querySelector('[title="Mon 09:00 — 4 available"]')).not.toBeNull();
    expect(container.querySelector('[title="Sun 00:00 — 0 available"]')).not.toBeNull();
  });

  it("lists only the populated hours in the text equivalent", () => {
    // All 168 rows would make the table useless to a screen reader; the empty
    // hours carry no information a reader needs read aloud.
    render(<CoverageHeatmap cells={cells} />);
    const table = screen.getByRole("table", { hidden: true });
    expect(within(table).getAllByRole("rowheader", { hidden: true })).toHaveLength(3);
  });

  it("reports empty when nobody is available at any hour", () => {
    render(
      <CoverageHeatmap
        cells={[{ dayOfWeek: 0, hour: 0, count: 0 }]}
        emptyMessage="No availability recorded"
      />
    );
    expect(screen.getByText("No availability recorded")).toBeInTheDocument();
  });
});
