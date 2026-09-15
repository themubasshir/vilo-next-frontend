export const STANDARD_PRACTICE_AREAS = [
  { value: "tort", label: "Tort" },
  { value: "contracts", label: "Contracts" },
  { value: "corporate", label: "Corporate" },
  { value: "real_estate", label: "Real Estate" },
  { value: "estate_probate", label: "Estate & Probate" },
  { value: "intellectual_property", label: "Intellectual Property" },
  { value: "trusts", label: "Trusts" },
];

const OTHER = { value: "other", label: "Other" };

function normalized(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

export function buildPracticeAreaChoices(values = []) {
  const choices = [...STANDARD_PRACTICE_AREAS];
  const known = new Set(choices.flatMap((choice) => [normalized(choice.value), normalized(choice.label)]));
  known.add(normalized(OTHER.value));
  known.add(normalized(OTHER.label));

  const custom = [];
  for (const rawValue of values) {
    const value = String(rawValue || "").trim();
    const key = normalized(value);
    if (!key || key === "test" || known.has(key)) continue;
    known.add(key);
    custom.push({ value, label: value });
  }

  custom.sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
  return [...choices, ...custom, OTHER];
}
