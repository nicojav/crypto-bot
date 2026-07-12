import type { FC } from "react";

interface SelectProps {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}

// Compact filter-bar select styled to match ui/Field. Native <select> for
// keyboard/screen-reader accessibility; a chevron is layered on top.
export const Select: FC<SelectProps> = ({ label, value, onChange, options, className = "" }) => (
  <div className={`flex flex-col gap-1.5 ${className}`}>
    {label && <label className="data-label">{label}</label>}
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none bg-surface border border-border rounded-xl pl-3 pr-8 py-2 text-sm text-text-1 focus:outline-none focus:border-border-bright transition-colors cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <svg
        width="10" height="10" viewBox="0 0 10 10" fill="none"
        className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-text-3"
      >
        <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  </div>
);
