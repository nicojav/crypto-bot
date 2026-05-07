import { type FC, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { postKillSwitch } from "../api/client";

interface KillSwitchDialogProps {
  open: boolean;
  onClose: () => void;
}

export const KillSwitchDialog: FC<KillSwitchDialogProps> = ({ open, onClose }) => {
  const [value, setValue] = useState("");
  const qc = useQueryClient();

  const kill = useMutation({
    mutationFn: postKillSwitch,
    onSuccess: ({ disabled }) => {
      void qc.invalidateQueries({ queryKey: ["bots"] });
      toast.success(`${disabled} bot${disabled !== 1 ? "s" : ""} disabled`);
      setValue("");
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) { setValue(""); onClose(); } }}
    >
      <div className="bg-card border border-border rounded-2xl w-full max-w-sm mx-4 animate-slide-up overflow-hidden">
        <div className="px-6 pt-6 pb-5">
          <div className="w-10 h-10 rounded-full bg-red/10 flex items-center justify-center mb-4">
            <span className="text-red text-lg">⏹</span>
          </div>
          <h2 className="text-base font-semibold text-text-1 mb-1">Kill all bots</h2>
          <p className="text-sm text-text-2">This will immediately disable all active bots. Type <span className="font-mono text-text-1 bg-surface px-1.5 py-0.5 rounded text-xs">DISABLE</span> to confirm.</p>
        </div>

        <div className="px-6 pb-6 flex flex-col gap-3">
          <input
            autoFocus
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && value === "DISABLE") kill.mutate();
              if (e.key === "Escape") { setValue(""); onClose(); }
            }}
            placeholder="DISABLE"
            spellCheck={false}
            className="w-full bg-surface border border-border rounded-xl px-4 py-2.5 text-sm font-mono text-text-1 placeholder:text-text-3 focus:outline-none focus:border-border-bright transition-colors"
          />

          <div className="flex gap-2">
            <button
              onClick={() => { setValue(""); onClose(); }}
              className="flex-1 py-2.5 rounded-xl border border-border text-sm font-medium text-text-2 hover:border-border-bright hover:text-text-1 transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={value !== "DISABLE" || kill.isPending}
              onClick={() => kill.mutate()}
              className="flex-1 py-2.5 rounded-xl bg-red text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-red-dim transition-colors"
            >
              {kill.isPending ? "Disabling…" : "Kill all"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
