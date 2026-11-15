import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const terraformPath = new URL('../../../terraform/modules/api/lambda/main.tf', import.meta.url);

describe('v2-orchestrator IAM role policy', () => {
  it('grants ConditionCheckItem on the process table so ownership fences can transact-write', async () => {
    // updateForRun, deleteWorkflowCheckpoint and finalizeUnitCompletion
    // (lambda/shared/v2-process-store.js) fence the run and the unit plan with
    // ConditionCheck entries inside TransactWriteItems. DynamoDB authorizes
    // each one as dynamodb:ConditionCheckItem; without it the transaction is
    // denied (not a conditional failure) and the intent ends FAILED.
    const terraform = await readFile(terraformPath, 'utf8');
    const orchestratorPolicy = terraform.match(
      /resource "aws_iam_role_policy" "v2_orchestrator" \{([\s\S]*?)^\}/m,
    )?.[1];
    expect(orchestratorPolicy).toBeTruthy();

    const processTableAction = orchestratorPolicy.match(
      /# v2 process table[\s\S]*?Action\s*=\s*\[([^\]]*)\]/,
    )?.[1];
    expect(processTableAction).toBeTruthy();
    expect(processTableAction).toContain('"dynamodb:ConditionCheckItem"');
  });

  it('can invoke the intents Lambda for CLI sync, and is told its name', async () => {
    // The CLI sync step (index.js defaultSyncCliProgress) invokes the intents
    // Lambda's internal sync-cli-progress action by INTENTS_FUNCTION.
    const terraform = await readFile(terraformPath, 'utf8');
    const orchestratorPolicy = terraform.match(
      /resource "aws_iam_role_policy" "v2_orchestrator" \{([\s\S]*?)^\}/m,
    )?.[1];
    expect(orchestratorPolicy).toMatch(
      /Action\s*=\s*\["lambda:InvokeFunction"\]\s*Resource\s*=\s*\[local\.intents_function_arn\]/,
    );
    const orchestratorModule = terraform.match(
      /module "v2_orchestrator_lambda" \{([\s\S]*?)^\}/m,
    )?.[1];
    expect(orchestratorModule).toMatch(/INTENTS_FUNCTION\s*=\s*local\.intents_function_name/);
    expect(terraform).toMatch(
      /intents_function_name\s*=\s*"\$\{var\.project_name\}-intents-\$\{var\.environment\}"/,
    );
    expect(terraform).toMatch(
      /module "intents_lambda" \{[\s\S]*?function_name = "\$\{var\.project_name\}-intents-\$\{var\.environment\}"/,
    );
  });
});
