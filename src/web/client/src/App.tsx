import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchMemories,
  type MemoryCatalogItem,
  type MemoryCatalogSortMode,
  type MemoryCatalogStatus
} from "./api/memories";
import {
  archiveNote,
  fetchNotes,
  restoreNote,
  type NoteSortMode
} from "./api/notes";
import { fetchReviewQueueDetail, submitReviewAction } from "./api/reviewQueue";
import { MarkdownContent } from "./components/MarkdownContent";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MemoryIcon,
  NoteIcon,
  RestoreIcon,
  SearchIcon,
  XIcon
} from "./components/Icons";
import type { NoteRecord } from "./types/note";
import type { Pagination } from "./types/pagination";
import type { ProjectContext, UsageFeedbackCounts } from "./types/review";

type MainView = "memories" | "notes";

type ToastState = {
  message: string;
};

const pageSize = 25;
const searchDebounceMilliseconds = 300;

const memoryStatuses: Array<{ value: MemoryCatalogStatus; label: string }> = [
  { value: "current", label: "Current" },
  { value: "deprecated", label: "Deprecated" },
  { value: "all", label: "All" }
];

const memorySortModes: Array<{ value: MemoryCatalogSortMode; label: string }> = [
  { value: "created", label: "Recently added" },
  { value: "last_used", label: "Recently used" },
  { value: "uses", label: "Most used" }
];

const noteSortModes: Array<{ value: NoteSortMode; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" }
];

function useDebouncedValue(value: string, delayMilliseconds: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    // 검색 중인 미완성 문자열이 매 키 입력마다 서버 쿼리가 되는 것을 피한다.
    const timeout = window.setTimeout(() => setDebouncedValue(value.trim()), delayMilliseconds);
    return () => window.clearTimeout(timeout);
  }, [delayMilliseconds, value]);

  return debouncedValue;
}

export function App() {
  const [mainView, setMainView] = useState<MainView>("memories");

  return (
    <main className="min-h-screen bg-canvas text-ink">
      <AppHeader mainView={mainView} onViewChange={setMainView} />
      {mainView === "memories" ? <MemoryLibrary /> : <NotesLibrary />}
    </main>
  );
}

function AppHeader(props: {
  mainView: MainView;
  onViewChange: (view: MainView) => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-stroke bg-white/95 backdrop-blur-md">
      <div className="mx-auto flex h-[4.5rem] max-w-[1500px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-ink text-sm font-semibold tracking-[-0.04em] text-white">
            M
          </span>
          <div>
            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted">Rationale</p>
            <p className="text-sm font-semibold tracking-[-0.02em] text-ink">Memory</p>
          </div>
        </div>
        <nav className="flex items-center rounded-full bg-canvas p-1" aria-label="Main navigation">
          <NavigationButton
            active={props.mainView === "memories"}
            icon={<MemoryIcon className="h-4 w-4" />}
            label="Memories"
            onClick={() => props.onViewChange("memories")}
          />
          <NavigationButton
            active={props.mainView === "notes"}
            icon={<NoteIcon className="h-4 w-4" />}
            label="Notes"
            onClick={() => props.onViewChange("notes")}
          />
        </nav>
      </div>
    </header>
  );
}

function NavigationButton(props: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold transition-all sm:px-4 ${
        props.active ? "bg-white text-ink shadow-soft" : "text-muted hover:text-ink"
      }`}
      aria-current={props.active ? "page" : undefined}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function MemoryLibrary() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<MemoryCatalogStatus>("current");
  const [sortMode, setSortMode] = useState<MemoryCatalogSortMode>("created");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | undefined>();
  const search = useDebouncedValue(searchInput, searchDebounceMilliseconds);

  const filters = useMemo(() => ({
    status,
    sortMode,
    search: search.length > 0 ? search : undefined,
    page,
    pageSize
  }), [page, search, sortMode, status]);

  const memoriesQuery = useQuery({
    queryKey: ["memories", filters],
    queryFn: () => fetchMemories(filters)
  });
  const entries = memoriesQuery.data?.entries ?? [];

  useEffect(() => {
    const responsePage = memoriesQuery.data?.pagination.page;
    if (responsePage !== undefined && responsePage !== page) {
      setPage(responsePage);
    }
  }, [memoriesQuery.data?.pagination.page, page]);

  useEffect(() => {
    if (selectedId && entries.some((entry) => entry.id === selectedId)) {
      return;
    }
    setSelectedId(entries[0]?.id);
  }, [entries, selectedId]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timeout = window.setTimeout(() => setToast(undefined), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const detailQuery = useQuery({
    queryKey: ["memory-detail", selectedId],
    queryFn: () => {
      if (!selectedId) {
        throw new Error("No memory selected.");
      }
      return fetchReviewQueueDetail(selectedId);
    },
    enabled: Boolean(selectedId)
  });

  const deprecateMutation = useMutation({
    mutationFn: (id: string) => submitReviewAction({
      id,
      action: "deprecate",
      reason: "Deprecated from the memory library."
    }),
    onSuccess: async (_, deprecatedId) => {
      setSelectedId(findNextMemoryId(entries, deprecatedId));
      setMobileDetailOpen(false);
      setToast({ message: "Memory deprecated" });
      await queryClient.invalidateQueries({ queryKey: ["memories"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-detail"] });
    }
  });

  function resetListPosition() {
    setPage(1);
    setMobileDetailOpen(false);
  }

  return (
    <>
      <section className="mx-auto grid min-w-0 max-w-[1500px] grid-cols-1 md:min-h-[calc(100dvh-4.5rem)] md:grid-cols-[minmax(20rem,25rem)_minmax(0,1fr)]">
        <MemoryListPane
          entries={entries}
          error={memoriesQuery.error}
          isLoading={memoriesQuery.isLoading}
          mobileDetailOpen={mobileDetailOpen}
          pagination={memoriesQuery.data?.pagination}
          search={searchInput}
          selectedId={selectedId}
          sortMode={sortMode}
          status={status}
          onPageChange={(nextPage) => {
            setPage(nextPage);
            setMobileDetailOpen(false);
          }}
          onSearchChange={(value) => {
            setSearchInput(value);
            resetListPosition();
          }}
          onSelect={(id) => {
            setSelectedId(id);
            setMobileDetailOpen(true);
          }}
          onSortModeChange={(value) => {
            setSortMode(value);
            resetListPosition();
          }}
          onStatusChange={(value) => {
            setStatus(value);
            resetListPosition();
          }}
        />
        <MemoryDetailPane
          actionError={deprecateMutation.error}
          detail={detailQuery.data}
          error={detailQuery.error}
          isLoading={detailQuery.isLoading}
          isMutating={deprecateMutation.isPending}
          mobileDetailOpen={mobileDetailOpen}
          onBack={() => setMobileDetailOpen(false)}
          onDeprecate={() => {
            if (!selectedId) {
              throw new Error("No memory selected.");
            }
            deprecateMutation.mutate(selectedId);
          }}
        />
      </section>
      {toast ? <Toast message={toast.message} onDismiss={() => setToast(undefined)} /> : null}
    </>
  );
}

function MemoryListPane(props: {
  entries: MemoryCatalogItem[];
  error: Error | null;
  isLoading: boolean;
  mobileDetailOpen: boolean;
  pagination?: Pagination;
  search: string;
  selectedId?: string;
  sortMode: MemoryCatalogSortMode;
  status: MemoryCatalogStatus;
  onPageChange: (page: number) => void;
  onSearchChange: (value: string) => void;
  onSelect: (id: string) => void;
  onSortModeChange: (value: MemoryCatalogSortMode) => void;
  onStatusChange: (value: MemoryCatalogStatus) => void;
}) {
  return (
    <aside className={`${props.mobileDetailOpen ? "hidden" : "block"} min-w-0 border-stroke bg-canvas md:block md:h-[calc(100dvh-4.5rem)] md:overflow-y-auto md:border-r`}>
      <div className="sticky top-0 z-10 border-b border-stroke bg-canvas/95 px-4 pb-4 pt-7 backdrop-blur-md sm:px-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <p className="mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.17em] text-muted">Library</p>
            <h1 className="font-display text-[2rem] leading-none tracking-[-0.035em] text-ink">Memories</h1>
          </div>
          <span className="pb-0.5 text-xs tabular-nums text-muted">
            {props.pagination?.totalItems ?? 0} items
          </span>
        </div>

        <SearchField value={props.search} placeholder="Search your memory" onChange={props.onSearchChange} />

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex w-fit min-w-0 rounded-full border border-stroke bg-white p-1">
            {memoryStatuses.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`h-8 rounded-full px-3 text-[0.7rem] font-semibold transition-colors ${
                  props.status === item.value ? "bg-ink text-white" : "text-muted hover:text-ink"
                }`}
                onClick={() => props.onStatusChange(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="min-w-0 sm:w-auto">
            <span className="sr-only">Sort memories</span>
            <select
              className="h-9 w-full truncate rounded-full border-0 bg-transparent py-0 pl-3 pr-8 text-xs font-medium text-muted shadow-none focus:ring-1 focus:ring-ink sm:max-w-[8.7rem]"
              value={props.sortMode}
              onChange={(event) => props.onSortModeChange(readMemorySortMode(event.target.value))}
            >
              {memorySortModes.map((mode) => (
                <option key={mode.value} value={mode.value}>{mode.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {props.isLoading ? (
        <MemoryListSkeleton />
      ) : props.error ? (
        <InlineError message={props.error.message} />
      ) : props.entries.length === 0 ? (
        <EmptyState
          title="Nothing here"
          description={props.search ? "Try a different search." : "This shelf is quietly empty."}
        />
      ) : (
        <div className="px-2 py-2 sm:px-3">
          {props.entries.map((entry) => (
            <MemoryListItem
              key={entry.id}
              entry={entry}
              selected={props.selectedId === entry.id}
              onClick={() => props.onSelect(entry.id)}
            />
          ))}
        </div>
      )}
      {props.pagination ? (
        <div className="px-4 pb-6 sm:px-6">
          <PaginationControls
            pagination={props.pagination}
            disabled={props.isLoading}
            onPageChange={props.onPageChange}
          />
        </div>
      ) : null}
    </aside>
  );
}

function MemoryListItem(props: {
  entry: MemoryCatalogItem;
  selected: boolean;
  onClick: () => void;
}) {
  const project = props.entry.project ? formatProjectLabel(props.entry.project) : undefined;
  const captureKind = readMetadataString(props.entry.metadata, "capture_kind") ?? props.entry.sourceKind;

  return (
    <button
      type="button"
      className={`group relative w-full rounded-2xl px-4 py-4 text-left transition-all ${
        props.selected ? "bg-white shadow-soft" : "hover:bg-white/70"
      }`}
      data-testid={`memory-${props.entry.id}`}
      onClick={props.onClick}
    >
      <span className={`absolute bottom-4 left-0 top-4 w-0.5 rounded-full transition-colors ${
        props.entry.acceptanceState === "deprecated"
          ? "bg-danger"
          : props.selected
            ? "bg-ink"
            : "bg-transparent"
      }`} />
      <div className="flex items-start justify-between gap-4">
        <h2 className="line-clamp-2 text-[0.92rem] font-semibold leading-5 tracking-[-0.015em] text-ink">
          {props.entry.title}
        </h2>
        <ChevronRightIcon className={`mt-0.5 h-4 w-4 shrink-0 transition-transform ${
          props.selected ? "translate-x-0 text-ink" : "-translate-x-1 text-faint group-hover:translate-x-0 group-hover:text-ink"
        }`} />
      </div>
      {props.entry.summary ? (
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{props.entry.summary}</p>
      ) : null}
      <div className="mt-3 flex min-w-0 items-center gap-2 text-[0.68rem] text-faint">
        <StatusDot status={props.entry.acceptanceState} />
        <span className="truncate">{project ?? captureKind ?? props.entry.type}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{formatRelativeDate(props.entry.createdAt)}</span>
        {props.entry.useCount > 0 ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">used {props.entry.useCount}</span>
          </>
        ) : null}
      </div>
    </button>
  );
}

function MemoryDetailPane(props: {
  actionError: Error | null;
  detail: Awaited<ReturnType<typeof fetchReviewQueueDetail>> | undefined;
  error: Error | null;
  isLoading: boolean;
  isMutating: boolean;
  mobileDetailOpen: boolean;
  onBack: () => void;
  onDeprecate: () => void;
}) {
  const visibility = props.mobileDetailOpen ? "block" : "hidden md:block";
  if (props.isLoading) {
    return <div className={`${visibility} bg-white p-6 sm:p-10`}><DetailSkeleton /></div>;
  }
  if (props.error) {
    return <div className={`${visibility} bg-white`}><InlineError message={props.error.message} /></div>;
  }
  if (!props.detail) {
    return (
      <div className="hidden place-items-center bg-white md:grid">
        <EmptyState title="Choose a memory" description="Open something from the library to read it here." />
      </div>
    );
  }

  const { entry, usage } = props.detail;
  const deprecated = entry.frontmatter.acceptanceState === "deprecated";
  const captureKind = readMetadataString(entry.frontmatter.metadata, "capture_kind") ?? entry.frontmatter.source?.kind;

  return (
    <article className={`${visibility} min-w-0 bg-white md:h-[calc(100dvh-4.5rem)] md:overflow-y-auto`}>
      <div className="mx-auto max-w-4xl px-5 pb-24 pt-5 sm:px-10 md:px-12 md:pt-10 lg:px-16 xl:px-20">
        <button
          type="button"
          className="mb-8 inline-flex h-9 items-center gap-2 rounded-full border border-stroke px-3 text-xs font-semibold text-muted transition-colors hover:border-ink hover:text-ink md:hidden"
          onClick={props.onBack}
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Library
        </button>

        <header className="border-b border-stroke pb-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <StatusBadge status={entry.frontmatter.acceptanceState} />
              {captureKind ? <span className="text-[0.68rem] font-semibold uppercase tracking-[0.13em] text-faint">{captureKind}</span> : null}
            </div>
            {!deprecated ? (
              <button
                type="button"
                className="inline-flex h-9 items-center gap-2 rounded-full border border-danger/30 px-4 text-xs font-semibold text-danger transition-colors hover:border-danger hover:bg-danger-soft disabled:cursor-wait disabled:opacity-50"
                disabled={props.isMutating}
                onClick={props.onDeprecate}
              >
                <ArchiveIcon className="h-4 w-4" />
                {props.isMutating ? "Deprecating…" : "Deprecate"}
              </button>
            ) : null}
          </div>

          <h1 className="max-w-3xl font-display text-[2.35rem] leading-[1.08] tracking-[-0.045em] text-ink sm:text-[3rem]">
            {entry.title}
          </h1>
          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
            {entry.frontmatter.project ? <span>{formatProjectLabel(entry.frontmatter.project)}</span> : null}
            {entry.frontmatter.project ? <span aria-hidden="true" className="text-stroke-strong">/</span> : null}
            <span>{entry.frontmatter.type}</span>
            <span aria-hidden="true" className="text-stroke-strong">/</span>
            <span>{usage.useCount === 0 ? "Not used yet" : `Used ${usage.useCount} times`}</span>
            {usage.lastUsedAt ? (
              <>
                <span aria-hidden="true" className="text-stroke-strong">/</span>
                <span>Last used {formatRelativeDate(usage.lastUsedAt)}</span>
              </>
            ) : null}
          </div>
        </header>

        {props.actionError ? <InlineError message={props.actionError.message} /> : null}

        <section className="py-9 sm:py-12">
          <MarkdownContent body={entry.body} />
        </section>

        <TechnicalDetails
          acceptanceState={entry.frontmatter.acceptanceState}
          confidence={entry.frontmatter.confidence}
          decisionState={entry.frontmatter.decisionState}
          domains={entry.frontmatter.domains}
          id={entry.frontmatter.id}
          intents={entry.frontmatter.intents}
          metadata={entry.frontmatter.metadata}
          modes={entry.frontmatter.modes}
          reviewState={entry.frontmatter.reviewState}
          scope={entry.frontmatter.scope}
          source={entry.frontmatter.source}
          usageFeedback={usage.feedback}
        />
      </div>
    </article>
  );
}

function TechnicalDetails(props: {
  acceptanceState: string;
  confidence: number;
  decisionState: string;
  domains: string[];
  id: string;
  intents: string[];
  metadata: Record<string, unknown>;
  modes: string[];
  reviewState: string;
  scope: string;
  source?: { kind: string; ref: string };
  usageFeedback: UsageFeedbackCounts;
}) {
  return (
    <details className="group border-t border-stroke pt-5">
      <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-xs font-semibold uppercase tracking-[0.13em] text-muted">
        Technical details
        <ChevronRightIcon className="h-4 w-4 transition-transform group-open:rotate-90" />
      </summary>
      <div className="animate-reveal pb-6 pt-5">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
          <DetailFact label="Acceptance" value={props.acceptanceState} />
          <DetailFact label="Review" value={props.reviewState} />
          <DetailFact label="Decision" value={props.decisionState} />
          <DetailFact label="Scope" value={props.scope} />
          <DetailFact label="Confidence" value={props.confidence.toFixed(2)} />
          <DetailFact label="Feedback" value={`+${props.usageFeedback.positiveCount} / -${props.usageFeedback.negativeCount}`} />
        </dl>
        <TagGroup label="Domains" values={props.domains} />
        <TagGroup label="Intents" values={props.intents} />
        <TagGroup label="Modes" values={props.modes} />
        <div className="mt-6 grid gap-5 border-t border-stroke pt-6 text-xs sm:grid-cols-2">
          <DetailFact label="Memory ID" value={props.id} />
          <DetailFact label="Source" value={props.source ? `${props.source.kind}: ${props.source.ref}` : "Not provided"} />
        </div>
        <details className="mt-6">
          <summary className="cursor-pointer text-xs font-semibold text-muted">Raw metadata</summary>
          <pre className="mt-3 max-h-80 overflow-auto rounded-2xl bg-canvas p-4 text-[0.68rem] leading-5 text-muted">
            {JSON.stringify(props.metadata, null, 2)}
          </pre>
        </details>
      </div>
    </details>
  );
}

function DetailFact(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-faint">{props.label}</dt>
      <dd className="mt-1 break-words text-xs leading-5 text-ink">{props.value}</dd>
    </div>
  );
}

function TagGroup(props: { label: string; values: string[] }) {
  if (props.values.length === 0) {
    return null;
  }
  return (
    <div className="mt-6">
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-faint">{props.label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {props.values.map((value) => <span key={value} className="rounded-full bg-canvas px-3 py-1 text-[0.68rem] text-muted">{value}</span>)}
      </div>
    </div>
  );
}

function NotesLibrary() {
  const queryClient = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [sortMode, setSortMode] = useState<NoteSortMode>("newest");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const search = useDebouncedValue(searchInput, searchDebounceMilliseconds);
  const notesQuery = useQuery({
    queryKey: ["notes", includeArchived, page, search, sortMode],
    queryFn: () => fetchNotes({
      includeArchived,
      search: search.length > 0 ? search : undefined,
      sortMode,
      page,
      pageSize
    })
  });

  useEffect(() => {
    const responsePage = notesQuery.data?.pagination.page;
    if (responsePage !== undefined && responsePage !== page) {
      setPage(responsePage);
    }
  }, [notesQuery.data?.pagination.page, page]);

  const archiveMutation = useMutation({
    mutationFn: archiveNote,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["notes"] })
  });
  const restoreMutation = useMutation({
    mutationFn: restoreNote,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["notes"] })
  });
  const actionError = archiveMutation.error ?? restoreMutation.error;
  const isMutating = archiveMutation.isPending || restoreMutation.isPending;

  return (
    <section className="mx-auto max-w-5xl px-4 pb-20 pt-8 sm:px-6 sm:pt-12 lg:px-8">
      <header className="mb-8 sm:mb-12">
        <p className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.17em] text-muted">Small things worth keeping</p>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-display text-[2.7rem] leading-none tracking-[-0.045em] text-ink sm:text-5xl">Notes</h1>
            <p className="mt-3 text-sm text-muted">{notesQuery.data?.pagination.totalItems ?? 0} notes in this view</p>
          </div>
          <label className="inline-flex items-center gap-3 text-xs font-semibold text-muted">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-stroke-strong text-ink focus:ring-ink"
              checked={includeArchived}
              onChange={(event) => {
                setIncludeArchived(event.target.checked);
                setPage(1);
              }}
            />
            Show archived
          </label>
        </div>
      </header>

      <div className="mb-7 flex flex-col gap-3 rounded-2xl border border-stroke bg-white p-3 shadow-soft sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <SearchField value={searchInput} placeholder="Search notes" onChange={(value) => {
            setSearchInput(value);
            setPage(1);
          }} />
        </div>
        <label>
          <span className="sr-only">Sort notes</span>
          <select
            className="h-11 w-full rounded-xl border-0 bg-canvas py-0 pl-3 pr-9 text-xs font-semibold text-muted shadow-none focus:ring-1 focus:ring-ink sm:w-auto"
            value={sortMode}
            onChange={(event) => {
              setSortMode(readNoteSortMode(event.target.value));
              setPage(1);
            }}
          >
            {noteSortModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
        </label>
      </div>

      {actionError ? <InlineError message={actionError.message} /> : null}
      {notesQuery.isLoading ? (
        <MemoryListSkeleton />
      ) : notesQuery.error ? (
        <InlineError message={notesQuery.error.message} />
      ) : (notesQuery.data?.notes.length ?? 0) === 0 ? (
        <EmptyState title="No notes found" description="Try a different search or include archived notes." />
      ) : (
        <div className="space-y-3">
          {notesQuery.data?.notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              disabled={isMutating}
              onArchive={() => archiveMutation.mutate(note.id)}
              onRestore={() => restoreMutation.mutate(note.id)}
            />
          ))}
        </div>
      )}

      {notesQuery.data?.pagination ? (
        <PaginationControls
          pagination={notesQuery.data.pagination}
          disabled={notesQuery.isLoading}
          onPageChange={setPage}
        />
      ) : null}
    </section>
  );
}

function NoteCard(props: {
  note: NoteRecord;
  disabled: boolean;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const score = props.note.upvotes - props.note.downvotes;
  return (
    <article className={`rounded-3xl border bg-white p-5 shadow-soft transition-opacity sm:p-7 ${
      props.note.archived ? "border-stroke opacity-65" : "border-transparent"
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-4 flex flex-wrap items-center gap-2 text-[0.68rem]">
            {props.note.topic ? <span className="rounded-full bg-canvas px-3 py-1 font-semibold text-muted">{props.note.topic}</span> : null}
            {props.note.archived ? <span className="font-semibold uppercase tracking-[0.1em] text-danger">Archived</span> : null}
            {score !== 0 ? <span className="text-faint">score {score > 0 ? `+${score}` : score}</span> : null}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-7 text-ink">{props.note.content}</p>
          <NoteSource note={props.note} />
          <p className="mt-5 text-[0.68rem] text-faint">{formatDateTime(props.note.createdAt)}</p>
        </div>
        <button
          type="button"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-stroke text-muted transition-colors hover:border-ink hover:text-ink disabled:opacity-40"
          aria-label={props.note.archived ? "Restore note" : "Archive note"}
          disabled={props.disabled}
          onClick={props.note.archived ? props.onRestore : props.onArchive}
        >
          {props.note.archived ? <RestoreIcon className="h-4 w-4" /> : <ArchiveIcon className="h-4 w-4" />}
        </button>
      </div>
    </article>
  );
}

function NoteSource(props: { note: NoteRecord }) {
  if (!props.note.sourceConversation) {
    return null;
  }
  return (
    <details className="group mt-5 border-t border-stroke pt-4">
      <summary className="cursor-pointer list-none text-[0.68rem] font-semibold uppercase tracking-[0.1em] text-faint">
        Source conversation
      </summary>
      <div className="mt-4 space-y-3">
        {props.note.sourceConversation.messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className="rounded-2xl bg-canvas px-4 py-3">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-faint">{message.role}</p>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted">{message.text}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

function SearchField(props: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative block">
      <span className="sr-only">{props.placeholder}</span>
      <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
      <input
        type="search"
        className="h-11 w-full rounded-xl border border-stroke bg-white pl-10 pr-4 text-sm text-ink shadow-none placeholder:text-faint focus:border-ink focus:ring-0"
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
  if (props.pagination.totalPages <= 1) {
    return null;
  }
  return (
    <nav className="mt-6 flex items-center justify-between border-t border-stroke pt-5" aria-label="Pagination">
      <button
        type="button"
        className="pagination-button"
        disabled={props.disabled || props.pagination.page <= 1}
        aria-label="Previous page"
        onClick={() => props.onPageChange(props.pagination.page - 1)}
      >
        <ChevronLeftIcon className="h-4 w-4" />
      </button>
      <span className="text-[0.68rem] font-semibold tabular-nums text-muted">
        {props.pagination.page} / {props.pagination.totalPages}
      </span>
      <button
        type="button"
        className="pagination-button"
        disabled={props.disabled || props.pagination.page >= props.pagination.totalPages}
        aria-label="Next page"
        onClick={() => props.onPageChange(props.pagination.page + 1)}
      >
        <ChevronRightIcon className="h-4 w-4" />
      </button>
    </nav>
  );
}

function StatusBadge(props: { status: string }) {
  const label = props.status === "candidate" ? "Current" : props.status;
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[0.68rem] font-semibold capitalize ${
      props.status === "deprecated" ? "bg-danger-soft text-danger" : "bg-sage-soft text-sage"
    }`}>
      <StatusDot status={props.status} />
      {label}
    </span>
  );
}

function StatusDot(props: { status: string }) {
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${props.status === "deprecated" ? "bg-danger" : "bg-sage"}`} />;
}

function Toast(props: { message: string; onDismiss: () => void }) {
  return (
    <div
      className="fixed bottom-5 left-4 right-4 z-50 flex animate-toast items-center gap-3 rounded-2xl border border-stroke bg-ink px-4 py-3 text-white shadow-toast sm:left-auto sm:right-6 sm:w-80"
      role="status"
      aria-live="polite"
    >
      <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">
        <ArchiveIcon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">Done</p>
        <p className="mt-0.5 text-[0.7rem] text-white/65">{props.message}</p>
      </div>
      <button type="button" className="grid h-7 w-7 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white" aria-label="Dismiss notification" onClick={props.onDismiss}>
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

function InlineError(props: { message: string }) {
  return (
    <div className="m-5 rounded-2xl border border-danger/20 bg-danger-soft px-4 py-3 text-xs leading-5 text-danger">
      {props.message}
    </div>
  );
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div className="mx-auto max-w-sm px-8 py-20 text-center">
      <span className="mx-auto grid h-11 w-11 place-items-center rounded-full border border-stroke bg-white text-faint">
        <MemoryIcon className="h-5 w-5" />
      </span>
      <h2 className="mt-5 font-display text-xl tracking-[-0.025em] text-ink">{props.title}</h2>
      <p className="mt-2 text-xs leading-5 text-muted">{props.description}</p>
    </div>
  );
}

function MemoryListSkeleton() {
  return (
    <div className="space-y-3 px-4 py-5" aria-label="Loading">
      {[1, 2, 3, 4].map((item) => (
        <div key={item} className="animate-pulse rounded-2xl bg-white p-4">
          <div className="h-3 w-4/5 rounded bg-stroke" />
          <div className="mt-3 h-2 w-2/5 rounded bg-stroke" />
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="mx-auto max-w-3xl animate-pulse py-8">
      <div className="h-5 w-20 rounded-full bg-canvas" />
      <div className="mt-8 h-10 w-4/5 rounded bg-canvas" />
      <div className="mt-3 h-10 w-3/5 rounded bg-canvas" />
      <div className="mt-10 space-y-3">
        <div className="h-3 rounded bg-canvas" />
        <div className="h-3 rounded bg-canvas" />
        <div className="h-3 w-4/5 rounded bg-canvas" />
      </div>
    </div>
  );
}

function findNextMemoryId(entries: MemoryCatalogItem[], currentId: string) {
  const currentIndex = entries.findIndex((entry) => entry.id === currentId);
  if (currentIndex === -1) {
    return entries[0]?.id;
  }
  return (entries[currentIndex + 1] ?? entries[currentIndex - 1])?.id;
}

function readMemorySortMode(value: string): MemoryCatalogSortMode {
  if (value === "created" || value === "last_used" || value === "uses") {
    return value;
  }
  throw new Error(`Invalid memory sort mode: ${value}`);
}

function readNoteSortMode(value: string): NoteSortMode {
  if (value === "newest" || value === "oldest") {
    return value;
  }
  throw new Error(`Invalid note sort mode: ${value}`);
}

function readMetadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function formatProjectLabel(project: ProjectContext) {
  return project.repo ? `${project.name} / ${project.repo}` : project.name;
}

function formatRelativeDate(value: string | undefined) {
  if (!value) {
    return "unknown";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }
  const ageMilliseconds = Date.now() - timestamp;
  if (ageMilliseconds < 60_000) {
    return "just now";
  }
  const ageMinutes = Math.floor(ageMilliseconds / 60_000);
  if (ageMinutes < 60) {
    return `${ageMinutes}m ago`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) {
    return `${ageHours}h ago`;
  }
  const ageDays = Math.floor(ageHours / 24);
  if (ageDays < 30) {
    return `${ageDays}d ago`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "Unknown date";
  }
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}
