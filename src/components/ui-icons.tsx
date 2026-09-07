import { useId } from "react";

export const iconNames = [
  "overview",
  "queue",
  "requests",
  "attention",
  "analytics",
  "users",
  "catalog",
  "audit",
  "patients",
  "notifications",
  "account",
  "settings",
  "logout",
  "search",
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "dot",
  "refresh",
  "close",
  "check",
  "lab",
  "imaging",
  "spark",
  "clock",
  "add",
] as const;

export type IconName = (typeof iconNames)[number];

export interface IconProps {
  name: IconName;
  size?: number | string;
  title?: string;
  className?: string;
}

type IconPath = readonly string[];

const iconPaths: Record<IconName, IconPath> = {
  overview: ["M3 10.5 12 3l9 7.5", "M5.5 9.5V21h13V9.5", "M9.5 21v-6h5v6"],
  queue: [
    "M5 6.5h.01",
    "M9 6.5h10",
    "M5 12h.01",
    "M9 12h10",
    "M5 17.5h.01",
    "M9 17.5h10",
  ],
  requests: ["M7 3.5h7l3 3v14H7z", "M14 3.5v3h3", "M10 11h4", "M10 15h4"],
  attention: ["M12 4 21 20H3Z", "M12 9v5", "M12 17h.01"],
  analytics: [
    "M4 19V5",
    "M4 19h16",
    "M7 16v-4",
    "M11 16V8",
    "M15 16v-6",
    "M19 16v-3",
  ],
  users: [
    "M8 20c0-2.2 1.8-4 4-4s4 1.8 4 4",
    "M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M18 20c0-1.7-1-3.1-2.4-3.7",
    "M16.5 6.3a2.5 2.5 0 0 1 0 4.8",
  ],
  catalog: [
    "M5 4.5h10a3 3 0 0 1 3 3v12H8a3 3 0 0 0-3 3z",
    "M5 4.5v15",
    "M8 19.5h10",
  ],
  audit: ["M12 3.5a8.5 8.5 0 1 0 8.5 8.5", "M12 7.5v5l3 2", "M16 4h4v4"],
  patients: [
    "M8 20c0-2.2 1.8-4 4-4s4 1.8 4 4",
    "M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M17 8v5",
    "M14.5 10.5h5",
  ],
  notifications: [
    "M6 17.5h12l-1.5-2v-4a4.5 4.5 0 0 0-9 0v4z",
    "M10 20.5h4",
  ],
  account: ["M5 20c.7-3.2 3.4-5.5 7-5.5s6.3 2.3 7 5.5", "M12 11.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"],
  settings: [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    "M12 3.5v2",
    "M12 18.5v2",
    "m20.5 12-2 0",
    "m5.5 12-2 0",
    "m18.01 5.99-1.42 1.42",
    "m7.41 16.59-1.42 1.42",
    "m18.01 18.01-1.42-1.42",
    "m7.41 7.41-1.42-1.42",
  ],
  logout: [
    "M14 5h5v14h-5",
    "M11 8l4 4-4 4",
    "M15 12H3",
  ],
  search: ["M10.75 18a7.25 7.25 0 1 0 0-14.5 7.25 7.25 0 0 0 0 14.5Z", "m16 16 5 5"],
  "arrow-left": ["M19 12H5", "m11 6-6 6 6 6"],
  "arrow-right": ["M5 12h14", "m13 6 6 6-6 6"],
  "arrow-up": ["M12 19V5", "m6 11 6-6 6 6"],
  dot: ["M12 12h.01"],
  refresh: [
    "M20 11a8 8 0 0 0-14.9-3.9L4 9",
    "M4 5v4h4",
    "M4 13a8 8 0 0 0 14.9 3.9L20 15",
    "M20 19v-4h-4",
  ],
  close: ["m6 6 12 12", "m18 6-12 12"],
  check: ["m5 12 4.5 4.5L19 7"],
  lab: ["M9 3v5l-5.5 9.5A2 2 0 0 0 5.2 21h13.6a2 2 0 0 0 1.7-3.5L15 8V3", "M7 13h10", "M8 3h7"],
  imaging: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z", "M8.5 12h7", "M12 8.5v7"],
  spark: ["m12 3 1.5 6.5L20 11l-6.5 1.5L12 19l-1.5-6.5L4 11l6.5-1.5Z"],
  clock: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z", "M12 8v4l3 2"],
  add: ["M12 5v14", "M5 12h14"],
};

export function Icon({ name, size = 20, title, className }: IconProps) {
  const titleId = useId();
  const paths = iconPaths[name];

  if (!paths) {
    return null;
  }

  const hasTitle = Boolean(title);

  return (
    <svg
      aria-hidden={hasTitle ? undefined : true}
      aria-labelledby={hasTitle ? `${titleId}-title` : undefined}
      className={className}
      fill="none"
      focusable="false"
      height={size}
      role={hasTitle ? "img" : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      {hasTitle ? <title id={`${titleId}-title`}>{title}</title> : null}
      {paths.map((path) => <path d={path} key={path} vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}
