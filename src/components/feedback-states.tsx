import { useId, type HTMLAttributes, type ReactNode } from "react";
import { ActionButton } from "@cvg/ui";

export type FeedbackHandler = () => void | Promise<void>;

type FeedbackSurfaceProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "aria-atomic" | "aria-describedby" | "aria-label" | "aria-labelledby" | "aria-live" | "role" | "title"
>;

interface RetryActionProps {
  onRetry?: FeedbackHandler;
  retryLabel?: string;
  retryAriaLabel?: string;
  retrying?: boolean;
}

export interface StaleNoticeProps extends FeedbackSurfaceProps, RetryActionProps {
  title?: ReactNode;
  message?: ReactNode;
  lastConfirmedAt?: ReactNode;
  lastConfirmedPrefix?: ReactNode;
  accessibleLabel?: string;
}

export interface PartialNoticeProps extends FeedbackSurfaceProps, RetryActionProps {
  title?: ReactNode;
  message?: ReactNode;
  accessibleLabel?: string;
}

export interface ErrorStateProps extends FeedbackSurfaceProps {
  title?: ReactNode;
  message?: ReactNode;
  onRetry: FeedbackHandler;
  retryLabel?: string;
  retryAriaLabel?: string;
  retrying?: boolean;
  action?: ReactNode;
}

export interface EmptyStateProps extends FeedbackSurfaceProps {
  title?: ReactNode;
  message?: ReactNode;
  actionLabel?: string;
  onAction?: FeedbackHandler;
  actionDisabled?: boolean;
  announce?: boolean;
}

export interface LoadingStateProps extends FeedbackSurfaceProps {
  label?: string;
  progressClassName?: string;
}

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}

function useFeedbackIds(prefix: string) {
  const uniqueId = useId().replace(/:/g, "");

  return {
    titleId: `${prefix}-title-${uniqueId}`,
    messageId: `${prefix}-message-${uniqueId}`,
    metaId: `${prefix}-meta-${uniqueId}`
  };
}

function FeedbackCopy({
  title,
  message,
  titleId,
  messageId
}: {
  title: ReactNode;
  message: ReactNode;
  titleId: string;
  messageId: string;
}) {
  return (
    <div className="feedback-state__copy">
      <h2 id={titleId} className="feedback-state__title">
        {title}
      </h2>
      <p id={messageId} className="feedback-state__message">
        {message}
      </p>
    </div>
  );
}

function RetryButton({
  onRetry,
  retryLabel = "Tentar novamente",
  retryAriaLabel,
  retrying = false
}: RetryActionProps) {
  if (!onRetry) return null;

  return (
    <ActionButton
      tone="ghost"
      className="feedback-state__action"
      type="button"
      onClick={() => void onRetry()}
      state={retrying ? "pending" : "idle"}
      aria-label={retrying ? "Tentando novamente..." : retryAriaLabel}
    >
      {retrying ? "Tentando novamente..." : retryLabel}
    </ActionButton>
  );
}

export function StaleNotice({
  title = "Dados desatualizados",
  message = "A última informação confirmada continua visível enquanto tentamos atualizar esta visão.",
  lastConfirmedAt,
  lastConfirmedPrefix = "Última confirmação: ",
  onRetry,
  retryLabel,
  retryAriaLabel,
  retrying,
  accessibleLabel,
  className,
  ...props
}: StaleNoticeProps) {
  const { titleId, messageId, metaId } = useFeedbackIds("stale-notice");
  const describedBy = lastConfirmedAt ? `${messageId} ${metaId}` : messageId;

  return (
    <div
      {...props}
      className={joinClassNames("feedback-state", "feedback-state--stale", className)}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={accessibleLabel}
      aria-labelledby={accessibleLabel ? undefined : titleId}
      aria-describedby={describedBy}
      data-feedback-state="stale"
    >
      <FeedbackCopy title={title} message={message} titleId={titleId} messageId={messageId} />
      {lastConfirmedAt && (
        <p id={metaId} className="feedback-state__meta">
          {lastConfirmedPrefix}{lastConfirmedAt}
        </p>
      )}
      <RetryButton onRetry={onRetry} retryLabel={retryLabel} retryAriaLabel={retryAriaLabel} retrying={retrying} />
    </div>
  );
}

export function PartialNotice({
  title = "Leitura parcial",
  message = "Alguns dados não estão disponíveis no momento. As informações carregadas continuam visíveis.",
  onRetry,
  retryLabel,
  retryAriaLabel,
  retrying,
  accessibleLabel,
  className,
  ...props
}: PartialNoticeProps) {
  const { titleId, messageId } = useFeedbackIds("partial-notice");

  return (
    <div
      {...props}
      className={joinClassNames("feedback-state", "feedback-state--partial", className)}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={accessibleLabel}
      aria-labelledby={accessibleLabel ? undefined : titleId}
      aria-describedby={messageId}
      data-feedback-state="partial"
    >
      <FeedbackCopy title={title} message={message} titleId={titleId} messageId={messageId} />
      <RetryButton onRetry={onRetry} retryLabel={retryLabel} retryAriaLabel={retryAriaLabel} retrying={retrying} />
    </div>
  );
}

export function ErrorState({
  title = "Não foi possível carregar esta informação",
  message = "Tente novamente em instantes.",
  onRetry,
  retryLabel,
  retryAriaLabel,
  retrying,
  action,
  className,
  ...props
}: ErrorStateProps) {
  const { titleId, messageId } = useFeedbackIds("error-state");

  return (
    <div
      {...props}
      className={joinClassNames("feedback-state", "feedback-state--error", className)}
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      data-feedback-state="error"
    >
      <FeedbackCopy title={title} message={message} titleId={titleId} messageId={messageId} />
      <div className="feedback-state__actions">
        <RetryButton onRetry={onRetry} retryLabel={retryLabel} retryAriaLabel={retryAriaLabel} retrying={retrying} />
        {action}
      </div>
    </div>
  );
}

export function EmptyState({
  title = "Nenhum item encontrado",
  message = "Não há dados para exibir nesta visão.",
  actionLabel = "Tentar novamente",
  onAction,
  actionDisabled = false,
  announce = true,
  className,
  ...props
}: EmptyStateProps) {
  const { titleId, messageId } = useFeedbackIds("empty-state");

  return (
    <div
      {...props}
      className={joinClassNames("feedback-state", "feedback-state--empty", className)}
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-atomic={announce ? "true" : undefined}
      aria-labelledby={announce ? titleId : undefined}
      aria-describedby={announce ? messageId : undefined}
      data-feedback-state="empty"
    >
      <FeedbackCopy title={title} message={message} titleId={titleId} messageId={messageId} />
      {onAction && (
        <ActionButton
          tone="ghost"
          className="feedback-state__action"
          type="button"
          onClick={() => void onAction()}
          state={actionDisabled ? "pending" : "idle"}
        >
          {actionLabel}
        </ActionButton>
      )}
    </div>
  );
}

export function LoadingState({ label = "Carregando conteúdo...", progressClassName, className, ...props }: LoadingStateProps) {
  const { titleId } = useFeedbackIds("loading-state");

  return (
    <div
      {...props}
      className={joinClassNames("feedback-state", "feedback-state--loading", className)}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-labelledby={titleId}
      aria-busy="true"
      data-feedback-state="loading"
    >
      <span className={joinClassNames("feedback-state__progress", progressClassName)} aria-hidden="true" />
      <span id={titleId} className="feedback-state__loading-label">
        {label}
      </span>
    </div>
  );
}
