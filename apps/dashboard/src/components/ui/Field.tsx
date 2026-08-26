import type { FC } from "react";

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  min?: string;
  step?: string;
  hint?: string;
  placeholder?: string;
}

// Reserved height for a field's label(+hint) block, shared by Field itself and the couple of
// hand-rolled non-Field header rows in this form (e.g. the "Fill model" selects). A grid row
// stretches every cell to the height of its tallest cell, but a plain `flex-col` cell doesn't
// distribute that extra height — it collapses to content height and lets the input follow right
// after. So two cells in the same row whose headers wrap differently (a short hint on one line
// vs a longer one dropping to a second) end up with their inputs starting at different y
// offsets even though the cells themselves are the same height. Reserving a fixed min-height
// here — big enough for a nowrap label plus one wrapped hint line — makes every header the same
// height regardless of its own content, so inputs in the same row always line up.
export const FIELD_HEADER_CLASS = "min-h-10 flex flex-wrap content-start items-baseline gap-x-2 gap-y-0.5 min-w-0";

export const Field: FC<FieldProps> = ({ label, value, onChange, type = "text", min, step, hint, placeholder }) => {
  // <input type="number"> renders its value using the browser's locale-aware number formatting
  // (e.g. "5.5" paints as "5,5" under a comma-decimal locale) even though the underlying value
  // stays canonical — every caller here already treats this as a plain string and falls back
  // with `Number(x) || 0`, so nothing relies on the native number semantics. Rendering as text
  // with a decimal numeric keypad sidesteps the locale quirk entirely instead of just hiding it.
  const isNumeric = type === "number";

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className={FIELD_HEADER_CLASS}>
        <label className="text-sm font-medium text-text-2 whitespace-nowrap">{label}</label>
        {hint && <span className="text-xs text-text-3 font-mono truncate max-w-full">{hint}</span>}
      </div>
      <input
        type={isNumeric ? "text" : type}
        inputMode={isNumeric ? "decimal" : undefined}
        value={value}
        min={min}
        step={step}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 bg-surface border border-border rounded-xl px-4 py-2.5 text-sm font-mono text-text-1 placeholder:text-text-3 focus:outline-none focus:border-border-bright transition-colors"
      />
    </div>
  );
};
