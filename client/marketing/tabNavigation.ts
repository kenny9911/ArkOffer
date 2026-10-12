import type { KeyboardEvent } from "react";

/** Keyboard behavior shared by the public-page, single-selection tab sets. */
export function moveMarketingTab(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  count: number,
  select: (index: number) => void,
) {
  const directions: Record<string, number> = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
  };
  const delta = directions[event.key];
  if (delta === undefined && event.key !== "Home" && event.key !== "End")
    return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? count - 1
        : (index + delta + count) % count;
  select(next);
  event.currentTarget.parentElement
    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    [next]?.focus();
}
