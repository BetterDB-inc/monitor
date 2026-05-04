import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function formatDurationUs(us: number): string {
  if (us < 1_000) return `${us.toFixed(0)}µs`;
  if (us < 1_000_000) return `${(us / 1_000).toFixed(1)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}
