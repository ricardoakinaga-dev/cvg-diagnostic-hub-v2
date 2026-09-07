import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}
/** Shared semantic surface primitive; product features own the content and layout. */
export function Surface({ children, className = "", ...props }: SurfaceProps) {
  return <section className={`ui-surface ${className}`.trim()} data-ui-surface="true" {...props}>{children}</section>;
}

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: "primary" | "ghost" | "danger";
  icon?: ReactNode;
  /** Server-confirmed interaction state; callers own the visible copy. */
  state?: "idle" | "pending" | "confirmed" | "failed" | "unknown" | "denied";
}

/** Shared action primitive. Visual treatment is owned by the host app tokens. */
export function ActionButton({ children, className = "", tone = "primary", icon, type = "button", state = "idle", disabled, ...props }: ActionButtonProps) {
  const guardedState = state === "pending" || state === "denied";
  return <button
    className={`button button-${tone} ${className}`.trim()}
    type={type}
    {...props}
    data-action-state={state}
    aria-busy={state === "pending" ? true : props["aria-busy"]}
    disabled={guardedState || disabled}
  >{icon}{children}</button>;
}

export interface SectionHeadingProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function SectionHeading({ eyebrow, title, description, action, className = "", ...props }: SectionHeadingProps) {
  return <div className={`ui-section-heading ${className}`.trim()} {...props}>
    <div>{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}<h2>{title}</h2>{description ? <p className="ui-section-heading-description">{description}</p> : null}</div>
    {action}
  </div>;
}
