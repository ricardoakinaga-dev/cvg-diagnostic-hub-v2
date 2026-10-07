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
  "list",
  "board",
  "calendar",
  "table",
  "filter",
  "sliders",
  "inbox",
  "chevron-down",
  "chevron-right",
  "chevron-left",
  "more",
  "link",
  "expand",
  "sidebar",
  "layers",
  "user-check",
  "paw",
  "scan",
  "waves",
  "bed",
  "help",
  "external",
  "activity",
  "home",
  "collapse",
  "hash",
  "building",
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
  list: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  board: ["M4 4h16v16H4z", "M9.33 4v16", "M14.67 4v16"],
  calendar: ["M5 5h14v15H5z", "M5 10h14", "M9 3v4", "M15 3v4"],
  table: ["M4 4h16v16H4z", "M4 9.5h16", "M4 15h16", "M10 9.5V20"],
  filter: ["M3 6h18", "M7 12h10", "M10 18h4"],
  sliders: ["M4 6h10", "M18 6h2", "M16 4v4", "M4 12h4", "M12 12h8", "M10 10v4", "M4 18h12", "M18 16v4"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  "chevron-down": ["m6 9 6 6 6-6"],
  "chevron-right": ["m9 6 6 6-6 6"],
  "chevron-left": ["m15 6-6 6 6 6"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  expand: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
  sidebar: ["M4 4h16v16H4z", "M9 4v16"],
  layers: ["m12 2 10 5-10 5L2 7z", "m2 17 10 5 10-5", "m2 12 10 5 10-5"],
  "user-check": ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "m16 11 2 2 4-4"],
  paw: ["M11 6.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z", "M17 6.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z", "M7 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z", "M21 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z", "M12 12.5c-2.5 0-5 3-5 5.5 0 1.7 1.3 2.5 2.7 2.5.9 0 1.5-.5 2.3-.5s1.4.5 2.3.5c1.4 0 2.7-.8 2.7-2.5 0-2.5-2.5-5.5-5-5.5Z"],
  scan: ["M3 7V5a2 2 0 0 1 2-2h2", "M17 3h2a2 2 0 0 1 2 2v2", "M21 17v2a2 2 0 0 1-2 2h-2", "M7 21H5a2 2 0 0 1-2-2v-2", "M7 12h10", "M12 7v10"],
  waves: ["M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1", "M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1", "M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"],
  bed: ["M2 4v16", "M2 8h18a2 2 0 0 1 2 2v10", "M2 17h20", "M6 8v9"],
  help: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3", "M12 17h.01"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  activity: ["M22 12h-4l-3 9L9 3l-3 9H2"],
  home: ["M3 10.5 12 3l9 7.5", "M5.5 9.5V21h13V9.5"],
  collapse: ["M4 14h6v6", "M20 10h-6V4", "M14 10l7-7", "M3 21l7-7"],
  building: ["M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16", "M16 9h2a2 2 0 0 1 2 2v10", "M3 21h18", "M8 7h4", "M8 11h4", "M8 15h4"],
  hash: ["M4 9h16", "M4 15h16", "M10 3 8 21", "M16 3l-2 18"],
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
