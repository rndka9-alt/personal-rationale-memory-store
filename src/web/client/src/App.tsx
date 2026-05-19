import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createRefinementOpinion,
  fetchReviewQueue,
  fetchReviewQueueDetail,
  submitRefinementOpinionAction,
  submitReviewAction,
  type ReviewQueueFilters
} from "./api/reviewQueue";
import type {
  ProjectContext,
  RefinementOpinion,
  RefinementOpinionAction,
  RefinementOpinionType,
  ReviewAction,
  ReviewQueueItem,
  UsageFeedbackCounts
} from "./types/review";
import { namedStatusColor } from "./theme/tokens";

const reviewStates = [
  { value: "unreviewed", label: "Unreviewed" },
  { value: "needs_revision", label: "Needs revision" },
  { value: "reviewed", label: "Reviewed" },
  { value: "all", label: "All states" }
];

const captureKinds = [
  { value: "", label: "All sources" },
  { value: "auto", label: "Auto" },
  { value: "manual", label: "Manual" },
  { value: "session", label: "Session" }
];

const refinementOpinionTypes: Array<{ value: RefinementOpinionType; label: string }> = [
  { value: "opinion", label: "Opinion" },
  { value: "patch_request", label: "Patch request" },
  { value: "correction", label: "Correction" },
  { value: "question", label: "Question" }
];

const queueSortModes = [
  { value: "priority", label: "Priority" },
  { value: "last_used", label: "Last used" },
  { value: "opinions", label: "Opinions" },
  { value: "positive_feedback", label: "Positive feedback" },
  { value: "negative_feedback", label: "Negative feedback" },
  { value: "uses", label: "Use count" }
];

const queueSignalFilters = [
  { value: "all", label: "All signals" },
  { value: "repair_attention", label: "Repair attention" },
  { value: "with_opinions", label: "Has opinions" },
  { value: "with_negative_feedback", label: "Negative feedback" },
  { value: "with_positive_feedback", label: "Positive feedback" },
  { value: "recently_used", label: "Recently used" }
];

type QueueSortMode = "priority" | "last_used" | "opinions" | "positive_feedback" | "negative_feedback" | "uses";
type QueueSignalFilter = "all" | "repair_attention" | "with_opinions" | "with_negative_feedback" | "with_positive_feedback" | "recently_used";
type PatchInputMode = "fields" | "json";
type PatchFieldValues = {
  title: string;
  situation: string;
  goal: string;
  decision: string;
  rationale: string;
  tradeoff: string;
  reuseWhen: string;
  avoidWhen: string;
};

const emptyPatchFieldValues: PatchFieldValues = {
  title: "",
  situation: "",
  goal: "",
  decision: "",
  rationale: "",
  tradeoff: "",
  reuseWhen: "",
  avoidWhen: ""
};

export function App() {
  const queryClient = useQueryClient();
  const [reviewState, setReviewState] = useState("unreviewed");
  const [captureKind, setCaptureKind] = useState("");
  const [queueSortMode, setQueueSortMode] = useState<QueueSortMode>("priority");
  const [queueSignalFilter, setQueueSignalFilter] = useState<QueueSignalFilter>("all");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [operationMessage, setOperationMessage] = useState<string | undefined>();

  const filters: ReviewQueueFilters = useMemo(() => ({
    captureKind: captureKind.length > 0 ? captureKind : undefined,
    reviewState
  }), [captureKind, reviewState]);

  const queueQuery = useQuery({
    queryKey: ["review-queue", filters],
    queryFn: () => fetchReviewQueue(filters)
  });

  const queueItems = queueQuery.data ?? [];
  const items = useMemo(
    () => sortQueueItems(filterQueueItems(queueItems, queueSignalFilter), queueSortMode),
    [queueItems, queueSignalFilter, queueSortMode]
  );

  useEffect(() => {
    if (selectedId && items.some((item) => item.id === selectedId)) {
      return;
    }

    setSelectedId(items[0]?.id);
  }, [items, selectedId]);

  useEffect(() => {
    setSelectedIds((currentIds) => currentIds.filter((id) => items.some((item) => item.id === id)));
  }, [items]);

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
    mutationFn: (input: { id: string; action: ReviewAction }) => {
      return submitReviewAction({
        id: input.id,
        action: input.action,
        notes,
        reason: notes || "Reviewed from web UI."
      });
    },
    onSuccess: async (_, input) => {
      setNotes("");
      setOperationMessage(formatReviewActionMessage(input.action, 1));
      setSelectedId(findNextQueuedItemId(items, input.id));
      await queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["review-queue-detail"] });
    }
  });

  const bulkReviewMutation = useMutation({
    mutationFn: async (input: { ids: string[]; action: ReviewAction }) => {
      for (const id of input.ids) {
        await submitReviewAction({
          id,
          action: input.action,
          notes,
          reason: notes || "Reviewed from web UI."
        });
      }
      return input.ids.length;
    },
    onSuccess: async (count, input) => {
      setNotes("");
      setSelectedIds([]);
      setOperationMessage(formatReviewActionMessage(input.action, count));
      if (selectedId && input.ids.includes(selectedId)) {
        setSelectedId(findNextQueuedItemIdExcluding(items, input.ids));
      }
      await queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["review-queue-detail"] });
    }
  });

  const refinementOpinionMutation = useMutation({
    mutationFn: (input: { id: string; action: RefinementOpinionAction }) => submitRefinementOpinionAction({
      id: input.id,
      action: input.action,
      note: notes || undefined
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["review-queue-detail"] });
    }
  });

  const createRefinementOpinionMutation = useMutation({
    mutationFn: (input: {
      entryId: string;
      opinionType: RefinementOpinionType;
      body: string;
      suggestedPatch?: Record<string, unknown>;
    }) => createRefinementOpinion(input),
    onSuccess: async () => {
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
          <div className="space-y-3">
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
            <QuickViewControls
              onInbox={() => {
                setReviewState("unreviewed");
                setQueueSignalFilter("all");
                setQueueSortMode("priority");
              }}
              onRepair={() => {
                setReviewState("all");
                setQueueSignalFilter("repair_attention");
                setQueueSortMode("priority");
              }}
              onPromotion={() => {
                setReviewState("reviewed");
                setQueueSignalFilter("all");
                setQueueSortMode("positive_feedback");
              }}
            />
          </div>
        </header>

        <section className="grid min-h-0 flex-1 gap-6 py-6 lg:grid-cols-[380px_minmax(0,1fr)]">
          <QueueList
            items={items}
            selectedId={selectedId}
            isLoading={queueQuery.isLoading}
            error={queueQuery.error}
            sortMode={queueSortMode}
            signalFilter={queueSignalFilter}
            selectedIds={selectedIds}
            isBulkMutating={bulkReviewMutation.isPending}
            bulkError={bulkReviewMutation.error}
            onSortModeChange={setQueueSortMode}
            onSignalFilterChange={setQueueSignalFilter}
            onSelect={setSelectedId}
            onToggleSelection={(id) => setSelectedIds((currentIds) => toggleSelectedId(currentIds, id))}
            onSelectVisible={() => setSelectedIds(items.map((item) => item.id))}
            onClearSelection={() => setSelectedIds([])}
            onBulkAction={(action) => {
              if (selectedIds.length === 0) {
                throw new Error("No selected items.");
              }
              bulkReviewMutation.mutate({ ids: selectedIds, action });
            }}
          />
          <DetailPanel
            item={detailQuery.data}
            isLoading={detailQuery.isLoading}
            error={detailQuery.error}
            notes={notes}
            operationMessage={operationMessage}
            actionError={reviewMutation.error}
            onNotesChange={setNotes}
            onAction={(action) => {
              if (!selectedId) {
                throw new Error("No selected item.");
              }
              reviewMutation.mutate({ id: selectedId, action });
            }}
            isMutating={reviewMutation.isPending}
            onRefinementOpinionAction={(input) => refinementOpinionMutation.mutate(input)}
            isRefinementOpinionMutating={refinementOpinionMutation.isPending}
            onCreateRefinementOpinion={(input) => createRefinementOpinionMutation.mutateAsync(input)}
            isCreatingRefinementOpinion={createRefinementOpinionMutation.isPending}
            createRefinementOpinionError={createRefinementOpinionMutation.error}
          />
        </section>
      </div>
    </main>
  );
}

function QuickViewControls(props: {
  onInbox: () => void;
  onRepair: () => void;
  onPromotion: () => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <SmallControlButton onClick={props.onInbox}>Inbox</SmallControlButton>
      <SmallControlButton onClick={props.onRepair}>Repair</SmallControlButton>
      <SmallControlButton onClick={props.onPromotion}>Promote</SmallControlButton>
    </div>
  );
}

function BulkReviewControls(props: {
  selectedCount: number;
  visibleCount: number;
  isMutating: boolean;
  error: Error | null;
  onSelectVisible: () => void;
  onClearSelection: () => void;
  onBulkAction: (action: ReviewAction) => void;
}) {
  const hasSelection = props.selectedCount > 0;

  return (
    <div className="space-y-2 rounded-md border border-line-base bg-surface-panel p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-ink-muted">{props.selectedCount} selected</span>
        <div className="flex gap-2">
          <button
            type="button"
            className="text-xs font-medium text-action-base disabled:cursor-not-allowed disabled:text-ink-faint"
            disabled={props.visibleCount === 0 || props.isMutating}
            onClick={props.onSelectVisible}
          >
            Select visible
          </button>
          <button
            type="button"
            className="text-xs font-medium text-ink-muted disabled:cursor-not-allowed disabled:text-ink-faint"
            disabled={!hasSelection || props.isMutating}
            onClick={props.onClearSelection}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <SmallControlButton disabled={!hasSelection || props.isMutating} onClick={() => props.onBulkAction("accept")}>Accept</SmallControlButton>
        <SmallControlButton disabled={!hasSelection || props.isMutating} onClick={() => props.onBulkAction("keep_candidate")}>Keep</SmallControlButton>
        <SmallControlButton disabled={!hasSelection || props.isMutating} onClick={() => props.onBulkAction("needs_revision")}>Revise</SmallControlButton>
        <SmallControlButton danger disabled={!hasSelection || props.isMutating} onClick={() => props.onBulkAction("deprecate")}>Deprecate</SmallControlButton>
      </div>
      {props.error ? <p className="text-xs text-danger-base">{props.error.message}</p> : null}
    </div>
  );
}

function QueueList(props: {
  items: ReviewQueueItem[];
  selectedId?: string;
  isLoading: boolean;
  error: Error | null;
  sortMode: QueueSortMode;
  signalFilter: QueueSignalFilter;
  selectedIds: string[];
  isBulkMutating: boolean;
  bulkError: Error | null;
  onSortModeChange: (value: QueueSortMode) => void;
  onSignalFilterChange: (value: QueueSignalFilter) => void;
  onSelect: (id: string) => void;
  onToggleSelection: (id: string) => void;
  onSelectVisible: () => void;
  onClearSelection: () => void;
  onBulkAction: (action: ReviewAction) => void;
}) {
  return (
    <aside className="min-h-0 border-r border-line-base pr-0 lg:pr-6">
      <div className="mb-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-strong">Queued memories</h2>
          <span className="rounded-full bg-surface-subtle px-2 py-1 text-xs text-ink-muted">{props.items.length}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-muted">Sort</span>
            <select
              className="h-9 w-full rounded-md border-line-base bg-surface-panel text-sm text-ink-base shadow-none focus:border-action-base focus:ring-action-base"
              value={props.sortMode}
              onChange={(event) => props.onSortModeChange(readQueueSortMode(event.target.value))}
            >
              {queueSortModes.map((mode) => (
                <option key={mode.value} value={mode.value}>{mode.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-muted">Filter</span>
            <select
              className="h-9 w-full rounded-md border-line-base bg-surface-panel text-sm text-ink-base shadow-none focus:border-action-base focus:ring-action-base"
              value={props.signalFilter}
              onChange={(event) => props.onSignalFilterChange(readQueueSignalFilter(event.target.value))}
            >
              {queueSignalFilters.map((filter) => (
                <option key={filter.value} value={filter.value}>{filter.label}</option>
              ))}
            </select>
          </label>
        </div>
        <BulkReviewControls
          selectedCount={props.selectedIds.length}
          visibleCount={props.items.length}
          isMutating={props.isBulkMutating}
          error={props.bulkError}
          onSelectVisible={props.onSelectVisible}
          onClearSelection={props.onClearSelection}
          onBulkAction={props.onBulkAction}
        />
      </div>

      {props.isLoading ? (
        <p className="text-sm text-ink-muted">Loading queue...</p>
      ) : props.error ? (
        <p className="text-sm text-danger-base">{props.error.message}</p>
      ) : props.items.length === 0 ? (
        <div className="border-t border-line-base py-8 text-sm text-ink-muted">No queued rationale memories match this view.</div>
      ) : (
        <div className="max-h-[calc(100vh-14rem)] overflow-y-auto divide-y divide-line-base border-y border-line-base">
          {props.items.map((item) => (
            <div
              key={item.id}
              className={`flex gap-3 px-1 py-4 transition-colors hover:bg-surface-subtle ${
                props.selectedId === item.id ? "bg-surface-subtle" : "bg-transparent"
              }`}
            >
              <label className="pt-0.5">
                <span className="sr-only">Select {item.title}</span>
                <input
                  type="checkbox"
                  className="rounded border-line-base text-action-base focus:ring-action-base"
                  checked={props.selectedIds.includes(item.id)}
                  onChange={() => props.onToggleSelection(item.id)}
                />
              </label>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => props.onSelect(item.id)}
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="line-clamp-2 text-sm font-medium text-ink-strong">{item.title}</h3>
                  <MetadataPill value={readMetadataString(item.metadata, "capture_kind") ?? "manual"} />
                </div>
                {item.project ? (
                  <p className="mt-2 line-clamp-1 text-xs text-ink-muted">{formatProjectLabel(item.project)}</p>
                ) : null}
                <div className="mt-3 grid grid-cols-4 gap-2 text-xs text-ink-muted">
                  <QueueMetric label="Priority" value={item.reviewPriorityScore.toFixed(1)} />
                  <QueueMetric label="Use count" value={String(item.useCount)} />
                  <QueueMetric label="Last used" value={formatRelativeDate(item.lastUsedAt)} />
                  <QueueMetric label="Opinions" value={String(item.openRefinementOpinionCount)} />
                </div>
                <p className="mt-2 line-clamp-1 text-xs text-ink-faint">{formatPriorityReasons(item.reviewPriorityReasons)}</p>
                <p className="mt-1 line-clamp-1 text-xs text-ink-faint">{formatFeedbackSummary(item.usageFeedback)}</p>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-ink-muted">{item.summary ?? "No summary available."}</p>
                <p className="mt-3 text-xs text-ink-faint">{item.id}</p>
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function SmallControlButton(props: {
  children: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const color = props.danger
    ? "border-danger-base text-danger-base hover:bg-danger-faint"
    : "border-line-strong text-ink-base hover:border-action-base hover:bg-action-faint hover:text-action-base";

  return (
    <button
      type="button"
      className={`h-8 rounded-md border bg-surface-panel px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${color}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function DetailPanel(props: {
  item: Awaited<ReturnType<typeof fetchReviewQueueDetail>> | undefined;
  isLoading: boolean;
  error: Error | null;
  notes: string;
  operationMessage?: string;
  actionError: Error | null;
  onNotesChange: (value: string) => void;
  onAction: (action: ReviewAction) => void;
  isMutating: boolean;
  onRefinementOpinionAction: (input: { id: string; action: RefinementOpinionAction }) => void;
  isRefinementOpinionMutating: boolean;
  onCreateRefinementOpinion: (input: {
    entryId: string;
    opinionType: RefinementOpinionType;
    body: string;
    suggestedPatch?: Record<string, unknown>;
  }) => Promise<void>;
  isCreatingRefinementOpinion: boolean;
  createRefinementOpinionError: Error | null;
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

  const { entry, review, usage, refinementOpinions } = props.item;
  const reviewState = entry.frontmatter.reviewState;

  return (
    <section className="min-w-0">
      <div className="mb-5 flex flex-col gap-3 border-b border-line-base pb-5 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill value={reviewState} />
            <MetadataPill value={entry.frontmatter.acceptanceState} />
            <MetadataPill value={entry.frontmatter.decisionState} />
            <MetadataPill value={readMetadataString(entry.frontmatter.metadata, "capture_kind") ?? "manual"} />
            <MetadataPill value={`score ${review.score}`} />
            <MetadataPill value={`use count ${usage.useCount}`} />
            <MetadataPill value={`opinions ${refinementOpinions.length}`} />
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
          {props.operationMessage ? (
            <div className="rounded-md border border-action-base bg-action-faint px-3 py-2 text-sm text-action-base">
              {props.operationMessage}
            </div>
          ) : null}
          {props.actionError ? (
            <div className="rounded-md border border-danger-base bg-danger-faint px-3 py-2 text-sm text-danger-base">
              {props.actionError.message}
            </div>
          ) : null}
          <ProjectFacts
            project={entry.frontmatter.project}
            source={entry.frontmatter.source}
            scope={entry.frontmatter.scope}
            confidence={entry.frontmatter.confidence}
            acceptanceState={entry.frontmatter.acceptanceState}
            reviewState={entry.frontmatter.reviewState}
            decisionState={entry.frontmatter.decisionState}
            domains={entry.frontmatter.domains}
            intents={entry.frontmatter.intents}
            modes={entry.frontmatter.modes}
            useCount={usage.useCount}
            lastUsedAt={usage.lastUsedAt}
            usageFeedback={usage.feedback}
          />
          <RefinementOpinionList
            opinions={refinementOpinions}
            isMutating={props.isRefinementOpinionMutating}
            onAction={props.onRefinementOpinionAction}
          />
          <CreateRefinementOpinionForm
            entryId={entry.frontmatter.id}
            isMutating={props.isCreatingRefinementOpinion}
            mutationError={props.createRefinementOpinionError}
            onCreate={props.onCreateRefinementOpinion}
          />
          <ReviewFacts title="Missing" items={review.missingSections} tone="warning" />
          <ReviewFacts title="Strengths" items={review.strengths} tone="success" />
          <ReviewFacts title="Cautions" items={review.cautions} tone="danger" />
          <MetadataDetails metadata={entry.frontmatter.metadata} />

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

function QueueMetric(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[0.68rem] font-medium uppercase tracking-wide text-ink-faint">{props.label}</p>
      <p className="mt-0.5 truncate text-xs text-ink-base">{props.value}</p>
    </div>
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

function ProjectFacts(props: {
  project?: ProjectContext;
  source?: { kind: string; ref: string };
  scope: string;
  confidence: number;
  acceptanceState: string;
  reviewState: string;
  decisionState: string;
  domains: string[];
  intents: string[];
  modes: string[];
  useCount: number;
  lastUsedAt?: string;
  usageFeedback: UsageFeedbackCounts;
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Context</h3>
      <div className="space-y-3 text-sm leading-6">
        <MetadataLine label="Project" value={props.project ? formatProjectLabel(props.project) : "Not provided."} />
        <MetadataLine label="Repository" value={props.project?.repo} />
        <MetadataLine label="Root" value={props.project?.root} />
        <MetadataLine label="Scope" value={props.scope} />
        <MetadataLine label="Confidence" value={props.confidence.toFixed(2)} />
        <MetadataLine label="Use count" value={String(props.useCount)} />
        <MetadataLine label="Last used" value={formatDateTime(props.lastUsedAt)} />
        <MetadataLine label="Applied" value={String(props.usageFeedback.appliedCount)} />
        <MetadataLine label="Helpful" value={String(props.usageFeedback.helpfulCount)} />
        <MetadataLine label="Unhelpful" value={String(props.usageFeedback.unhelpfulCount)} />
        <MetadataLine label="Dismissed" value={String(props.usageFeedback.dismissedCount)} />
        <MetadataLine label="Acceptance" value={props.acceptanceState} />
        <MetadataLine label="Review" value={props.reviewState} />
        <MetadataLine label="Decision" value={props.decisionState} />
        <MetadataLine label="Source" value={props.source ? `${props.source.kind}: ${props.source.ref}` : undefined} />
        <MetadataList label="Domains" items={props.domains} />
        <MetadataList label="Intents" items={props.intents} />
        <MetadataList label="Modes" items={props.modes} />
      </div>
    </section>
  );
}

function RefinementOpinionList(props: {
  opinions: RefinementOpinion[];
  isMutating: boolean;
  onAction: (input: { id: string; action: RefinementOpinionAction }) => void;
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Open refinement opinions</h3>
      {props.opinions.length === 0 ? (
        <p className="text-sm text-ink-muted">None</p>
      ) : (
        <div className="space-y-3">
          {props.opinions.map((opinion) => (
            <div key={opinion.id} className="rounded-md border border-line-base bg-surface-panel p-3">
              <div className="flex flex-wrap items-center gap-2">
                <MetadataPill value={opinion.opinionType} />
                <MetadataPill value={opinion.status} />
                <span className="text-xs text-ink-muted">{formatDateTime(opinion.createdAt)}</span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink-base">{opinion.body}</p>
              {opinion.suggestedPatch ? (
                <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-subtle p-3 text-xs leading-5 text-ink-base">
                  {JSON.stringify(opinion.suggestedPatch, null, 2)}
                </pre>
              ) : null}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <ActionButton
                  disabled={props.isMutating}
                  onClick={() => props.onAction({ id: opinion.id, action: "resolve" })}
                >
                  Resolve
                </ActionButton>
                <ActionButton
                  danger
                  disabled={props.isMutating}
                  onClick={() => props.onAction({ id: opinion.id, action: "reject" })}
                >
                  Reject
                </ActionButton>
                {opinion.suggestedPatch ? (
                  <div className="col-span-2">
                    <ActionButton
                      disabled={props.isMutating}
                      onClick={() => props.onAction({ id: opinion.id, action: "apply_patch" })}
                    >
                      Apply patch
                    </ActionButton>
                  </div>
                ) : null}
              </div>
              <p className="mt-3 break-words text-xs text-ink-muted">
                {opinion.sourceRef ? `${opinion.sourceKind}: ${opinion.sourceRef}` : opinion.sourceKind}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CreateRefinementOpinionForm(props: {
  entryId: string;
  isMutating: boolean;
  mutationError: Error | null;
  onCreate: (input: {
    entryId: string;
    opinionType: RefinementOpinionType;
    body: string;
    suggestedPatch?: Record<string, unknown>;
  }) => Promise<void>;
}) {
  const [opinionType, setOpinionType] = useState<RefinementOpinionType>("opinion");
  const [body, setBody] = useState("");
  const [patchInputMode, setPatchInputMode] = useState<PatchInputMode>("fields");
  const [patchFields, setPatchFields] = useState<PatchFieldValues>(emptyPatchFieldValues);
  const [suggestedPatchText, setSuggestedPatchText] = useState("");
  const [formError, setFormError] = useState<string | undefined>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedBody = body.trim();
    if (trimmedBody.length === 0) {
      setFormError("Body is required.");
      return;
    }

    const suggestedPatchResult = parseSuggestedPatchInput(patchInputMode, patchFields, suggestedPatchText);
    if (!suggestedPatchResult.ok) {
      setFormError(suggestedPatchResult.message);
      return;
    }

    setFormError(undefined);
    try {
      await props.onCreate({
        entryId: props.entryId,
        opinionType,
        body: trimmedBody,
        suggestedPatch: suggestedPatchResult.value
      });
      setBody("");
      setPatchFields(emptyPatchFieldValues);
      setSuggestedPatchText("");
    } catch (error) {
      setFormError(formatErrorMessage(error));
    }
  }

  return (
    <form className="space-y-3" onSubmit={handleSubmit}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Add refinement opinion</h3>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-muted">Type</span>
        <select
          className="h-9 w-full rounded-md border-line-base bg-surface-panel text-sm text-ink-base shadow-none focus:border-action-base focus:ring-action-base"
          value={opinionType}
          onChange={(event) => setOpinionType(readRefinementOpinionType(event.target.value))}
        >
          {refinementOpinionTypes.map((type) => (
            <option key={type.value} value={type.value}>{type.label}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-muted">Body</span>
        <textarea
          className="min-h-24 w-full rounded-md border-line-base bg-surface-panel text-sm shadow-none focus:border-action-base focus:ring-action-base"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="What should be clarified, corrected, or patched?"
        />
      </label>
      <div>
        <span className="mb-1 block text-xs font-medium text-ink-muted">Suggested patch</span>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className={patchModeButtonClassName(patchInputMode === "fields")}
            onClick={() => setPatchInputMode("fields")}
          >
            Fields
          </button>
          <button
            type="button"
            className={patchModeButtonClassName(patchInputMode === "json")}
            onClick={() => setPatchInputMode("json")}
          >
            JSON
          </button>
        </div>
      </div>
      {patchInputMode === "fields" ? (
        <PatchFieldsEditor values={patchFields} onChange={setPatchFields} />
      ) : (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-muted">Suggested patch JSON</span>
          <textarea
            className="min-h-24 w-full rounded-md border-line-base bg-surface-panel font-mono text-xs shadow-none focus:border-action-base focus:ring-action-base"
            value={suggestedPatchText}
            onChange={(event) => setSuggestedPatchText(event.target.value)}
            placeholder='{"rationale":"Updated rationale..."}'
          />
        </label>
      )}
      {formError ? <p className="text-sm text-danger-base">{formError}</p> : null}
      {props.mutationError ? <p className="text-sm text-danger-base">{props.mutationError.message}</p> : null}
      <button
        type="submit"
        className="h-9 w-full rounded-md border border-line-strong bg-surface-panel text-sm font-medium text-ink-base transition-colors hover:border-action-base hover:bg-action-faint hover:text-action-base disabled:cursor-not-allowed disabled:opacity-50"
        disabled={props.isMutating}
      >
        Add opinion
      </button>
    </form>
  );
}

function PatchFieldsEditor(props: {
  values: PatchFieldValues;
  onChange: (values: PatchFieldValues) => void;
}) {
  return (
    <div className="space-y-3">
      <PatchTextInput label="Title" value={props.values.title} onChange={(value) => props.onChange({ ...props.values, title: value })} />
      <PatchTextArea label="Situation" value={props.values.situation} onChange={(value) => props.onChange({ ...props.values, situation: value })} />
      <PatchTextArea label="Goal" value={props.values.goal} onChange={(value) => props.onChange({ ...props.values, goal: value })} />
      <PatchTextArea label="Decision" value={props.values.decision} onChange={(value) => props.onChange({ ...props.values, decision: value })} />
      <PatchTextArea label="Rationale" value={props.values.rationale} onChange={(value) => props.onChange({ ...props.values, rationale: value })} />
      <PatchTextArea label="Tradeoff" value={props.values.tradeoff} onChange={(value) => props.onChange({ ...props.values, tradeoff: value })} />
      <PatchTextArea label="Reuse when" value={props.values.reuseWhen} onChange={(value) => props.onChange({ ...props.values, reuseWhen: value })} />
      <PatchTextArea label="Avoid when" value={props.values.avoidWhen} onChange={(value) => props.onChange({ ...props.values, avoidWhen: value })} />
    </div>
  );
}

function PatchTextInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{props.label}</span>
      <input
        className="h-9 w-full rounded-md border-line-base bg-surface-panel text-sm shadow-none focus:border-action-base focus:ring-action-base"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function PatchTextArea(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{props.label}</span>
      <textarea
        className="min-h-20 w-full rounded-md border-line-base bg-surface-panel text-sm shadow-none focus:border-action-base focus:ring-action-base"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function MetadataLine(props: { label: string; value?: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{props.label}</p>
      <p className="break-words text-ink-base">{props.value ?? "Not provided."}</p>
    </div>
  );
}

function MetadataList(props: { label: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{props.label}</p>
      {props.items.length === 0 ? (
        <p className="text-ink-muted">Not provided.</p>
      ) : (
        <div className="mt-1 flex flex-wrap gap-2">
          {props.items.map((item) => <MetadataPill key={item} value={item} />)}
        </div>
      )}
    </div>
  );
}

function MetadataDetails(props: { metadata: Record<string, unknown> }) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-ink-muted">Metadata</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-subtle p-3 text-xs leading-5 text-ink-base">
        {JSON.stringify(props.metadata, null, 2)}
      </pre>
    </details>
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
      className={`h-9 w-full rounded-md border bg-surface-panel text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${color}`}
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

function readQueueSortMode(value: string): QueueSortMode {
  if (
    value === "priority"
    || value === "last_used"
    || value === "opinions"
    || value === "positive_feedback"
    || value === "negative_feedback"
    || value === "uses"
  ) {
    return value;
  }

  throw new Error(`Invalid queue sort mode: ${value}`);
}

function readQueueSignalFilter(value: string): QueueSignalFilter {
  if (
    value === "all"
    || value === "repair_attention"
    || value === "with_opinions"
    || value === "with_negative_feedback"
    || value === "with_positive_feedback"
    || value === "recently_used"
  ) {
    return value;
  }

  throw new Error(`Invalid queue signal filter: ${value}`);
}

function readRefinementOpinionType(value: string): RefinementOpinionType {
  if (value === "opinion" || value === "patch_request" || value === "correction" || value === "question") {
    return value;
  }

  throw new Error(`Invalid refinement opinion type: ${value}`);
}

function filterQueueItems(items: ReviewQueueItem[], signalFilter: QueueSignalFilter) {
  if (signalFilter === "all") {
    return items;
  }

  return items.filter((item) => {
    if (signalFilter === "repair_attention") {
      return item.openRefinementOpinionCount > 0
        || item.usageFeedback.negativeCount > 0
        || item.reviewState === "needs_revision";
    }
    if (signalFilter === "with_opinions") {
      return item.openRefinementOpinionCount > 0;
    }
    if (signalFilter === "with_negative_feedback") {
      return item.usageFeedback.negativeCount > 0;
    }
    if (signalFilter === "with_positive_feedback") {
      return item.usageFeedback.positiveCount > 0;
    }
    return calculateTimestamp(item.lastUsedAt) > 0;
  });
}

function sortQueueItems(items: ReviewQueueItem[], sortMode: QueueSortMode) {
  return items
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((left, right) => {
      const scoreDifference = calculateQueueSortValue(right.item, sortMode) - calculateQueueSortValue(left.item, sortMode);
      return scoreDifference === 0 ? left.originalIndex - right.originalIndex : scoreDifference;
    })
    .map((entry) => entry.item);
}

function calculateQueueSortValue(item: ReviewQueueItem, sortMode: QueueSortMode) {
  if (sortMode === "priority") {
    return item.reviewPriorityScore;
  }
  if (sortMode === "last_used") {
    return calculateTimestamp(item.lastUsedAt);
  }
  if (sortMode === "opinions") {
    return item.openRefinementOpinionCount;
  }
  if (sortMode === "positive_feedback") {
    return item.usageFeedback.positiveCount;
  }
  if (sortMode === "negative_feedback") {
    return item.usageFeedback.negativeCount;
  }
  return item.useCount;
}

function toggleSelectedId(selectedIds: string[], id: string) {
  return selectedIds.includes(id)
    ? selectedIds.filter((selectedId) => selectedId !== id)
    : [...selectedIds, id];
}

function findNextQueuedItemId(items: ReviewQueueItem[], currentId: string) {
  const currentIndex = items.findIndex((item) => item.id === currentId);
  if (currentIndex === -1) {
    return items[0]?.id;
  }

  const nextItem = items[currentIndex + 1] ?? items[currentIndex - 1];
  return nextItem?.id;
}

function findNextQueuedItemIdExcluding(items: ReviewQueueItem[], excludedIds: string[]) {
  return items.find((item) => !excludedIds.includes(item.id))?.id;
}

function formatReviewActionMessage(action: ReviewAction, count: number) {
  const label = action === "accept"
    ? "accepted"
    : action === "keep_candidate"
      ? "kept"
      : action === "needs_revision"
        ? "marked for revision"
        : "deprecated";
  return `${count} item${count === 1 ? "" : "s"} ${label}.`;
}

function calculateTimestamp(value: string | undefined) {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseSuggestedPatchInput(
  mode: PatchInputMode,
  fields: PatchFieldValues,
  jsonValue: string
):
  | { ok: true; value?: Record<string, unknown> }
  | { ok: false; message: string } {
  if (mode === "fields") {
    return { ok: true, value: buildPatchFromFields(fields) };
  }

  const trimmedValue = jsonValue.trim();
  if (trimmedValue.length === 0) {
    return { ok: true };
  }

  try {
    const parsedValue: unknown = JSON.parse(trimmedValue);
    if (!isRecord(parsedValue)) {
      return { ok: false, message: "Suggested patch must be a JSON object." };
    }

    return { ok: true, value: parsedValue };
  } catch (error) {
    return { ok: false, message: formatErrorMessage(error) };
  }
}

function buildPatchFromFields(fields: PatchFieldValues) {
  const patch: Record<string, unknown> = {};
  setPatchString(patch, "title", fields.title);
  setPatchString(patch, "situation", fields.situation);
  setPatchString(patch, "goal", fields.goal);
  setPatchString(patch, "decision", fields.decision);
  setPatchString(patch, "rationale", fields.rationale);
  setPatchString(patch, "tradeoff", fields.tradeoff);
  setPatchStringArray(patch, "reuseWhen", fields.reuseWhen);
  setPatchStringArray(patch, "avoidWhen", fields.avoidWhen);
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function setPatchString(patch: Record<string, unknown>, key: string, value: string) {
  const trimmedValue = value.trim();
  if (trimmedValue.length > 0) {
    patch[key] = trimmedValue;
  }
}

function setPatchStringArray(patch: Record<string, unknown>, key: string, value: string) {
  const items = value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length > 0) {
    patch[key] = items;
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patchModeButtonClassName(isActive: boolean) {
  const activeClass = isActive
    ? "border-action-base bg-action-faint text-action-base"
    : "border-line-strong bg-surface-panel text-ink-base hover:border-action-base hover:bg-action-faint hover:text-action-base";
  return `h-9 rounded-md border text-sm font-medium transition-colors ${activeClass}`;
}

function formatProjectLabel(project: ProjectContext) {
  return project.repo ? `${project.name} (${project.repo})` : project.name;
}

function formatRelativeDate(value: string | undefined) {
  if (!value) {
    return "Never";
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Invalid";
  }

  const ageMs = Date.now() - timestamp;
  if (ageMs < 0) {
    return "Future";
  }

  const ageMinutes = Math.floor(ageMs / (1000 * 60));
  if (ageMinutes < 1) {
    return "Now";
  }
  if (ageMinutes < 60) {
    return `${ageMinutes}m`;
  }

  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) {
    return `${ageHours}h`;
  }

  const ageDays = Math.floor(ageHours / 24);
  return `${ageDays}d`;
}

function formatDateTime(value: string | undefined) {
  if (!value) {
    return "Not used yet.";
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "Invalid date.";
  }

  return date.toLocaleString();
}

function formatPriorityReasons(reasons: string[]) {
  return reasons.length > 0 ? reasons.join(" / ") : "standard-candidate";
}

function formatFeedbackSummary(feedback: UsageFeedbackCounts) {
  return `feedback +${feedback.positiveCount} / -${feedback.negativeCount}`;
}
