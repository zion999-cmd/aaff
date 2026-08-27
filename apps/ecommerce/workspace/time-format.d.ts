// Type declarations for apps/ecommerce/workspace/time-format.js.
// P0010.2.x — single source of truth for "how to display a timestamp".
// The four formatters are documented inline in the .js file.

export function formatLocalTime(iso: string | null | undefined): string;
export function formatUtcTime(iso: string | null | undefined): string;
export function formatBusinessDate(iso: string | null | undefined): string;
export function formatProxyTime(iso: string | null | undefined): string;
export function formatRelative(iso: string | null | undefined, now?: number): string;
