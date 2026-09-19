import type { VisualStylePreset } from "@aivs/schemas";

export function GroupedVisualStyleSelect({ value, onChange, presets, categories, automaticLabel = "由AI生成画风" }: {
  value: string;
  onChange: (value: string) => void;
  presets: VisualStylePreset[];
  categories?: string[];
  automaticLabel?: string;
}) {
  const selectedPreset = presets.find((preset) => preset.prompt === value);
  const hasPreset = Boolean(selectedPreset);
  const categoryNames = categories?.length ? categories : Array.from(new Set(presets.map((preset) => preset.category)));
  return <label className="grouped-visual-style-select">画风设定<select value={hasPreset || !value ? value : "__current__"} onChange={(event) => { if (event.target.value !== "__current__") onChange(event.target.value); }}><option value="">{automaticLabel}</option>{value && !hasPreset && <option value="__current__">当前自定义画风</option>}{categoryNames.flatMap((category) => [<option disabled value={`__category_${category}`} key={`category-${category}`}>{category}</option>, ...presets.filter((preset) => preset.category === category).map((preset) => <option value={preset.prompt} key={preset.id}>　　{preset.name}</option>)])}</select></label>;
}
