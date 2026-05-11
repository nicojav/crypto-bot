import type { FC } from "react";

interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  colorOn?: "green" | "amber";
}

export const Switch: FC<SwitchProps> = ({ checked, onChange, colorOn = "green" }) => {
  const trackOn = colorOn === "green" ? "bg-green" : "bg-amber";
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={[
        "inline-flex items-center h-6 w-11 rounded-full px-[3px] transition-colors duration-200 shrink-0 focus:outline-none cursor-pointer",
        checked ? trackOn : "bg-border",
      ].join(" ")}
    >
      <span
        className={[
          "block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform duration-200",
          checked ? "translate-x-[17px]" : "translate-x-0",
        ].join(" ")}
      />
    </button>
  );
};
