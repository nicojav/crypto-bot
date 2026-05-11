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

export const Field: FC<FieldProps> = ({ label, value, onChange, type = "text", min, step, hint, placeholder }) => (
  <div className="flex flex-col gap-1.5">
    <div className="flex items-center justify-between">
      <label className="text-sm font-medium text-text-2">{label}</label>
      {hint && <span className="text-xs text-text-3 font-mono">{hint}</span>}
    </div>
    <input
      type={type}
      value={value}
      min={min}
      step={step}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="bg-surface border border-border rounded-xl px-4 py-2.5 text-sm font-mono text-text-1 placeholder:text-text-3 focus:outline-none focus:border-border-bright transition-colors"
    />
  </div>
);
