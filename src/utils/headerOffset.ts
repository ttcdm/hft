/**
 * The header is sticky and wraps onto more rows below 1024 px (UI-6), and the mode banner sits above it until the page scrolls,
 * so where the header ends is not a fixed 64 px. Header publishes its bottom edge as a CSS variable; the full-screen modals start below it.
 */
export const HEADER_HEIGHT_VAR = '--apex-header-h';
/** Tailwind class for an overlay that starts right under the header (64 px until the header has been measured). */
export const BELOW_HEADER_TOP = 'top-[var(--apex-header-h,4rem)]';

type Measured = { getBoundingClientRect(): { bottom: number }; previousElementSibling?: unknown };
type StyleRoot = { style: { setProperty(name: string, value: string): void } };

/** Writes the header's bottom edge to the CSS variable now, on scroll and resize, and when the header or the banner above it changes size. Returns a cleanup function. */
export function publishHeaderHeight(el: Measured, root: StyleRoot = document.documentElement): () => void {
  const write = () => root.style.setProperty(HEADER_HEIGHT_VAR, `${Math.max(0, Math.ceil(el.getBoundingClientRect().bottom))}px`);
  write();
  window.addEventListener('resize', write);
  window.addEventListener('scroll', write, { passive: true });
  let ro: ResizeObserver | undefined;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(write);
    ro.observe(el as unknown as Element);
    if (el.previousElementSibling) ro.observe(el.previousElementSibling as Element);
  }
  return () => {
    window.removeEventListener('resize', write);
    window.removeEventListener('scroll', write);
    ro?.disconnect();
  };
}
