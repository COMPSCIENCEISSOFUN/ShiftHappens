export const ALLOCATION_FACTORS = [
  {
    key: "workloadBalance",
    label: "Workload balance",
    description: "Prefer staff with more remaining hours.",
  },
  {
    key: "availabilityFit",
    label: "Availability fit",
    description: "Prefer staff with a recorded availability schedule.",
  },
  {
    key: "certificationBreadth",
    label: "Certification breadth",
    description: "Prefer staff with more verified certifications.",
  },
  {
    key: "departmentExperience",
    label: "Department experience",
    description: "Prefer staff with more completed work in the department.",
  },
] as const;

export type AllocationWeightKey = (typeof ALLOCATION_FACTORS)[number]["key"];
export type AllocationWeights = Record<AllocationWeightKey, number>;

export const DEFAULT_ALLOCATION_WEIGHTS: AllocationWeights = {
  workloadBalance: 30,
  availabilityFit: 25,
  certificationBreadth: 25,
  departmentExperience: 20,
};

function isValidWeights(value: unknown): value is AllocationWeights {
  if (!value || typeof value !== "object") return false;
  return ALLOCATION_FACTORS.every(({ key }) => {
    const weight = (value as Record<string, unknown>)[key];
    return (
      typeof weight === "number" &&
      Number.isFinite(weight) &&
      weight >= 0 &&
      weight <= 100
    );
  });
}

/** Converts any valid positive factor values into integer percentages totaling 100. */
export function normalizeAllocationWeights(input: AllocationWeights): AllocationWeights {
  if (!isValidWeights(input)) throw new Error("Invalid allocation weights");

  const total = ALLOCATION_FACTORS.reduce((sum, { key }) => sum + input[key], 0);
  if (total <= 0) throw new Error("At least one allocation weight must be positive");

  const exact = ALLOCATION_FACTORS.map(({ key }, index) => ({
    key,
    index,
    value: (input[key] / total) * 100,
  }));
  const normalized = Object.fromEntries(
    exact.map(({ key, value }) => [key, Math.floor(value)])
  ) as AllocationWeights;
  let remainder = 100 - Object.values(normalized).reduce((sum, value) => sum + value, 0);

  for (const item of [...exact].sort(
    (a, b) => b.value % 1 - a.value % 1 || a.index - b.index
  )) {
    if (remainder === 0) break;
    normalized[item.key] += 1;
    remainder -= 1;
  }

  return normalized;
}

export function parseAllocationWeights(value: string | null | undefined): AllocationWeights {
  if (!value) return { ...DEFAULT_ALLOCATION_WEIGHTS };
  try {
    const parsed: unknown = JSON.parse(value);
    return isValidWeights(parsed)
      ? normalizeAllocationWeights(parsed)
      : { ...DEFAULT_ALLOCATION_WEIGHTS };
  } catch {
    return { ...DEFAULT_ALLOCATION_WEIGHTS };
  }
}
