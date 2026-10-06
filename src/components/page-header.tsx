import Link from "next/link";
import { Icon, type IconName } from "./ui-icons";

export interface Crumb {
  label: string;
  href?: string;
  icon?: IconName | React.ReactNode;
}

/**
 * Plane-style page header: a breadcrumb trail on the left, an optional count
 * badge, and the page's controls on the right, pinned to the top of the panel.
 * The current crumb is the page's h1 unless the page renders its own.
 */
export function PageHeader({ crumbs, count, children, heading = true }: { crumbs: Crumb[]; count?: number; children?: React.ReactNode; heading?: boolean }) {
  return (
    <header className="page-header">
      <nav className="page-crumbs" aria-label="Você está em">
        <ol>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            const icon = typeof crumb.icon === "string" ? <Icon name={crumb.icon as IconName} size={15} /> : crumb.icon;
            const content = <>{icon && <span className="crumb-icon" aria-hidden="true">{icon}</span>}<span>{crumb.label}</span></>;
            return (
              <li key={`${crumb.label}-${index}`} className={last ? "crumb-current" : undefined}>
                {crumb.href && !last ? <Link href={crumb.href}>{content}</Link> : last && heading ? <h1 className="crumb-heading">{content}</h1> : <span aria-current={last ? "page" : undefined}>{content}</span>}
                {!last && <Icon name="chevron-right" size={13} className="crumb-separator" />}
              </li>
            );
          })}
        </ol>
        {typeof count === "number" && <span className="count-badge"><span aria-hidden="true">{count}</span><span className="sr-only">{count} itens</span></span>}
      </nav>
      {children && <div className="page-header-actions">{children}</div>}
    </header>
  );
}
