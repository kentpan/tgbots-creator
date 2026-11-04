"use client";

export interface ConfigPreset {
  label: string;
  value: string;
}

export function ConfigPresetButtons({
  targetId,
  presets,
}: {
  targetId: string;
  presets: ConfigPreset[];
}) {
  const apply = (value: string): void => {
    const textarea = document.getElementById(targetId) as HTMLTextAreaElement | null;
    if (textarea) textarea.value = value;
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">快速模板：</span>
      {presets.map((preset) => (
        <button
          key={preset.label}
          type="button"
          onClick={() => apply(preset.value)}
          className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}
