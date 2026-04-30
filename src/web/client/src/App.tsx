import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchReviewQueue,
  fetchReviewQueueDetail,
  submitReviewAction,
  type ReviewQueueFilters
} from "./api/reviewQueue";
import type { ReviewAction, ReviewQueueItem } from "./types/review";
import { namedStatusColor } from "./theme/tokens";

const reviewStates = [
  { value: "unreviewed", label: "Unreviewed" },
  { value: "needs_revision", label: "Needs revision" },
  { value: "reviewed", label: "Reviewed" }
];

const captureKinds = [
  { value: "", label: "All sources" },
  { value: "auto", label: "Auto" },
  { value: "manual", label: "Manual" },
  { value: "session", label: "Session" }
];

export function App() {
  const queryClient = useQueryClient();
  const [reviewState, setReviewState] = useState("unreviewed");
  const [captureKind, setCaptureKind] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [notes, setNotes] = useState("");

  const filters: ReviewQueueFilters = useMemo(() => ({
    limit: 30,
    captureKind: captureKind.length > 0 ? captureKind : undefined,
    reviewState
  }), [captureKind, reviewState]);

  const queueQuery = useQuery({
    queryKey: ["review-queue", filters],
    queryFn: () => fetchReviewQueue(filters)
  });

  const items = queueQuery.data ?? [];

  useEffect(() => {
    if (selectedId && items.some((item) => item.id === selectedId)) {
      return;
    }

    setSelectedId(items[0]?.id);
  }, [items, selectedId]);

  const detailQuery = useQuery({
    queryKey: ["review-queue-detail", selectedId],
    queryFn: () => {
      if (!selectedId) {
        throw new Error("No selected item.");
      }
      return fetchReviewQueueDetail(selectedId);
    },
    enabled: Boolean(selectedId)
  });

  const reviewMutation = useMutation({
    mutationFn: (action: ReviewAction) => {
      if (!selectedId) {
        throw new Error("No selected item.");
      }

      return submitReviewAction({
        id: selectedId,
        action,
        notes,
        reason: notes || "Reviewed from web UI."
      });
    },
    onSuccess: async () => {
      setNotes("");
      await queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["review-queue-detail"] });
    }
  });

  return (
    <main className="min-h-screen bg-surface-page text-ink-base">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 py-5 lg:px-8">
        <header className="flex flex-col gap-5 border-b border-line-base pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Rationale Memory Store</p>
            <h1 className="mt-2 text-2xl font-semibold text-ink-strong">Review Queue</h1>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:flex sm:items-center">
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-ink-muted">State</span>
              <select
                className="h-9 rounded-md border-line-base bg-surface-panel text-sm text-ink-base shadow-none focus:border-action-base focus:ring-action-base"
                value={reviewState}
                onChange={(event) => setReviewState(event.target.value)}
              >
                {reviewStates.map((state) => (
                  <option key={state.value} value={state.value}>{state.label}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-ink-muted">Source</span>
              <select
                className="h-9 rounded-md border-line-base bg-surface-panel text-sm text-ink-base shadow-none focus:border-action-base focus:ring-action-base"
                value={captureKind}
                onChange={(event) => setCaptureKind(event.target.value)}
              >
                {captureKinds.map((kind) => (
                  <option key={kind.value} value={kind.value}>{kind.label}</option>
                ))}
              </select>
            </label>
          </div>
        </header>

        <section className="grid min-h-0 flex-1 gap-6 py-6 lg:grid-cols-[380px_minmax(0,1fr)]">
          <QueueList
            items={items}
            selectedId={selectedId}
            isLoading={queueQuery.isLoading}
            error={queueQuery.error}
            onSelect={setSelectedId}
          />
          <DetailPanel
            item={detailQuery.data}
            isLoading={detailQuery.isLoading}
            error={detailQuery.error}
            notes={notes}
            onNotesChange={setNotes}
            onAction={(action) => reviewMutation.mutate(action)}
            isMutating={reviewMutation.isPending}
          />
        </section>
      </div>
    </main>
  );
}

function QueueList(props: {
  items: ReviewQueueItem[];
  selectedId?: string;
  isLoading: boolean;
  error: Error | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="min-h-0 border-r border-line-base pr-0 lg:pr-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-strong">Queued memories</h2>
        <span className="rounded-full bg-surface-subtle px-2 py-1 text-xs text-ink-muted">{props.items.length}</span>
      </div>

      {props.isLoading ? (
        <p className="text-sm text-ink-muted">Loading queue...</p>
      ) : props.error ? (
        <p className="text-sm text-danger-base">{props.error.message}</p>
      ) : props.items.length === 0 ? (
        <div className="border-t border-line-base py-8 text-sm text-ink-muted">No queued rationale memories match this view.</div>
      ) : (
        <div className="divide-y divide-line-base border-y border-line-base">
          {props.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`block w-full px-1 py-4 text-left transition-colors hover:bg-surface-subtle ${
                props.selectedId === item.id ? "bg-surface-subtle" : "bg-transparent"
              }`}
              onClick={() => props.onSelect(item.id)}
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="line-clamp-2 text-sm font-medium text-ink-strong">{item.title}</h3>
                <MetadataPill value={readMetadataString(item.metadata, "capture_kind") ?? "manual"} />
              </div>
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-ink-muted">{item.summary ?? "No summary available."}</p>
              <p className="mt-3 text-xs text-ink-faint">{item.id}</p>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

function DetailPanel(props: {
  item: Awaited<ReturnType<typeof fetchReviewQueueDetail>> | undefined;
  isLoading: boolean;
  error: Error | null;
  notes: string;
  onNotesChange: (value: string) => void;
  onAction: (action: ReviewAction) => void;
  isMutating: boolean;
}) {
  if (props.isLoading) {
    return <section className="text-sm text-ink-muted">Loading detail...</section>;
  }

  if (props.error) {
    return <section className="text-sm text-danger-base">{props.error.message}</section>;
  }

  if (!props.item) {
    return <section className="text-sm text-ink-muted">Select a rationale memory to review.</section>;
  }

  const { entry, review } = props.item;
  const reviewState = readMetadataString(entry.frontmatter.metadata, "review_state") ?? "unreviewed";

  return (
    <section className="min-w-0">
      <div className="mb-5 flex flex-col gap-3 border-b border-line-base pb-5 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill value={reviewState} />
            <MetadataPill value={readMetadataString(entry.frontmatter.metadata, "capture_kind") ?? "manual"} />
            <MetadataPill value={`score ${review.score}`} />
          </div>
          <h2 className="mt-3 text-xl font-semibold text-ink-strong">{entry.title}</h2>
          <p className="mt-2 text-sm text-ink-muted">{entry.frontmatter.id}</p>
        </div>
        <p className="text-sm text-ink-muted">Recommendation: <span className="font-medium text-ink-strong">{review.recommendation}</span></p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <article className="space-y-6">
          <Section title="Rationale">{entry.rationale}</Section>
          <Section title="Situation">{entry.situation}</Section>
          <Section title="Decision">{entry.decision}</Section>
          <ListSection title="Constraints" items={entry.constraints} />
          <Section title="Tradeoff">{entry.tradeoff}</Section>
          <ListSection title="Reuse when" items={entry.reuseWhen} />
          <ListSection title="Avoid when" items={entry.avoidWhen} />
          <RejectedAlternatives items={entry.rejectedAlternatives} />
        </article>

        <aside className="space-y-5 border-t border-line-base pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
          <ReviewFacts title="Missing" items={review.missingSections} tone="warning" />
          <ReviewFacts title="Strengths" items={review.strengths} tone="success" />
          <ReviewFacts title="Cautions" items={review.cautions} tone="danger" />

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-ink-strong">Review notes</span>
            <textarea
              className="min-h-28 w-full rounded-md border-line-base bg-surface-panel text-sm shadow-none focus:border-action-base focus:ring-action-base"
              value={props.notes}
              onChange={(event) => props.onNotesChange(event.target.value)}
              placeholder="Optional note for this review action"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <ActionButton disabled={props.isMutating} onClick={() => props.onAction("accept")}>Accept</ActionButton>
            <ActionButton disabled={props.isMutating} onClick={() => props.onAction("keep_candidate")}>Keep</ActionButton>
            <ActionButton disabled={props.isMutating} onClick={() => props.onAction("needs_revision")}>Revise</ActionButton>
            <ActionButton danger disabled={props.isMutating} onClick={() => props.onAction("deprecate")}>Deprecate</ActionButton>
          </div>
        </aside>
      </div>
    </section>
  );
}

function Section(props: { title: string; children?: string }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">{props.title}</h3>
      <p className="whitespace-pre-wrap text-sm leading-6 text-ink-base">{props.children || "Not provided."}</p>
    </section>
  );
}

function ListSection(props: { title: string; items: string[] }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">{props.title}</h3>
      {props.items.length === 0 ? (
        <p className="text-sm text-ink-muted">Not provided.</p>
      ) : (
        <ul className="space-y-2 text-sm leading-6 text-ink-base">
          {props.items.map((item) => <li key={item}>- {item}</li>)}
        </ul>
      )}
    </section>
  );
}

function RejectedAlternatives(props: { items: Array<{ option: string; reason: string }> }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Rejected alternatives</h3>
      {props.items.length === 0 ? (
        <p className="text-sm text-ink-muted">Not provided.</p>
      ) : (
        <div className="space-y-3">
          {props.items.map((item) => (
            <div key={`${item.option}:${item.reason}`} className="border-l border-line-strong pl-3">
              <p className="text-sm font-medium text-ink-strong">{item.option}</p>
              <p className="mt-1 text-sm leading-6 text-ink-muted">{item.reason}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ReviewFacts(props: { title: string; items: string[]; tone: "warning" | "success" | "danger" }) {
  const toneClass = props.tone === "success"
    ? "bg-success-faint text-success-base"
    : props.tone === "warning"
      ? "bg-warning-faint text-warning-base"
      : "bg-danger-faint text-danger-base";

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">{props.title}</h3>
      {props.items.length === 0 ? (
        <p className="text-sm text-ink-muted">None</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {props.items.map((item) => (
            <span key={item} className={`rounded-full px-2 py-1 text-xs font-medium ${toneClass}`}>{item}</span>
          ))}
        </div>
      )}
    </section>
  );
}

function StatusPill(props: { value: string }) {
  const className = props.value === "reviewed"
    ? namedStatusColor.reviewed
    : props.value === "needs_revision"
      ? namedStatusColor.needs_revision
      : namedStatusColor.unreviewed;

  return <span className={`rounded-full px-2 py-1 text-xs font-medium ${className}`}>{props.value}</span>;
}

function MetadataPill(props: { value: string }) {
  return <span className="rounded-full bg-surface-subtle px-2 py-1 text-xs font-medium text-ink-muted">{props.value}</span>;
}

function ActionButton(props: {
  children: string;
  danger?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const color = props.danger
    ? "border-danger-base text-danger-base hover:bg-danger-faint"
    : "border-line-strong text-ink-base hover:border-action-base hover:bg-action-faint hover:text-action-base";

  return (
    <button
      type="button"
      className={`h-9 rounded-md border bg-surface-panel text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${color}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function readMetadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

