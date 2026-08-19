import { useRef, useState, type FC, type ReactNode } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_WIDTH = 224; // w-56
const VIEWPORT_MARGIN = 8; // keep the box off the very edge of the screen
const ARROW_MARGIN = 12; // keep the pointer arrow off the box's own rounded corners

// A native title="" attribute would work but looks like an OS-default black-box popup with the
// wrong font and hard corners. Rendered into a portal at document.body with position: fixed
// coordinates from the trigger's own bounding rect, so it always draws above everything
// regardless of any ancestor's overflow/z-index (e.g. a card using overflow-hidden for its
// rounded corners, which would otherwise clip a normally-positioned absolute tooltip).
export const Tooltip: FC<{ text: string; children: ReactNode; triggerClassName?: string }> = ({
  text,
  children,
  triggerClassName = "cursor-help border-b border-dotted border-text-3/60 pb-px",
}) => {
  const triggerRef = useRef<HTMLSpanElement>(null);
  // `left` is the box's actual left edge (not a centerpoint — clamped to the viewport, so a
  // trigger near the screen edge doesn't push half the box off-screen). `arrowLeft` is the
  // pointer's own offset within that box, computed separately so it still points at the
  // trigger's true center even once the box itself has been shifted to fit.
  const [pos, setPos] = useState<{ top: number; left: number; arrowLeft: number } | null>(null);

  function show() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const triggerCenter = rect.left + rect.width / 2;
    const idealLeft = triggerCenter - TOOLTIP_WIDTH / 2;
    const maxLeft = window.innerWidth - TOOLTIP_WIDTH - VIEWPORT_MARGIN;
    const left = Math.min(Math.max(idealLeft, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, maxLeft));
    const arrowLeft = Math.min(Math.max(triggerCenter - left, ARROW_MARGIN), TOOLTIP_WIDTH - ARROW_MARGIN);
    setPos({ top: rect.top - 8, left, arrowLeft });
  }
  function hide() {
    setPos(null);
  }

  return (
    <span
      ref={triggerRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      tabIndex={0}
      className={triggerClassName}
    >
      {children}
      {pos &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-50 w-56 -translate-y-full rounded-lg border border-border bg-card px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-text-2 shadow-xl"
            style={{ top: pos.top, left: pos.left }}
          >
            {text}
            <span
              className="absolute top-full -mt-1 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r border-border bg-card"
              style={{ left: pos.arrowLeft }}
            />
          </div>,
          document.body,
        )}
    </span>
  );
};
