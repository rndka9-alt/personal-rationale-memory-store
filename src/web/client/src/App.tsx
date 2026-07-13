import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  digestLayers,
  fetchDigest,
  fetchDigestRuns,
  type DigestClaim,
  type DigestLayer,
  type DigestOperation,
  type DigestRun
} from "./api/digest";
import {
  fetchLlmRequests,
  fetchLlmRequestSummary,
  type LlmRequestRecord,
  type LlmRequestSummary
} from "./api/llmRequests";
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
  DigestIcon,
  LlmIcon,
  MemoryIcon,
  NoteIcon,
  RestoreIcon,
  SearchIcon,
  XIcon
} from "./components/Icons";
import type { NoteRecord } from "./types/note";
import type { Pagination } from "./types/pagination";
import type { ProjectContext, UsageFeedbackCounts } from "./types/review";

type MainView = "memories" | "notes" | "digest" | "llm";

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

const digestLayerDetails: Record<DigestLayer, { label: string; eyebrow: string }> = {
  now: { label: "요즘 관심사", eyebrow: "Now" },
  recent: { label: "최근", eyebrow: "Recent" },
  longterm: { label: "장기", eyebrow: "Long term" },
  about: { label: "나에 대해", eyebrow: "About" }
};

const digestOperationLabels: Record<DigestOperation["type"], string> = {
  add: "추가",
  strengthen: "강화",
  revise: "수정",
  retire: "은퇴",
  promote: "승격",
  merge: "병합"
};

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
      {mainView === "memories" ? <MemoryLibrary /> : null}
      {mainView === "notes" ? <NotesLibrary /> : null}
      {mainView === "digest" ? <DigestDashboard /> : null}
      {mainView === "llm" ? <LlmDashboard /> : null}
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
          <div className="hidden sm:block">
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
          <NavigationButton
            active={props.mainView === "digest"}
            icon={<DigestIcon className="h-4 w-4" />}
            label="Digest"
            onClick={() => props.onViewChange("digest")}
          />
          <NavigationButton
            active={props.mainView === "llm"}
            icon={<LlmIcon className="h-4 w-4" />}
            label="LLM"
            onClick={() => props.onViewChange("llm")}
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
      className={`flex h-9 items-center gap-1.5 rounded-full px-2 text-xs font-semibold transition-all sm:gap-2 sm:px-4 ${
        props.active ? "bg-white text-ink shadow-soft" : "text-muted hover:text-ink"
      }`}
      aria-label={props.label}
      aria-current={props.active ? "page" : undefined}
      onClick={props.onClick}
    >
      {props.icon}
      <span className="hidden sm:inline">{props.label}</span>
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

function DigestDashboard() {
  const digestQuery = useQuery({
    queryKey: ["digest"],
    queryFn: fetchDigest
  });
  const runsQuery = useQuery({
    queryKey: ["digest-runs", 20],
    queryFn: () => fetchDigestRuns(20)
  });

  if (digestQuery.isLoading || runsQuery.isLoading) {
    return <DigestSkeleton />;
  }

  const queryError = digestQuery.error ?? runsQuery.error;
  if (queryError) {
    return (
      <section className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6 sm:pt-12 lg:px-8">
        <InlineError message={queryError.message} />
      </section>
    );
  }

  const digest = digestQuery.data;
  const runs = runsQuery.data;
  if (!digest || !runs) {
    throw new Error("Digest queries completed without data.");
  }
  const digestState = digest.state;

  return (
    <section className="mx-auto max-w-7xl px-4 pb-24 pt-8 sm:px-6 sm:pt-12 lg:px-8">
      <DigestHeader />

      {!digestState ? (
        <EmptyState
          title="아직 합성된 Digest가 없어요"
          description="첫 합성이 완료되면 4개 레이어의 프로즈와 claim 원장이 여기에 나타납니다."
        />
      ) : (
        <>
          <div className="mb-8 flex w-fit max-w-full flex-wrap items-center gap-2 rounded-2xl border border-stroke bg-white px-3.5 py-2 text-xs text-muted shadow-soft sm:mb-10 sm:rounded-full">
            <span className="h-1.5 w-1.5 rounded-full bg-sage" />
            <span className="font-medium text-ink">{formatDigestDateTime(digestState.synthesizedAt)} 합성</span>
            <span aria-hidden="true" className="text-stroke-strong">·</span>
            <span>이후 신규 노트 {digestState.newNoteCount}개 미반영</span>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {digestLayers.map((layer, index) => (
              <DigestProseCard
                key={layer}
                index={index}
                layer={layer}
                text={digestState.prose[layer]}
              />
            ))}
          </div>

          <DigestClaimLedger claims={digest.claims} />
          <DigestRunHistory runs={runs} />
        </>
      )}
    </section>
  );
}

function DigestHeader() {
  return (
    <header className="mb-8 sm:mb-10">
      <p className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.17em] text-muted">Living synthesis</p>
      <h1 className="font-display text-[2.7rem] leading-none tracking-[-0.045em] text-ink sm:text-5xl">Digest</h1>
      <p className="mt-3 max-w-xl text-sm leading-6 text-muted">흩어진 기록에서 지금의 흐름과 오래 남은 맥락을 읽습니다.</p>
    </header>
  );
}

function DigestProseCard(props: { index: number; layer: DigestLayer; text: string }) {
  const details = digestLayerDetails[props.layer];
  return (
    <article className="rounded-3xl border border-stroke bg-white px-5 py-6 shadow-soft sm:px-8 sm:py-8">
      <div className="mb-5 flex items-baseline justify-between gap-4 border-b border-stroke pb-4">
        <div>
          <p className="text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-faint">{details.eyebrow}</p>
          <h2 className="mt-1 font-display text-2xl tracking-[-0.03em] text-ink">{details.label}</h2>
        </div>
        <span className="font-display text-sm italic text-stroke-strong">0{props.index + 1}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-[0.94rem] leading-8 text-ink/90 sm:text-base sm:leading-8">
        {props.text}
      </p>
    </article>
  );
}

function DigestClaimLedger(props: { claims: DigestClaim[] }) {
  return (
    <section className="mt-16 sm:mt-20">
      <SectionHeading
        eyebrow="Evidence ledger"
        title="Claim 원장"
        detail={`활성 claim ${props.claims.length}개`}
      />

      {props.claims.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-stroke-strong px-6 py-10 text-center text-sm text-muted">
          아직 활성 claim이 없습니다.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {digestLayers.map((layer) => (
            <DigestClaimGroup
              key={layer}
              layer={layer}
              claims={props.claims.filter((claim) => claim.layer === layer)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DigestClaimGroup(props: { layer: DigestLayer; claims: DigestClaim[] }) {
  const details = digestLayerDetails[props.layer];
  return (
    <article className="flex flex-col overflow-hidden rounded-3xl border border-stroke bg-white shadow-soft">
      <header className="flex items-center justify-between border-b border-stroke px-5 py-4 sm:px-6">
        <div className="flex items-baseline gap-2.5">
          <h3 className="font-display text-xl tracking-[-0.025em] text-ink">{details.label}</h3>
          <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-faint">{details.eyebrow}</span>
        </div>
        <span className="text-xs tabular-nums text-faint">{props.claims.length}</span>
      </header>
      {props.claims.length === 0 ? (
        <p className="px-5 py-7 text-xs text-faint sm:px-6">이 레이어의 활성 claim이 없습니다.</p>
      ) : (
        <ul className="max-h-96 min-h-0 flex-1 divide-y divide-stroke overflow-y-auto overscroll-contain">
          {props.claims.map((claim) => (
            <li key={claim.id} className="px-5 py-5 sm:px-6">
              <p className="break-words text-sm leading-6 text-ink">{claim.text}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[0.67rem] text-faint">
                <span className={`rounded-full px-2.5 py-1 font-semibold tabular-nums ${evidenceBadgeClassName(claim.evidenceCount)}`}>
                  근거 ×{claim.evidenceCount}
                </span>
                <span>관측 {claim.observedDays}일</span>
                <span>{formatDigestObservationSpan(claim)}</span>
                {claim.deferred ? (
                  <span className="rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-700">
                    승격 대기 → {digestLayerDetails[claim.deferred.targetLayer].label}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function DigestRunHistory(props: { runs: DigestRun[] }) {
  return (
    <section className="mt-16 sm:mt-20">
      <SectionHeading
        eyebrow="Synthesis history"
        title="합성 히스토리"
        detail={`최근 ${props.runs.length}건`}
      />
      {props.runs.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-stroke-strong px-6 py-10 text-center text-sm text-muted">
          아직 기록된 합성 run이 없습니다.
        </div>
      ) : (
        <div className="overflow-hidden rounded-3xl border border-stroke bg-white shadow-soft">
          {props.runs.map((run) => <DigestRunItem key={run.id} run={run} />)}
        </div>
      )}
    </section>
  );
}

function DigestRunItem(props: { run: DigestRun }) {
  const run = props.run;
  return (
    <details className="group border-b border-stroke last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 transition-colors hover:bg-canvas/60 sm:px-6">
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-faint transition-transform group-open:rotate-90" />
        <div className="min-w-0 flex-1 sm:flex sm:items-center sm:justify-between sm:gap-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${run.status === "succeeded" ? "bg-sage" : "bg-danger"}`} />
            <span className="truncate text-sm font-medium text-ink">{formatDigestDateTime(run.runAt)}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-3 pl-4 text-[0.68rem] text-faint sm:mt-0 sm:pl-0">
            <span className={run.status === "succeeded" ? "text-sage" : "text-danger"}>
              {run.status === "succeeded" ? "성공" : "실패"}
            </span>
            <span>신규 노트 {run.newNoteCount}개</span>
            <span>ops {run.ops.length}개</span>
            <span>{run.runKind === "synthesis" ? "판단" : "유지보수"}</span>
          </div>
        </div>
      </summary>
      <div className="border-t border-stroke bg-canvas/55 px-5 py-5 sm:px-10 sm:py-6">
        {run.error ? (
          <div className="mb-4 rounded-2xl border border-danger/15 bg-danger-soft px-4 py-3 text-xs leading-5 text-danger">
            {run.error}
          </div>
        ) : null}
        {run.ops.length === 0 ? (
          <p className="text-xs text-faint">적용된 operation이 없습니다.</p>
        ) : (
          <ol className="space-y-2.5">
            {run.ops.map((operation, index) => (
              <DigestOperationItem key={`${operation.type}-${index}`} operation={operation} />
            ))}
          </ol>
        )}
        {run.skippedOperations.length > 0 ? (
          <div className="mt-5">
            <p className="mb-2 text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-muted">Skipped</p>
            <ul className="space-y-2 text-xs text-faint">
              {run.skippedOperations.map((skipped, index) => (
                <li key={`${skipped.reason}-${index}`} className="rounded-2xl border border-stroke bg-white px-4 py-3">
                  {digestOperationLabels[skipped.operation.type]} · {skipped.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {run.deferredEvents.length > 0 ? (
          <div className="mt-5">
            <p className="mb-2 text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-muted">Deferred promotions</p>
            <ul className="space-y-2 text-xs text-faint">
              {run.deferredEvents.map((event, index) => (
                <li key={`${event.claimId}-${event.action}-${index}`} className="rounded-2xl border border-stroke bg-white px-4 py-3">
                  {event.action} · {event.claimId} → {digestLayerDetails[event.targetLayer].label} · {event.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function DigestOperationItem(props: { operation: DigestOperation }) {
  const operation = props.operation;
  return (
    <li className="flex items-start gap-3 rounded-2xl border border-stroke bg-white px-4 py-3.5">
      <span className={`mt-0.5 shrink-0 rounded-full px-2 py-1 text-[0.62rem] font-semibold ${digestOperationBadgeClassName(operation.type)}`}>
        {digestOperationLabels[operation.type]}
      </span>
      <DigestOperationContent operation={operation} />
    </li>
  );
}

function DigestOperationContent(props: { operation: DigestOperation }) {
  const operation = props.operation;
  if (operation.type === "add") {
    return (
      <div className="min-w-0">
        <p className="break-words text-sm leading-5 text-ink">{operation.text}</p>
        <p className="mt-1 text-[0.67rem] text-faint">{digestLayerDetails[operation.layer].label} · 근거 {operation.noteIds.length}개</p>
      </div>
    );
  }
  if (operation.type === "strengthen") {
    return (
      <div className="min-w-0">
        <p className="break-all font-mono text-xs leading-5 text-ink">{operation.claimId}</p>
        <p className="mt-1 text-[0.67rem] text-faint">신규 근거 {operation.noteIds.length}개</p>
      </div>
    );
  }
  if (operation.type === "revise") {
    return (
      <div className="min-w-0">
        <p className={`break-words leading-5 text-ink ${operation.text ? "text-sm" : "font-mono text-xs"}`}>
          {operation.text ?? operation.claimId}
        </p>
        <p className="mt-1 break-all text-[0.67rem] leading-5 text-faint">
          대상 {operation.claimId}
          {operation.layer ? ` · ${digestLayerDetails[operation.layer].label}로 이동` : ""}
          {operation.noteIds ? ` · 근거 ${operation.noteIds.length}개` : ""}
        </p>
      </div>
    );
  }
  if (operation.type === "promote") {
    return (
      <div className="min-w-0">
        <p className="break-all font-mono text-xs leading-5 text-ink">{operation.claimId}</p>
        <p className="mt-1 text-[0.67rem] text-faint">{digestLayerDetails[operation.layer].label}로 승격</p>
      </div>
    );
  }
  if (operation.type === "merge") {
    return (
      <div className="min-w-0">
        <p className="break-words text-sm leading-5 text-ink">{operation.text ?? operation.parentClaimId}</p>
        <p className="mt-1 break-all text-[0.67rem] leading-5 text-faint">
          부모 {operation.parentClaimId} · 자식 {operation.childClaimIds.length}개
        </p>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <p className="break-all font-mono text-xs leading-5 text-ink">{operation.claimId}</p>
      <p className="mt-1 text-[0.67rem] text-faint">활성 원장에서 제외</p>
    </div>
  );
}

function SectionHeading(props: { eyebrow: string; title: string; detail: string }) {
  return (
    <header className="mb-5 flex items-end justify-between gap-4">
      <div>
        <p className="text-[0.66rem] font-semibold uppercase tracking-[0.15em] text-muted">{props.eyebrow}</p>
        <h2 className="mt-1 font-display text-3xl tracking-[-0.035em] text-ink">{props.title}</h2>
      </div>
      <p className="pb-1 text-xs text-faint">{props.detail}</p>
    </header>
  );
}

function DigestSkeleton() {
  return (
    <section className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6 sm:pt-12 lg:px-8" aria-label="Loading digest">
      <div className="h-12 w-52 animate-pulse rounded-xl bg-stroke" />
      <div className="mt-10 h-8 w-72 animate-pulse rounded-full bg-stroke" />
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((item) => <div key={item} className="h-64 animate-pulse rounded-3xl bg-white shadow-soft" />)}
      </div>
    </section>
  );
}

function evidenceBadgeClassName(evidenceCount: number) {
  if (evidenceCount >= 5) {
    return "bg-sage text-white";
  }
  if (evidenceCount >= 3) {
    return "bg-sage-soft text-sage";
  }
  return "bg-canvas text-muted";
}

function formatDigestObservationSpan(claim: DigestClaim) {
  if (!claim.firstObservedAt || !claim.lastObservedAt) {
    return "관측 시각 없음";
  }
  const firstDate = formatDigestDate(claim.firstObservedAt);
  const lastDate = formatDigestDate(claim.lastObservedAt);
  return firstDate === lastDate ? firstDate : `${firstDate} ~ ${lastDate}`;
}

function digestOperationBadgeClassName(type: DigestOperation["type"]) {
  if (type === "retire") {
    return "bg-danger-soft text-danger";
  }
  if (type === "strengthen") {
    return "bg-sage-soft text-sage";
  }
  return "bg-canvas text-muted";
}

function formatDigestDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid digest timestamp: ${value}`);
  }
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function formatDigestDate(value: string) {
  return formatDigestDateTime(value).slice(0, 10);
}

type DailyCostPoint = {
  date: string;
  costUsd: number;
  requestCount: number;
};

function LlmDashboard() {
  const summaryQuery = useQuery({
    queryKey: ["llm-request-summary"],
    queryFn: fetchLlmRequestSummary
  });
  const requestsQuery = useQuery({
    queryKey: ["llm-requests", 50],
    queryFn: () => fetchLlmRequests(50)
  });

  const daily = useMemo(
    () => fillDailyCostSeries(summaryQuery.data?.daily ?? []),
    [summaryQuery.data?.daily]
  );

  if (summaryQuery.isLoading || requestsQuery.isLoading) {
    return (
      <section className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6 sm:pt-12 lg:px-8">
        <div className="h-12 w-52 animate-pulse rounded-xl bg-stroke" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((item) => <div key={item} className="h-28 animate-pulse rounded-3xl bg-white shadow-soft" />)}
        </div>
      </section>
    );
  }

  const queryError = summaryQuery.error ?? requestsQuery.error;
  if (queryError) {
    return (
      <section className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6 sm:pt-12 lg:px-8">
        <InlineError message={queryError.message} />
      </section>
    );
  }

  const summary = summaryQuery.data;
  const requests = requestsQuery.data;
  if (!summary || !requests) {
    throw new Error("LLM dashboard queries completed without data.");
  }

  return (
    <section className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6 sm:pt-12 lg:px-8">
      <header className="mb-8 sm:mb-12">
        <p className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.17em] text-muted">Inference ledger</p>
        <h1 className="font-display text-[2.7rem] leading-none tracking-[-0.045em] text-ink sm:text-5xl">LLM</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted">Request-level usage and gateway cost history.</p>
      </header>

      {summary.total.requestCount === 0 ? (
        <EmptyState
          title="No LLM requests yet"
          description="Digest synthesis and repair requests will appear here after the first run."
        />
      ) : (
        <>
          <LlmSummaryTiles summary={summary} />

          <section className="mt-6 rounded-3xl border border-stroke bg-white p-5 shadow-soft sm:p-7">
            <div className="mb-7 flex items-end justify-between gap-4">
              <div>
                <p className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted">Last 30 days</p>
                <h2 className="mt-1 font-display text-2xl tracking-[-0.03em] text-ink">Daily cost</h2>
              </div>
              <p className="text-xs text-faint">USD</p>
            </div>
            <div className="h-72 w-full" aria-label="Daily LLM cost chart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#e4e4df" strokeDasharray="2 5" vertical={false} />
                  <XAxis
                    axisLine={false}
                    dataKey="date"
                    interval={4}
                    tick={{ fill: "#a2a49f", fontSize: 10 }}
                    tickFormatter={(date: string) => date.slice(5)}
                    tickLine={false}
                  />
                  <YAxis
                    axisLine={false}
                    tick={{ fill: "#a2a49f", fontSize: 10 }}
                    tickFormatter={formatUsd}
                    tickLine={false}
                    width={64}
                  />
                  <Tooltip
                    content={<CostChartTooltip />}
                    cursor={{ fill: "#eef3ee" }}
                  />
                  <Bar dataKey="costUsd" fill="#59715e" maxBarSize={22} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <LlmSubtotalTable
              title="By purpose"
              labelTitle="Purpose"
              rows={summary.byPurpose.map((row) => ({ ...row, label: formatPurpose(row.purpose) }))}
            />
            <LlmSubtotalTable
              title="By model"
              labelTitle="Model"
              rows={summary.byModel.map((row) => ({ ...row, label: row.model }))}
            />
          </div>

          <LlmRequestTable requests={requests} />
        </>
      )}
    </section>
  );
}

function LlmSummaryTiles(props: { summary: LlmRequestSummary }) {
  const failureRate = props.summary.total.requestCount === 0
    ? 0
    : props.summary.total.failedCount / props.summary.total.requestCount;
  const tiles = [
    { label: "This month", value: formatUsd(props.summary.thisMonth.costUsd), detail: `${props.summary.thisMonth.requestCount} requests` },
    { label: "Last 7 days", value: formatUsd(props.summary.last7Days.costUsd), detail: `${props.summary.last7Days.requestCount} requests` },
    { label: "Total requests", value: formatInteger(props.summary.total.requestCount), detail: "all recorded time" },
    { label: "Failure rate", value: formatPercentage(failureRate), detail: `${props.summary.total.failedCount} failed` }
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <article key={tile.label} className="rounded-3xl border border-stroke bg-white p-5 shadow-soft sm:p-6">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.13em] text-muted">{tile.label}</p>
          <p className="mt-4 font-display text-[2rem] leading-none tracking-[-0.04em] text-ink">{tile.value}</p>
          <p className="mt-3 text-xs text-faint">{tile.detail}</p>
        </article>
      ))}
    </div>
  );
}

function CostChartTooltip(props: {
  active?: boolean;
  payload?: Array<{ payload?: DailyCostPoint }>;
}) {
  const point = props.payload?.[0]?.payload;
  if (!props.active || !point) {
    return null;
  }
  return (
    <div className="rounded-2xl border border-stroke bg-white px-4 py-3 shadow-toast">
      <p className="text-[0.68rem] font-semibold text-muted">{formatChartDate(point.date)}</p>
      <p className="mt-1 text-sm font-semibold text-ink">{formatUsd(point.costUsd)}</p>
      <p className="mt-0.5 text-[0.68rem] text-faint">{point.requestCount} requests</p>
    </div>
  );
}

function LlmSubtotalTable(props: {
  title: string;
  labelTitle: string;
  rows: Array<{ label: string; costUsd: number; requestCount: number }>;
}) {
  return (
    <section className="overflow-hidden rounded-3xl border border-stroke bg-white shadow-soft">
      <div className="border-b border-stroke px-5 py-5 sm:px-7">
        <h2 className="font-display text-xl tracking-[-0.025em] text-ink">{props.title}</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-xs">
          <thead className="text-[0.62rem] uppercase tracking-[0.12em] text-faint">
            <tr>
              <th className="px-5 py-3 font-semibold sm:px-7">{props.labelTitle}</th>
              <th className="px-4 py-3 text-right font-semibold">Requests</th>
              <th className="px-5 py-3 text-right font-semibold sm:px-7">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stroke">
            {props.rows.map((row) => (
              <tr key={row.label}>
                <td className="max-w-xs break-words px-5 py-4 font-medium text-ink sm:px-7">{row.label}</td>
                <td className="px-4 py-4 text-right tabular-nums text-muted">{formatInteger(row.requestCount)}</td>
                <td className="px-5 py-4 text-right font-semibold tabular-nums text-ink sm:px-7">{formatUsd(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LlmRequestTable(props: { requests: LlmRequestRecord[] }) {
  return (
    <section className="mt-6 overflow-hidden rounded-3xl border border-stroke bg-white shadow-soft">
      <div className="flex items-end justify-between gap-4 border-b border-stroke px-5 py-5 sm:px-7">
        <div>
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.13em] text-muted">Latest activity</p>
          <h2 className="mt-1 font-display text-2xl tracking-[-0.03em] text-ink">Recent requests</h2>
        </div>
        <p className="text-xs text-faint">{props.requests.length} shown</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[58rem] text-left text-xs">
          <thead className="text-[0.62rem] uppercase tracking-[0.12em] text-faint">
            <tr>
              <th className="px-5 py-3 font-semibold sm:px-7">Time</th>
              <th className="px-4 py-3 font-semibold">Purpose</th>
              <th className="px-4 py-3 font-semibold">Model</th>
              <th className="px-4 py-3 text-right font-semibold">In</th>
              <th className="px-4 py-3 text-right font-semibold">Out</th>
              <th className="px-4 py-3 text-right font-semibold">Cost</th>
              <th className="px-5 py-3 text-right font-semibold sm:px-7">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stroke">
            {props.requests.map((request) => (
              <tr key={request.id}>
                <td className="whitespace-nowrap px-5 py-4 text-muted sm:px-7">{formatRequestDateTime(request.requestedAt)}</td>
                <td className="px-4 py-4 font-medium text-ink">{formatPurpose(request.purpose)}</td>
                <td className="max-w-xs break-words px-4 py-4 text-muted">{request.model}</td>
                <td className="px-4 py-4 text-right tabular-nums text-muted">{formatOptionalInteger(request.inputTokens)}</td>
                <td className="px-4 py-4 text-right tabular-nums text-muted">{formatOptionalInteger(request.outputTokens)}</td>
                <td className="px-4 py-4 text-right font-semibold tabular-nums text-ink">{formatOptionalUsd(request.costUsd)}</td>
                <td className="px-5 py-4 text-right sm:px-7">
                  <span className={`inline-flex rounded-full px-2.5 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.08em] ${
                    request.status === "succeeded" ? "bg-sage-soft text-sage" : "bg-danger-soft text-danger"
                  }`}>
                    {request.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

function fillDailyCostSeries(daily: DailyCostPoint[]) {
  const valuesByDate = new Map(daily.map((point) => [point.date, point]));
  const today = new Date();
  const points: DailyCostPoint[] = [];
  for (let daysAgo = 29; daysAgo >= 0; daysAgo -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo);
    const dateKey = formatLocalDateKey(date);
    points.push(valuesByDate.get(dateKey) ?? { date: dateKey, costUsd: 0, requestCount: 0 });
  }
  return points;
}

function formatLocalDateKey(date: Date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatUsd(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid USD amount: ${value}`);
  }
  return `$${new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 3,
    useGrouping: true
  }).format(value)}`;
}

function formatOptionalUsd(value: number | null) {
  return value === null ? "—" : formatUsd(value);
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatOptionalInteger(value: number | null) {
  return value === null ? "—" : formatInteger(value);
}

function formatPercentage(value: number) {
  return `${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 }).format(value * 100)}%`;
}

function formatPurpose(value: string) {
  return value.replaceAll("_", " ");
}

function formatChartDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatRequestDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "Unknown time";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
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
