// completeSyncedStages against the PRODUCTION process store on DynamoDB Local.
// A fake cannot prove the fence: it is DynamoDB that evaluates `fromStatus`
// and `ifOrchestratorRunId`, and the claim under test is that a sync whose run
// lost the intent (cancel, rewind, relaunch) completes no stage and leaves the
// previous baseline in effect.
//
// The root test runner starts DynamoDB Local (test/dynamodb-setup.js).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createProcessStore } from '../v2-process-store.js';

const link = (baselineId, lastSyncedSha) => ({
  repo: 'acme/workspace',
  provider: 'github',
  branch: 'cli-work',
  linkedBy: 'u1',
  linkedAt: '2026-11-15T09:00:00.000Z',
  baselineId,
  lastSyncedSha,
  lastSyncedAt: '2026-11-15T09:00:00.000Z',
});
const OLD = link('0b7a2f4e-2c1d-4e8f-9a6b-3d5c7e9f1a2b', 'a'.repeat(40));
const NEW = link('6f1d3c2b-8a4e-4b7f-9c0d-1e2f3a4b5c6d', 'b'.repeat(40));

describe.skipIf(!process.env.DYNAMODB_LOCAL_ENDPOINT)(
  'CLI sync stage completion against the production process store',
  () => {
    const table = `v2-proc-cli-sync-${randomUUID()}`;
    let raw;
    let store;

    beforeAll(async () => {
      raw = new DynamoDBClient({
        endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      await raw.send(
        new CreateTableCommand({
          TableName: table,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'sk', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
        }),
      );
      store = createProcessStore({ ddb: DynamoDBDocumentClient.from(raw), tableName: table });
    }, 60_000);

    afterAll(async () => {
      await raw?.send(new DeleteTableCommand({ TableName: table })).catch(() => {});
      raw?.destroy();
    });

    // A running walk linked to a branch: Requirements is RUNNING from an
    // earlier attempt, Planning has no row yet.
    const seed = async () => {
      const executionId = `i-${randomUUID()}`;
      await store.createExecution({
        executionId,
        intentId: executionId,
        projectId: 'p1',
        status: 'CREATED',
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        scope: 'feature',
        startedAt: 'T',
        startedBy: 'u1',
        repos: ['owner/repo'],
        branch: `aidlc/${executionId}`,
        baseBranch: 'main',
        gitProvider: 'github',
        agentCli: 'kiro',
      });
      await store.updateExecution({ executionId, status: 'RUNNING', orchestratorRunId: 'run-1' });
      await store.updateExecution({ executionId, cliSync: OLD });
      await store.putStage({
        executionId,
        stageInstanceId: 'si-req',
        stageId: 'requirements-analysis',
        phase: 'inception',
        state: 'PENDING',
      });
      return executionId;
    };

    const completions = [
      {
        stageInstanceId: 'si-req',
        stageId: 'requirements-analysis',
        phase: 'inception',
        completedAt: '2026-11-15T10:00:00.000Z',
        expectedState: 'PENDING',
      },
      {
        stageInstanceId: 'si-plan',
        stageId: 'workflow-planning',
        phase: 'inception',
        completedAt: '2026-11-15T10:05:00.000Z',
        expectedState: null,
      },
    ];

    it('completes existing and missing stage rows and switches the baseline together', async () => {
      const executionId = await seed();

      const meta = await store.completeSyncedStages({
        executionId,
        orchestratorRunId: 'run-1',
        completions,
        aidlcRepoRef: 'r'.repeat(40),
        cliSync: NEW,
      });

      expect(meta).toMatchObject({ status: 'RUNNING', orchestratorRunId: 'run-1', cliSync: NEW });
      expect(await store.getStage(executionId, 'si-req', { consistentRead: true })).toMatchObject({
        state: 'SUCCEEDED',
        completedAt: '2026-11-15T10:00:00.000Z',
        pendingHumanTaskId: null,
      });
      expect(await store.getStage(executionId, 'si-plan', { consistentRead: true })).toMatchObject({
        stageId: 'workflow-planning',
        phase: 'inception',
        state: 'SUCCEEDED',
        completedAt: '2026-11-15T10:05:00.000Z',
        aidlcRepoRef: 'r'.repeat(40),
      });
    });

    const expectUntouched = async (executionId) => {
      expect((await store.getExecution(executionId, { consistentRead: true })).cliSync).toEqual(
        OLD,
      );
      expect((await store.getStage(executionId, 'si-req', { consistentRead: true })).state).toBe(
        'PENDING',
      );
      expect(await store.getStage(executionId, 'si-plan', { consistentRead: true })).toBeNull();
    };

    it('writes nothing when another run owns the intent', async () => {
      const executionId = await seed();
      await store.updateExecution({ executionId, orchestratorRunId: 'run-2' });

      await expect(
        store.completeSyncedStages({
          executionId,
          orchestratorRunId: 'run-1',
          completions,
          cliSync: NEW,
        }),
      ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
      await expectUntouched(executionId);
    });

    it('writes nothing when the intent is no longer running', async () => {
      const executionId = await seed();
      await store.updateExecution({ executionId, status: 'CANCELLED' });

      await expect(
        store.completeSyncedStages({
          executionId,
          orchestratorRunId: 'run-1',
          completions,
          cliSync: NEW,
        }),
      ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
      await expectUntouched(executionId);
    });

    it('writes nothing when a stage row changed since the plan', async () => {
      const executionId = await seed();
      await store.updateStageState({ executionId, stageInstanceId: 'si-req', state: 'RUNNING' });

      await expect(
        store.completeSyncedStages({
          executionId,
          orchestratorRunId: 'run-1',
          completions,
          cliSync: NEW,
        }),
      ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
      expect((await store.getExecution(executionId, { consistentRead: true })).cliSync).toEqual(
        OLD,
      );
      expect(await store.getStage(executionId, 'si-plan', { consistentRead: true })).toBeNull();
    });
  },
);
