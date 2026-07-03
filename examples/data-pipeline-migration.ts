import { Task, TaskGraph } from '@ianphil/ttasks-ts';

export interface DataPipelineMigrationOptions {
  sourcePipeline?: string;
  targetPlatform?: string;
  workingDirectory?: string;
}

const DEFAULT_SOURCE = 'the current production data pipeline';
const DEFAULT_TARGET = 'the new target pipeline platform';

function context(options: DataPipelineMigrationOptions): string {
  return [
    `Source pipeline: ${options.sourcePipeline ?? DEFAULT_SOURCE}.`,
    `Target platform: ${options.targetPlatform ?? DEFAULT_TARGET}.`,
    options.workingDirectory
      ? `Working directory: ${options.workingDirectory}.`
      : 'Use the repository working directory provided by the agent session.',
    'Produce concise artifacts that downstream tasks can consume.',
  ].join('\n');
}

function agentTask(
  title: string,
  prompt: string,
  options: DataPipelineMigrationOptions,
): Task {
  return Task.agent(`${context(options)}\n\nTask: ${prompt}`, {
    title,
    timeout: 900,
    metadata: {
      workflow: 'data-pipeline-migration-validation-gates',
    },
  });
}

export function buildDataPipelineMigrationGraph(
  options: DataPipelineMigrationOptions = {},
): TaskGraph {
  const tasks = {
    inventoryCurrentPipeline: agentTask(
      'inventory-current-pipeline',
      'Inventory the current pipeline: entrypoints, schedules, inputs, outputs, storage locations, owners, and operational assumptions.',
      options,
    ),
    mapDependencies: agentTask(
      'map-dependencies',
      'Map upstream and downstream dependencies. Identify external systems, implicit contracts, retry behavior, and ordering constraints.',
      options,
    ),
    snapshotCurrentOutputs: agentTask(
      'snapshot-current-outputs',
      'Define and capture representative current-output snapshots for later parity checks. Include row counts, schemas, checksums, and sample records where appropriate.',
      options,
    ),
    designTargetSchema: agentTask(
      'design-target-schema',
      'Design the target schema and data contracts. Call out intentional changes, compatibility shims, and fields that must remain byte-for-byte equivalent.',
      options,
    ),
    migrateExtractLayer: agentTask(
      'migrate-extract-layer',
      'Plan or implement the extract-layer migration. Preserve source filtering, pagination, credentials boundaries, and incremental cursor semantics.',
      options,
    ),
    migrateTransformLayer: agentTask(
      'migrate-transform-layer',
      'Plan or implement the transform-layer migration. Preserve business rules, null handling, joins, aggregations, and type conversions.',
      options,
    ),
    migrateLoadLayer: agentTask(
      'migrate-load-layer',
      'Plan or implement the load-layer migration. Preserve write modes, idempotency, partitioning, deduplication, and destination constraints.',
      options,
    ),
    buildAdapterA: agentTask(
      'build-extract-adapter',
      'Build or specify the compatibility adapter for extract outputs so downstream validation can compare old and new data.',
      options,
    ),
    buildAdapterB: agentTask(
      'build-transform-adapter',
      'Build or specify the compatibility adapter for transformed records, normalizing expected representation differences before comparison.',
      options,
    ),
    buildAdapterC: agentTask(
      'build-load-adapter',
      'Build or specify the compatibility adapter for loaded data, including destination reads and canonical ordering for comparisons.',
      options,
    ),
    runExtractTests: agentTask(
      'run-extract-tests',
      'Run or design extract-layer tests. Verify connectivity, incremental windows, counts, schema, and representative source payload parity.',
      options,
    ),
    runTransformTests: agentTask(
      'run-transform-tests',
      'Run or design transform-layer tests. Verify rule parity, edge cases, null behavior, join behavior, and aggregation totals.',
      options,
    ),
    runLoadTests: agentTask(
      'run-load-tests',
      'Run or design load-layer tests. Verify idempotency, partition writes, destination constraints, duplicate handling, and rollback safety.',
      options,
    ),
    compareOldNewOutputs: agentTask(
      'compare-old-new-outputs',
      'Compare old and new outputs using the snapshots and adapters. Produce a drift report grouped by schema, counts, checksums, and record-level differences.',
      options,
    ),
    investigateDrift: agentTask(
      'investigate-drift',
      'Investigate every material drift finding. Classify each as expected change, migration bug, source nondeterminism, or test harness issue.',
      options,
    ),
    patchIncompatibilities: agentTask(
      'patch-incompatibilities',
      'Patch or specify fixes for migration bugs and compatibility gaps. Preserve behavior unless an intentional contract change is documented.',
      options,
    ),
    runBackfillDryRun: agentTask(
      'run-backfill-dry-run',
      'Run or design a backfill dry run. Verify runtime, restartability, checkpointing, output volume, and rollback plan.',
      options,
    ),
    runPerformanceCheck: agentTask(
      'run-performance-check',
      'Run or design performance checks. Compare throughput, resource usage, latency, cost, and operational headroom against the current pipeline.',
      options,
    ),
    approvalGate: agentTask(
      'approval-gate',
      'Summarize readiness for approval. Include unresolved risks, drift status, rollback readiness, monitoring requirements, and go/no-go recommendation.',
      options,
    ),
    cutoverPlan: agentTask(
      'cutover-plan',
      'Create the final cutover plan: sequencing, owners, timing, feature flags, monitoring, rollback triggers, and post-cutover validation.',
      options,
    ),
  };

  const graph = new TaskGraph({
    title: 'data-pipeline-migration-validation-gates',
  });

  graph.add(tasks.inventoryCurrentPipeline);
  graph.add(tasks.mapDependencies, {
    after: [tasks.inventoryCurrentPipeline],
  });
  graph.add(tasks.snapshotCurrentOutputs, {
    after: [tasks.mapDependencies],
  });
  graph.add(tasks.designTargetSchema, {
    after: [tasks.mapDependencies],
  });

  graph.add(tasks.migrateExtractLayer, {
    after: [tasks.snapshotCurrentOutputs, tasks.designTargetSchema],
  });
  graph.add(tasks.migrateTransformLayer, {
    after: [tasks.snapshotCurrentOutputs, tasks.designTargetSchema],
  });
  graph.add(tasks.migrateLoadLayer, {
    after: [tasks.snapshotCurrentOutputs, tasks.designTargetSchema],
  });

  graph.add(tasks.buildAdapterA, { after: [tasks.migrateExtractLayer] });
  graph.add(tasks.buildAdapterB, { after: [tasks.migrateTransformLayer] });
  graph.add(tasks.buildAdapterC, { after: [tasks.migrateLoadLayer] });

  graph.add(tasks.runExtractTests, { after: [tasks.buildAdapterA] });
  graph.add(tasks.runTransformTests, { after: [tasks.buildAdapterB] });
  graph.add(tasks.runLoadTests, { after: [tasks.buildAdapterC] });

  graph.add(tasks.compareOldNewOutputs, {
    after: [
      tasks.runExtractTests,
      tasks.runTransformTests,
      tasks.runLoadTests,
    ],
  });
  graph.add(tasks.investigateDrift, {
    after: [tasks.compareOldNewOutputs],
  });
  graph.add(tasks.patchIncompatibilities, {
    after: [tasks.investigateDrift],
  });
  graph.add(tasks.runBackfillDryRun, {
    after: [tasks.patchIncompatibilities],
  });
  graph.add(tasks.runPerformanceCheck, {
    after: [tasks.runBackfillDryRun],
  });
  graph.add(tasks.approvalGate, {
    after: [tasks.runPerformanceCheck],
  });
  graph.add(tasks.cutoverPlan, {
    after: [tasks.approvalGate],
  });

  return graph;
}

export function describeDataPipelineMigrationGraph(): string {
  return [
    'data-pipeline-migration-validation-gates',
    '20 agent tasks',
    'shape: [1, 1, 2, 3, 3, 3, 1, 1, 1, 1, 1, 1, 1]',
    'run with maxWorkers: 1 when using a shared CopilotAgentSession',
  ].join('\n');
}
