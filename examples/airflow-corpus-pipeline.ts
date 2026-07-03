import { RetryPolicy, Task, TaskGraph } from '@ianphil/ttasks-ts';

export const AirflowCorpusTaskType = {
  PLAN_SEARCH: 'airflow-corpus:plan-search',
  LOAD_STATE: 'airflow-corpus:load-state',
  SEARCH_GITHUB: 'airflow-corpus:search-github',
  SEARCH_AIRFLOW_EXAMPLES: 'airflow-corpus:search-airflow-examples',
  MERGE_RESULTS: 'airflow-corpus:merge-results',
  DEDUPE_PATHS: 'airflow-corpus:dedupe-paths',
  FETCH_RAW: 'airflow-corpus:fetch-raw',
  RETRY_FETCHES: 'airflow-corpus:retry-fetches',
  DEDUPE_CONTENT: 'airflow-corpus:dedupe-content',
  PERSIST_RAW: 'airflow-corpus:persist-raw',
  PARSE_AST: 'airflow-corpus:parse-ast',
  DETECT_DAG_PATTERNS: 'airflow-corpus:detect-dag-patterns',
  EXTRACT_TASKS: 'airflow-corpus:extract-tasks',
  EXTRACT_EDGES: 'airflow-corpus:extract-edges',
  EXTRACT_TASKFLOW_GROUPS: 'airflow-corpus:extract-taskflow-groups',
  BUILD_TASKGRAPHS: 'airflow-corpus:build-taskgraphs',
  DEDUPE_VALIDATE: 'airflow-corpus:dedupe-validate',
  WRITE_JSONL: 'airflow-corpus:write-jsonl',
} as const;

export interface AirflowCorpusPipelineOptions {
  limit?: number;
  rawOutputDir?: string;
  jsonlOutputPath?: string;
  statePath?: string;
  minNodes?: number;
}

const DEFAULT_OPTIONS = {
  limit: 10_000,
  rawOutputDir: 'data/airflow_dags',
  jsonlOutputPath: 'data/airflow_dags_v1.jsonl',
  statePath: 'data/airflow_dags_search_state.json',
  minNodes: 2,
} satisfies Required<AirflowCorpusPipelineOptions>;

function payload(
  operation: string,
  options: AirflowCorpusPipelineOptions,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    operation,
    limit: options.limit ?? DEFAULT_OPTIONS.limit,
    rawOutputDir: options.rawOutputDir ?? DEFAULT_OPTIONS.rawOutputDir,
    jsonlOutputPath: options.jsonlOutputPath ?? DEFAULT_OPTIONS.jsonlOutputPath,
    statePath: options.statePath ?? DEFAULT_OPTIONS.statePath,
    minNodes: options.minNodes ?? DEFAULT_OPTIONS.minNodes,
    ...extra,
  });
}

function task(
  type: string,
  title: string,
  operation: string,
  options: AirflowCorpusPipelineOptions,
  extra: Record<string, unknown> = {},
): Task {
  return Task.custom(type, payload(operation, options, extra), {
    title,
    timeout: 900,
    metadata: {
      workflow: 'airflow-corpus-collection-conversion',
      phase: String(extra.phase ?? operation),
      retryable: Boolean(extra.retryable ?? false),
      maxAttempts: Number(extra.maxAttempts ?? 1),
      backoff: Number(extra.backoff ?? 0),
    },
  });
}

export function retryPolicyFor(task: Task): RetryPolicy | undefined {
  if (task.metadata.retryable !== true) return undefined;
  return new RetryPolicy({
    maxAttempts: Number(task.metadata.maxAttempts ?? 3),
    backoff: Number(task.metadata.backoff ?? 2),
  });
}

export function buildAirflowCorpusPipelineGraph(
  options: AirflowCorpusPipelineOptions = {},
): TaskGraph {
  const t = {
    defineSearchStrategy: task(
      AirflowCorpusTaskType.PLAN_SEARCH,
      'define-airflow-search-strategy',
      'define search query families for Airflow DAG discovery',
      options,
      { phase: 'plan' },
    ),
    prepareCollectionState: task(
      AirflowCorpusTaskType.LOAD_STATE,
      'prepare-collection-state',
      'load or initialize persisted search/fetch state',
      options,
      { phase: 'state' },
    ),
    searchOperatorQueries: task(
      AirflowCorpusTaskType.SEARCH_GITHUB,
      'search-operator-queries',
      'search GitHub for operator-specific Airflow DAG files',
      options,
      {
        phase: 'discover',
        queryFamily: 'operators',
        retryable: true,
        maxAttempts: 4,
        backoff: 2,
      },
    ),
    searchDependencyPatternQueries: task(
      AirflowCorpusTaskType.SEARCH_GITHUB,
      'search-dependency-pattern-queries',
      'search GitHub for dependency-expression Airflow DAG files',
      options,
      {
        phase: 'discover',
        queryFamily: 'dependency-patterns',
        retryable: true,
        maxAttempts: 4,
        backoff: 2,
      },
    ),
    searchProviderSpecificQueries: task(
      AirflowCorpusTaskType.SEARCH_GITHUB,
      'search-provider-specific-queries',
      'search GitHub for provider-specific Airflow DAG files',
      options,
      {
        phase: 'discover',
        queryFamily: 'providers',
        retryable: true,
        maxAttempts: 4,
        backoff: 2,
      },
    ),
    searchApacheExamples: task(
      AirflowCorpusTaskType.SEARCH_AIRFLOW_EXAMPLES,
      'search-apache-airflow-examples',
      'discover example DAG files from the apache/airflow repository tree',
      options,
      {
        phase: 'discover',
        retryable: true,
        maxAttempts: 4,
        backoff: 2,
      },
    ),
    mergeSearchResults: task(
      AirflowCorpusTaskType.MERGE_RESULTS,
      'merge-search-results',
      'merge discovered GitHub and apache/airflow result records',
      options,
      { phase: 'normalize' },
    ),
    dedupeRepoPaths: task(
      AirflowCorpusTaskType.DEDUPE_PATHS,
      'dedupe-repo-paths',
      'deduplicate discovered files by repository and path before fetching',
      options,
      { phase: 'normalize' },
    ),
    fetchRawDagFiles: task(
      AirflowCorpusTaskType.FETCH_RAW,
      'fetch-raw-dag-files',
      'fetch raw Python DAG file content from discovered repository paths',
      options,
      {
        phase: 'fetch',
        retryable: true,
        maxAttempts: 3,
        backoff: 2,
      },
    ),
    retryFailedFetches: task(
      AirflowCorpusTaskType.RETRY_FETCHES,
      'retry-failed-fetches',
      'retry failed raw fetches with backoff and preserve terminal failures for summary',
      options,
      {
        phase: 'fetch',
        retryable: true,
        maxAttempts: 3,
        backoff: 3,
      },
    ),
    contentHashDedupe: task(
      AirflowCorpusTaskType.DEDUPE_CONTENT,
      'content-hash-dedupe',
      'deduplicate fetched DAG files by content hash',
      options,
      { phase: 'normalize' },
    ),
    persistRawPythonFiles: task(
      AirflowCorpusTaskType.PERSIST_RAW,
      'persist-raw-python-files',
      'write unique raw Python DAG files to the raw output directory',
      options,
      { phase: 'persist', retryable: true, maxAttempts: 2, backoff: 1 },
    ),
    parsePythonAst: task(
      AirflowCorpusTaskType.PARSE_AST,
      'parse-python-ast',
      'parse raw Python files into ASTs without importing or executing Airflow code',
      options,
      { phase: 'parse' },
    ),
    detectDagConstructionPatterns: task(
      AirflowCorpusTaskType.DETECT_DAG_PATTERNS,
      'detect-dag-construction-patterns',
      'detect with-DAG blocks, DAG assignments, @dag factories, and task group scopes',
      options,
      { phase: 'parse' },
    ),
    extractTaskDefinitions: task(
      AirflowCorpusTaskType.EXTRACT_TASKS,
      'extract-task-definitions',
      'extract operator assignments, task IDs, payload kwargs, and timeout metadata',
      options,
      { phase: 'extract' },
    ),
    extractDependencyEdges: task(
      AirflowCorpusTaskType.EXTRACT_EDGES,
      'extract-dependency-edges',
      'extract bitshift, chain, cross_downstream, set_upstream, and set_downstream edges',
      options,
      { phase: 'extract' },
    ),
    extractTaskflowAndTaskgroups: task(
      AirflowCorpusTaskType.EXTRACT_TASKFLOW_GROUPS,
      'extract-taskflow-and-taskgroups',
      'extract TaskFlow call sites and flatten TaskGroup-local task references',
      options,
      { phase: 'extract' },
    ),
    buildTtasksTaskgraphs: task(
      AirflowCorpusTaskType.BUILD_TASKGRAPHS,
      'build-ttasks-taskgraphs',
      'classify Airflow operators to ttasks task types and build TaskGraph objects',
      options,
      { phase: 'convert' },
    ),
    dedupeFilterValidateTopologies: task(
      AirflowCorpusTaskType.DEDUPE_VALIDATE,
      'dedupe-filter-validate-topologies',
      'filter small graphs, deduplicate topology hashes, and validate every TaskGraph',
      options,
      { phase: 'validate' },
    ),
    writeAirflowJsonlAndSummary: task(
      AirflowCorpusTaskType.WRITE_JSONL,
      'write-airflow-jsonl-and-summary',
      'serialize validated Airflow TaskGraphs to JSONL and emit collection/conversion summary',
      options,
      { phase: 'write', retryable: true, maxAttempts: 2, backoff: 1 },
    ),
  };

  const graph = new TaskGraph({
    title: 'airflow-corpus-collection-conversion',
  });

  graph.add(t.defineSearchStrategy);
  graph.add(t.prepareCollectionState, { after: [t.defineSearchStrategy] });

  graph.add(t.searchOperatorQueries, { after: [t.prepareCollectionState] });
  graph.add(t.searchDependencyPatternQueries, { after: [t.prepareCollectionState] });
  graph.add(t.searchProviderSpecificQueries, { after: [t.prepareCollectionState] });
  graph.add(t.searchApacheExamples, { after: [t.prepareCollectionState] });

  graph.add(t.mergeSearchResults, {
    after: [
      t.searchOperatorQueries,
      t.searchDependencyPatternQueries,
      t.searchProviderSpecificQueries,
      t.searchApacheExamples,
    ],
  });
  graph.add(t.dedupeRepoPaths, { after: [t.mergeSearchResults] });
  graph.add(t.fetchRawDagFiles, { after: [t.dedupeRepoPaths] });
  graph.add(t.retryFailedFetches, { after: [t.fetchRawDagFiles] });
  graph.add(t.contentHashDedupe, { after: [t.retryFailedFetches] });
  graph.add(t.persistRawPythonFiles, { after: [t.contentHashDedupe] });
  graph.add(t.parsePythonAst, { after: [t.persistRawPythonFiles] });
  graph.add(t.detectDagConstructionPatterns, { after: [t.parsePythonAst] });

  graph.add(t.extractTaskDefinitions, { after: [t.detectDagConstructionPatterns] });
  graph.add(t.extractDependencyEdges, { after: [t.detectDagConstructionPatterns] });
  graph.add(t.extractTaskflowAndTaskgroups, { after: [t.detectDagConstructionPatterns] });

  graph.add(t.buildTtasksTaskgraphs, {
    after: [
      t.extractTaskDefinitions,
      t.extractDependencyEdges,
      t.extractTaskflowAndTaskgroups,
    ],
  });
  graph.add(t.dedupeFilterValidateTopologies, {
    after: [t.buildTtasksTaskgraphs],
  });
  graph.add(t.writeAirflowJsonlAndSummary, {
    after: [t.dedupeFilterValidateTopologies],
  });

  return graph;
}

export function describeAirflowCorpusPipelineGraph(): string {
  return [
    'airflow-corpus-collection-conversion',
    '20 custom typed tasks',
    'shape: [1, 1, 4, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1]',
    'register handlers for each AirflowCorpusTaskType before running',
    'use retryPolicyFor(task) for retryable GitHub/API/fetch/write tasks',
  ].join('\n');
}
