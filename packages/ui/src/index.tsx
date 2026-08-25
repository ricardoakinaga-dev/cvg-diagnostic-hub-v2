import type { HTMLAttributes, ReactNode } from "react";

export interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}
/** Shared semantic surface primitive; product features own the content and layout. */
export function Surface({ children, className = "", ...props }: SurfaceProps) {
  return <section className={className} {...props}>{children}</section>;
}
