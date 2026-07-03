import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  RetryPolicy,
  Task,
  TaskExecutor,
  TaskGraph,
  type TaskContext,
} from '@ianphil/ttasks-ts';

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

export interface AirflowCorpusSmokeResult {
  ok: boolean;
  tasks: number;
  retryableTasks: string[];
  final: {
    input_dir: string;
    output: string;
    total_files: number;
    read: number;
    converted: number;
    skipped: number;
    unique_topologies: number;
    lines: number;
  };
}

interface SearchResult {
  repo: string;
  path: string;
  sha?: string;
  htmlUrl?: string;
}

interface FetchedDag extends SearchResult {
  content: string;
  hash: string;
  localPath?: string;
}

const execFileAsync = promisify(execFile);

function jsonResult(value: unknown): string {
  return JSON.stringify(value);
}

function upstreamJson<T>(ctx: TaskContext, title: string): T {
  for (const task of ctx.upstream.values()) {
    if (task.title === title && task.result?.output) {
      return JSON.parse(task.result.output) as T;
    }
  }
  throw new Error(`missing upstream output: ${title}`);
}

function allUpstreamJson(ctx: TaskContext): unknown[] {
  return [...ctx.upstream.values()].map((task) =>
    JSON.parse(task.result?.output ?? 'null'),
  );
}

function sha16(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

async function ghCodeSearch(query: string, perPage: number): Promise<SearchResult[]> {
  const { stdout } = await execFileAsync(
    'gh',
    [
      'api',
      '-X',
      'GET',
      'search/code',
      '-f',
      `q=${query}`,
      '-f',
      `per_page=${perPage}`,
      '-f',
      'page=1',
    ],
    { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout) as {
    items?: Array<{
      repository: { full_name: string };
      path: string;
      sha?: string;
      html_url?: string;
    }>;
  };
  return (data.items ?? []).map((item) => ({
    repo: item.repository.full_name,
    path: item.path,
    sha: item.sha ?? '',
    htmlUrl: item.html_url ?? '',
  }));
}

async function fetchRaw(repo: string, path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo}/HEAD/${path}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`fetch ${url} failed: ${response.status}`);
  }
  return await response.text();
}

async function findApacheAirflowExamples(limit: number): Promise<SearchResult[]> {
  const response = await fetch(
    'https://api.github.com/repos/apache/airflow/git/trees/HEAD?recursive=1',
    {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    throw new Error(`apache/airflow tree fetch failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    tree?: Array<{ path?: string; sha?: string }>;
  };
  return (data.tree ?? [])
    .filter((entry) => {
      const path = entry.path ?? '';
      return (
        path.endsWith('.py') &&
        path.includes('example_dags') &&
        (path.split('/').at(-1) ?? '').includes('example_')
      );
    })
    .slice(0, limit)
    .map((entry) => ({
      repo: 'apache/airflow',
      path: entry.path!,
      sha: entry.sha ?? '',
      htmlUrl: `https://github.com/apache/airflow/blob/HEAD/${entry.path}`,
    }));
}

async function convertWithWtdLibrary(
  inputDir: string,
  outputPath: string,
  minNodes: number,
): Promise<AirflowCorpusSmokeResult['final']> {
  const python = `
import json
from pathlib import Path
from wmd_wtd.airflow_to_ttasks import airflow_dag_to_taskgraphs
from wmd_wtd.data import graph_to_serializable
from wmd_wtd.github_to_ttasks import topology_hash

input_dir = Path(${JSON.stringify(inputDir)})
output = Path(${JSON.stringify(outputPath)})
output.parent.mkdir(parents=True, exist_ok=True)
read = converted = skipped = 0
seen = set()
with open(output, 'w') as out:
    for path in sorted(input_dir.glob('*.py')):
        read += 1
        graphs = airflow_dag_to_taskgraphs(path)
        if not graphs:
            skipped += 1
            continue
        for graph in graphs:
            if len(graph) < ${minNodes}:
                skipped += 1
                continue
            h = topology_hash(graph)
            if h in seen:
                skipped += 1
                continue
            seen.add(h)
            graph._validate()
            out.write(json.dumps(graph_to_serializable(graph, 'airflow')) + '\\n')
            converted += 1
summary = {
    'input_dir': str(input_dir),
    'output': str(output),
    'total_files': len(list(input_dir.glob('*.py'))),
    'read': read,
    'converted': converted,
    'skipped': skipped,
    'unique_topologies': len(seen),
}
print(json.dumps(summary))
`;

  const { stdout, stderr } = await execFileAsync(
    'uv',
    ['run', 'python', '-c', python],
    {
      cwd: '/Users/ianphil/src/wmd-wtd',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (stderr.trim()) process.stderr.write(stderr);
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as AirflowCorpusSmokeResult['final'];
}

export function registerTinyRealAirflowCorpusHandlers(
  executor: TaskExecutor,
): void {
  function register(
    type: string,
    handler: (ctx: TaskContext) => Promise<unknown> | unknown,
  ): void {
    executor.register(type, async (ctx) => jsonResult(await handler(ctx)));
  }

  register(AirflowCorpusTaskType.PLAN_SEARCH, () => ({
    operatorQueries: ['BashOperator path:dags extension:py airflow'],
    dependencyQueries: ['with DAG path:dags extension:py airflow'],
    providerQueries: ['PythonOperator path:dags extension:py airflow'],
    exampleQuery: 'apache/airflow examples via repository tree',
  }));

  register(AirflowCorpusTaskType.LOAD_STATE, (ctx) => ({
    statePath: JSON.parse(ctx.payload).statePath,
    seen: [],
  }));

  register(AirflowCorpusTaskType.SEARCH_GITHUB, async (ctx) => {
    const payload = JSON.parse(ctx.payload) as { queryFamily?: string };
    const queryByFamily: Record<string, string> = {
      operators: 'BashOperator path:dags extension:py airflow',
      'dependency-patterns': 'with DAG path:dags extension:py airflow',
      providers: 'PythonOperator path:dags extension:py airflow',
    };
    const query = queryByFamily[payload.queryFamily ?? 'operators'];
    return {
      queryFamily: payload.queryFamily,
      results: await ghCodeSearch(query, 5),
    };
  });

  register(AirflowCorpusTaskType.SEARCH_AIRFLOW_EXAMPLES, async () => ({
    queryFamily: 'apache-examples',
    results: await findApacheAirflowExamples(5),
  }));

  register(AirflowCorpusTaskType.MERGE_RESULTS, (ctx) => ({
    results: allUpstreamJson(ctx).flatMap((item) =>
      ((item as { results?: SearchResult[] }).results ?? []),
    ),
  }));

  register(AirflowCorpusTaskType.DEDUPE_PATHS, (ctx) => {
    const payload = JSON.parse(ctx.payload) as { limit: number };
    const { results } = upstreamJson<{ results: SearchResult[] }>(
      ctx,
      'merge-search-results',
    );
    const seen = new Set<string>();
    const deduped: SearchResult[] = [];
    for (const result of results) {
      const key = `${result.repo}:${result.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(result);
      if (deduped.length >= payload.limit) break;
    }
    return { results: deduped };
  });

  register(AirflowCorpusTaskType.FETCH_RAW, async (ctx) => {
    const { results } = upstreamJson<{ results: SearchResult[] }>(
      ctx,
      'dedupe-repo-paths',
    );
    const fetched: FetchedDag[] = [];
    const failed: Array<SearchResult & { error: string }> = [];
    for (const result of results) {
      try {
        const content = await fetchRaw(result.repo, result.path);
        fetched.push({ ...result, content, hash: sha16(content) });
      } catch (error) {
        failed.push({ ...result, error: String(error) });
      }
    }
    return { fetched, failed };
  });

  register(AirflowCorpusTaskType.RETRY_FETCHES, async (ctx) => {
    const prior = upstreamJson<{
      fetched: FetchedDag[];
      failed: Array<SearchResult & { error: string }>;
    }>(ctx, 'fetch-raw-dag-files');
    const fetched = [...prior.fetched];
    const failed: Array<SearchResult & { error: string }> = [];
    for (const result of prior.failed) {
      try {
        const content = await fetchRaw(result.repo, result.path);
        fetched.push({ ...result, content, hash: sha16(content) });
      } catch (error) {
        failed.push({ ...result, error: String(error) });
      }
    }
    return { fetched, failed };
  });

  register(AirflowCorpusTaskType.DEDUPE_CONTENT, (ctx) => {
    const prior = upstreamJson<{
      fetched: FetchedDag[];
      failed: Array<SearchResult & { error: string }>;
    }>(ctx, 'retry-failed-fetches');
    const seen = new Set<string>();
    const fetched = prior.fetched.filter((item) => {
      if (seen.has(item.hash)) return false;
      seen.add(item.hash);
      return true;
    });
    return { fetched, failed: prior.failed };
  });

  register(AirflowCorpusTaskType.PERSIST_RAW, async (ctx) => {
    const payload = JSON.parse(ctx.payload) as { rawOutputDir: string };
    const prior = upstreamJson<{
      fetched: FetchedDag[];
      failed: Array<SearchResult & { error: string }>;
    }>(ctx, 'content-hash-dedupe');
    await mkdir(payload.rawOutputDir, { recursive: true });
    const files: FetchedDag[] = [];
    for (const item of prior.fetched) {
      const safeName = `${item.repo.replaceAll('/', '__')}__${item.path.replaceAll('/', '__')}`;
      const localPath = join(payload.rawOutputDir, safeName);
      await writeFile(localPath, item.content);
      files.push({ ...item, localPath });
    }
    return { files, failed: prior.failed };
  });

  register(AirflowCorpusTaskType.PARSE_AST, (ctx) =>
    upstreamJson(ctx, 'persist-raw-python-files'),
  );
  register(AirflowCorpusTaskType.DETECT_DAG_PATTERNS, (ctx) =>
    upstreamJson(ctx, 'parse-python-ast'),
  );
  register(AirflowCorpusTaskType.EXTRACT_TASKS, (ctx) =>
    upstreamJson(ctx, 'detect-dag-construction-patterns'),
  );
  register(AirflowCorpusTaskType.EXTRACT_EDGES, (ctx) =>
    upstreamJson(ctx, 'detect-dag-construction-patterns'),
  );
  register(AirflowCorpusTaskType.EXTRACT_TASKFLOW_GROUPS, (ctx) =>
    upstreamJson(ctx, 'detect-dag-construction-patterns'),
  );

  register(AirflowCorpusTaskType.BUILD_TASKGRAPHS, async (ctx) => {
    const payload = JSON.parse(ctx.payload) as {
      rawOutputDir: string;
      jsonlOutputPath: string;
      minNodes: number;
    };
    return await convertWithWtdLibrary(
      payload.rawOutputDir,
      payload.jsonlOutputPath,
      payload.minNodes,
    );
  });

  register(AirflowCorpusTaskType.DEDUPE_VALIDATE, (ctx) =>
    upstreamJson(ctx, 'build-ttasks-taskgraphs'),
  );

  register(AirflowCorpusTaskType.WRITE_JSONL, async (ctx) => {
    const summary = upstreamJson<AirflowCorpusSmokeResult['final']>(
      ctx,
      'dedupe-filter-validate-topologies',
    );
    const text = await readFile(summary.output, 'utf8').catch(() => '');
    return {
      ...summary,
      lines: text.trim() ? text.trim().split('\n').length : 0,
    };
  });
}

export async function runTinyRealAirflowCorpusSmoke(
  options: AirflowCorpusPipelineOptions = {},
): Promise<AirflowCorpusSmokeResult> {
  const rawOutputDir =
    options.rawOutputDir ?? '/tmp/ttasks-airflow-real/run/raw';
  const jsonlOutputPath =
    options.jsonlOutputPath ?? '/tmp/ttasks-airflow-real/run/airflow_dags_v1.jsonl';
  const statePath =
    options.statePath ?? '/tmp/ttasks-airflow-real/run/state.json';
  const graph = buildAirflowCorpusPipelineGraph({
    limit: 2,
    minNodes: 2,
    ...options,
    rawOutputDir,
    jsonlOutputPath,
    statePath,
  });
  const executor = new TaskExecutor();
  registerTinyRealAirflowCorpusHandlers(executor);

  await graph.run(executor, { maxWorkers: 4 });
  if (!graph.ok) {
    const failed = graph.requiredFailed.map((task) => [
      task.title,
      task.result?.error ?? task.error,
    ]);
    const blocked = graph.requiredBlocked.map((task) => [
      task.title,
      task.blockedBy,
    ]);
    throw new Error(
      `Airflow corpus smoke failed: ${JSON.stringify({ failed, blocked })}`,
    );
  }

  const finalTask = graph.tasks.find(
    (task) => task.title === 'write-airflow-jsonl-and-summary',
  );
  if (!finalTask?.result?.output) {
    throw new Error('Airflow corpus smoke did not produce a final summary');
  }
  return {
    ok: graph.ok,
    tasks: graph.length,
    retryableTasks: graph.tasks
      .filter((task) => retryPolicyFor(task))
      .map((task) => task.title),
    final: JSON.parse(finalTask.result.output) as AirflowCorpusSmokeResult['final'],
  };
}
