import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchReviewQueue,
  fetchReviewQueueDetail,
  submitReviewAction,
  type ReviewQueueFilters,
  type ReviewQueueSignalFilter,
  type ReviewQueueSortMode
} from "./api/reviewQueue";
import {
  archiveNote,
  fetchNotes,
  restoreNote,
  type NoteSortMode
} from "./api/notes";
import type { NoteRecord } from "./types/note";
import type { Pagination } from "./types/pagination";
import type {
  ProjectContext,
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

const queueSortModes = [
  { value: "created", label: "Newest" },
  { value: "priority", label: "Priority" },
  { value: "last_used", label: "Last used" },
  { value: "positive_feedback", label: "Positive feedback" },
  { value: "negative_feedback", label: "Negative feedback" },
  { value: "uses", label: "Use count" }
];

const queueSignalFilters = [
  { value: "all", label: "All signals" },
  { value: "repair_attention", label: "Repair attention" },
  { value: "with_negative_feedback", label: "Negative feedback" },
  { value: "with_positive_feedback", label: "Positive feedback" },
  { value: "recently_used", label: "Recently used" }
];

const noteSortModes = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" }
];

type MainView = "review" | "notes";

const pageSize = 25;
const searchDebounceMilliseconds = 300;

function useDebouncedValue(value: string, delayMilliseconds: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    // 검색어를 입력하는 동안 매 키 입력마다 서버 조회가 발생하지 않도록 짧게 지연한다.
    const timeout = window.setTimeout(() => setDebouncedValue(value.trim()), delayMilliseconds);
    return () => window.clearTimeout(timeout);
  }, [delayMilliseconds, value]);

  return debouncedValue;
}

export function App() {
  const queryClient = useQueryClient();
  const [reviewState, setReviewState] = useState("unreviewed");
  const [captureKind, setCaptureKind] = useState("");
  const [queueSortMode, setQueueSortMode] = useState<ReviewQueueSortMode>("created");
  const [queueSignalFilter, setQueueSignalFilter] = useState<ReviewQueueSignalFilter>("all");
  const [queueSearchInput, setQueueSearchInput] = useState("");
  const [queuePage, setQueuePage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [operationMessage, setOperationMessage] = useState<string | undefined>();
  const [mainView, setMainView] = useState<MainView>("review");
  const [includeArchivedNotes, setIncludeArchivedNotes] = useState(false);
  const [noteSortMode, setNoteSortMode] = useState<NoteSortMode>("newest");
  const [noteSearchInput, setNoteSearchInput] = useState("");
  const [notePage, setNotePage] = useState(1);
  const queueSearch = useDebouncedValue(queueSearchInput, searchDebounceMilliseconds);
  const noteSearch = useDebouncedValue(noteSearchInput, searchDebounceMilliseconds);

  const filters: ReviewQueueFilters = useMemo(() => ({
    captureKind: captureKind.length > 0 ? captureKind : undefined,
    reviewState,
    search: queueSearch.length > 0 ? queueSearch : undefined,
    sortMode: queueSortMode,
    signalFilter: queueSignalFilter,
    page: queuePage,
    pageSize
  }), [captureKind, queuePage, queueSearch, queueSignalFilter, queueSortMode, reviewState]);

  const queueQuery = useQuery({
    queryKey: ["review-queue", filters],
    queryFn: () => fetchReviewQueue(filters)
  });

  const notesQuery = useQuery({
    queryKey: ["notes", includeArchivedNotes, notePage, noteSearch, noteSortMode],
    queryFn: () => fetchNotes({
      includeArchived: includeArchivedNotes,
      search: noteSearch.length > 0 ? noteSearch : undefined,
      sortMode: noteSortMode,
      page: notePage,
      pageSize
    }),
    enabled: mainView === "notes"
  });

  const items = queueQuery.data?.items ?? [];

  useEffect(() => {
    const currentPage = queueQuery.data?.pagination.page;
    if (currentPage !== undefined && currentPage !== queuePage) {
      setQueuePage(currentPage);
    }
  }, [queuePage, queueQuery.data?.pagination.page]);

  useEffect(() => {
    const currentPage = notesQuery.data?.pagination.page;
    if (currentPage !== undefined && currentPage !== notePage) {
      setNotePage(currentPage);
    }
  }, [notePage, notesQuery.data?.pagination.page]);

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

  const archiveNoteMutation = useMutation({
    mutationFn: archiveNote,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["notes"] });
    }
  });

  const restoreNoteMutation = useMutation({
    mutationFn: restoreNote,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["notes"] });
    }
  });

  return (
    <main className="min-h-screen bg-surface-page text-ink-base">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 py-5 lg:px-8">
        <header className="flex flex-col gap-5 border-b border-line-base pb-5 md:flex-row md:items-end md:justify-between">
          <div className="space-y-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Rationale Memory Store</p>
            <h1 className="text-2xl font-semibold text-ink-strong">{mainView === "review" ? "Review Queue" : "Notes"}</h1>
            <ViewSwitch value={mainView} onChange={setMainView} />
          </div>
          {mainView === "review" ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:flex sm:items-center">
                <label className="text-sm">
                  <span className="mb-1 block text-xs font-medium text-ink-muted">State</span>
                  <select
                    className="h-9 rounded-md border-line-base bg-surface-panel text-sm text-ink-base shadow-none focus:border-action-base focus:ring-action-base"
                    value={reviewState}
                    onChange={(event) => {
                      setReviewState(event.target.value);
                      setQueuePage(1);
                    }}
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
                    onChange={(event) => {
                      setCaptureKind(event.target.value);
                      setQueuePage(1);
                    }}
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
                  setQueueSortMode("created");
                  setQueuePage(1);
                }}
                onRepair={() => {
                  setReviewState("all");
                  setQueueSignalFilter("repair_attention");
                  setQueueSortMode("priority");
                  setQueuePage(1);
                }}
                onPromotion={() => {
                  setReviewState("reviewed");
                  setQueueSignalFilter("all");
                  setQueueSortMode("positive_feedback");
                  setQueuePage(1);
                }}
              />
            </div>
          ) : (
            <label className="flex items-center gap-2 text-sm font-medium text-ink-base">
              <input
                type="checkbox"
                className="rounded border-line-base text-action-base focus:ring-action-base"
                checked={includeArchivedNotes}
                onChange={(event) => {
                  setIncludeArchivedNotes(event.target.checked);
                  setNotePage(1);
                }}
              />
              Include archived
            </label>
          )}
        </header>

        {mainView === "review" ? (
          <section className="grid min-h-0 flex-1 gap-6 py-6 lg:grid-cols-[380px_minmax(0,1fr)]">
            <QueueList
              items={items}
              selectedId={selectedId}
              isLoading={queueQuery.isLoading}
              error={queueQuery.error}
              pagination={queueQuery.data?.pagination}
              search={queueSearchInput}
              sortMode={queueSortMode}
              signalFilter={queueSignalFilter}
              selectedIds={selectedIds}
              isBulkMutating={bulkReviewMutation.isPending}
              bulkError={bulkReviewMutation.error}
              onSearchChange={(value) => {
                setQueueSearchInput(value);
                setQueuePage(1);
              }}
              onSortModeChange={(value) => {
                setQueueSortMode(value);
                setQueuePage(1);
              }}
              onSignalFilterChange={(value) => {
                setQueueSignalFilter(value);
                setQueuePage(1);
              }}
              onPageChange={setQueuePage}
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
            />
          </section>
        ) : (
          <NotesView
            notes={notesQuery.data?.notes ?? []}
            isLoading={notesQuery.isLoading}
            error={notesQuery.error}
            pagination={notesQuery.data?.pagination}
            search={noteSearchInput}
            sortMode={noteSortMode}
            actionError={archiveNoteMutation.error ?? restoreNoteMutation.error}
            isMutating={archiveNoteMutation.isPending || restoreNoteMutation.isPending}
            onSearchChange={(value) => {
              setNoteSearchInput(value);
              setNotePage(1);
            }}
            onSortModeChange={(value) => {
              setNoteSortMode(value);
              setNotePage(1);
            }}
            onPageChange={setNotePage}
            onArchive={(id) => archiveNoteMutation.mutate(id)}
            onRestore={(id) => restoreNoteMutation.mutate(id)}
          />
        )}
      </div>
    </main>
  );
}

function ViewSwitch(props: {
  value: MainView;
  onChange: (value: MainView) => void;
}) {
  return (
    <div className="inline-grid grid-cols-2 rounded-md border border-line-base bg-surface-panel p-1">
      <button
        type="button"
        className={viewSwitchButtonClassName(props.value === "review")}
        onClick={() => props.onChange("review")}
      >
        Review
      </button>
      <button
        type="button"
        className={viewSwitchButtonClassName(props.value === "notes")}
        onClick={() => props.onChange("notes")}
      >
        Notes
      </button>
    </div>
  );
}

function NotesView(props: {
  notes: NoteRecord[];
  isLoading: boolean;
  error: Error | null;
  pagination?: Pagination;
  search: string;
  sortMode: NoteSortMode;
  actionError: Error | null;
  isMutating: boolean;
  onSearchChange: (value: string) => void;
  onSortModeChange: (value: NoteSortMode) => void;
  onPageChange: (page: number) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  return (
    <section className="min-h-0 flex-1 py-6">
      <div className="mb-4 flex flex-col gap-3 border-b border-line-base pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-ink-strong">Stored notes</h2>
          <p className="mt-1 text-xs text-ink-muted">{props.pagination?.totalItems ?? 0} matching notes</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <SearchField
            value={props.search}
            placeholder="Search title or body"
            label="Search notes"
            onChange={props.onSearchChange}
          />
          <label className="text-sm">
            <span className="sr-only">Sort notes</span>
            <select
              className="h-9 rounded-md border-line-base bg-surface-panel text-sm text-ink-base shadow-none focus:border-action-base focus:ring-action-base"
              value={props.sortMode}
              onChange={(event) => props.onSortModeChange(readNoteSortMode(event.target.value))}
            >
              {noteSortModes.map((mode) => (
                <option key={mode.value} value={mode.value}>{mode.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {props.actionError ? <p className="mb-4 text-sm text-danger-base">{props.actionError.message}</p> : null}

      {props.isLoading ? (
        <p className="text-sm text-ink-muted">Loading notes...</p>
      ) : props.error ? (
        <p className="text-sm text-danger-base">{props.error.message}</p>
      ) : props.notes.length === 0 ? (
        <div className="border-y border-line-base py-8 text-sm text-ink-muted">No notes match this view.</div>
      ) : (
        <div className="divide-y divide-line-base border-y border-line-base">
          {props.notes.map((note) => (
            <article key={note.id} className="grid gap-4 py-4 md:grid-cols-[minmax(0,1fr)_160px]">
              <div className="min-w-0">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <StatusPill value={note.archived ? "archived" : "active"} />
                  <MetadataPill value={`score ${note.upvotes - note.downvotes}`} />
                  <MetadataPill value={`up ${note.upvotes}`} />
                  <MetadataPill value={`down ${note.downvotes}`} />
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-ink-base">{note.content}</p>
                <NoteSourceContext note={note} />
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
                  <span>{note.id}</span>
                  <span>Created {formatRelativeDate(note.createdAt)}</span>
                  <span>Updated {formatRelativeDate(note.updatedAt)}</span>
                </div>
              </div>
              <div className="flex items-start md:justify-end">
                {note.archived ? (
                  <SmallControlButton disabled={props.isMutating} onClick={() => props.onRestore(note.id)}>Restore</SmallControlButton>
                ) : (
                  <SmallControlButton danger disabled={props.isMutating} onClick={() => props.onArchive(note.id)}>Archive</SmallControlButton>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {props.pagination ? (
        <PaginationControls
          pagination={props.pagination}
          disabled={props.isLoading}
          onPageChange={props.onPageChange}
        />
      ) : null}
    </section>
  );
}

function NoteSourceContext(props: { note: NoteRecord }) {
  if (!props.note.topic && !props.note.sourceConversation) {
    return null;
  }

  return (
    <details className="mt-3 border-l border-line-base pl-3 text-xs text-ink-muted">
      <summary className="cursor-pointer select-none text-ink-muted">Source context</summary>
      <div className="mt-2 space-y-2">
        {props.note.topic ? (
          <p>
            <span className="font-medium text-ink-strong">Topic</span>
            <span className="ml-2">{props.note.topic}</span>
          </p>
        ) : null}
        {props.note.sourceConversation ? (
          <div className="space-y-2">
            {props.note.sourceConversation.messages.map((message, index) => (
              <div key={`${message.role}-${index}`}>
                <span className="font-medium text-ink-strong">{message.role}</span>
                <p className="mt-1 whitespace-pre-wrap break-words leading-5">{message.text}</p>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </details>
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
  pagination?: Pagination;
  search: string;
  sortMode: ReviewQueueSortMode;
  signalFilter: ReviewQueueSignalFilter;
  selectedIds: string[];
  isBulkMutating: boolean;
  bulkError: Error | null;
  onSearchChange: (value: string) => void;
  onSortModeChange: (value: ReviewQueueSortMode) => void;
  onSignalFilterChange: (value: ReviewQueueSignalFilter) => void;
  onPageChange: (page: number) => void;
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
          <span className="rounded-full bg-surface-subtle px-2 py-1 text-xs text-ink-muted">
            {props.pagination?.totalItems ?? 0}
          </span>
        </div>
        <SearchField
          value={props.search}
          placeholder="Search title or body"
          label="Search memories"
          onChange={props.onSearchChange}
        />
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
                  <QueueMetric label="Feedback" value={formatFeedbackScore(item.usageFeedback)} />
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
      {props.pagination ? (
        <PaginationControls
          pagination={props.pagination}
          disabled={props.isLoading}
          onPageChange={props.onPageChange}
        />
      ) : null}
    </aside>
  );
}

function SearchField(props: {
  value: string;
  label: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="sr-only">{props.label}</span>
      <input
        type="search"
        className="h-9 w-full rounded-md border-line-base bg-surface-panel text-sm text-ink-base shadow-none placeholder:text-ink-faint focus:border-action-base focus:ring-action-base"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function PaginationControls(props: {
  pagination: Pagination;
  disabled: boolean;
  onPageChange: (page: number) => void;
}) {
  const firstItem = props.pagination.totalItems === 0
    ? 0
    : (props.pagination.page - 1) * props.pagination.pageSize + 1;
  const lastItem = Math.min(
    props.pagination.page * props.pagination.pageSize,
    props.pagination.totalItems
  );

  return (
    <nav className="mt-4 flex items-center justify-between gap-3 text-xs text-ink-muted" aria-label="Pagination">
      <span>{firstItem}-{lastItem} of {props.pagination.totalItems}</span>
      <div className="flex items-center gap-2">
        <SmallControlButton
          disabled={props.disabled || props.pagination.page <= 1}
          onClick={() => props.onPageChange(props.pagination.page - 1)}
        >
          Previous
        </SmallControlButton>
        <span className="min-w-16 text-center">
          {props.pagination.page} / {props.pagination.totalPages}
        </span>
        <SmallControlButton
          disabled={props.disabled || props.pagination.page >= props.pagination.totalPages}
          onClick={() => props.onPageChange(props.pagination.page + 1)}
        >
          Next
        </SmallControlButton>
      </div>
    </nav>
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

  const { entry, review, usage } = props.item;
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
          <Section title="Goal">{entry.goal}</Section>
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
            type={entry.frontmatter.type}
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
  type: string;
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
        <MetadataLine label="Type" value={props.type} />
        <MetadataLine label="Scope" value={props.scope} />
        <MetadataLine label="Confidence" value={props.confidence.toFixed(2)} />
        <MetadataLine label="Use count" value={String(props.useCount)} />
        <MetadataLine label="Last used" value={formatDateTime(props.lastUsedAt)} />
        <MetadataLine label="Positive feedback" value={String(props.usageFeedback.positiveCount)} />
        <MetadataLine label="Negative feedback" value={String(props.usageFeedback.negativeCount)} />
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
    || props.value === "active"
    ? namedStatusColor.reviewed
    : props.value === "needs_revision"
      ? namedStatusColor.needs_revision
      : props.value === "archived" || props.value === "deprecated"
        ? namedStatusColor.deprecated
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

function readQueueSortMode(value: string): ReviewQueueSortMode {
  if (
    value === "priority"
    || value === "created"
    || value === "last_used"
    || value === "positive_feedback"
    || value === "negative_feedback"
    || value === "uses"
  ) {
    return value;
  }

  throw new Error(`Invalid queue sort mode: ${value}`);
}

function readQueueSignalFilter(value: string): ReviewQueueSignalFilter {
  if (
    value === "all"
    || value === "repair_attention"
    || value === "with_negative_feedback"
    || value === "with_positive_feedback"
    || value === "recently_used"
  ) {
    return value;
  }

  throw new Error(`Invalid queue signal filter: ${value}`);
}

function readNoteSortMode(value: string): NoteSortMode {
  if (value === "newest" || value === "oldest") {
    return value;
  }

  throw new Error(`Invalid notes sort mode: ${value}`);
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

function viewSwitchButtonClassName(isActive: boolean) {
  const activeClass = isActive
    ? "bg-action-faint text-action-base"
    : "text-ink-muted hover:bg-surface-subtle hover:text-ink-base";
  return `h-8 rounded px-3 text-xs font-medium transition-colors ${activeClass}`;
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

function formatFeedbackScore(feedback: UsageFeedbackCounts) {
  return `+${feedback.positiveCount} / -${feedback.negativeCount}`;
}
