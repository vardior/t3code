import { Button } from "../ui/button";

export function BotsState({
  title,
  description,
  retry,
}: {
  readonly title: string;
  readonly description?: string;
  readonly retry?: () => void;
}) {
  return (
    <div
      role="status"
      className="flex min-w-0 flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground"
    >
      <p className="font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-sm break-words">{description}</p> : null}
      {retry ? (
        <Button size="sm" variant="outline" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
