import { apiKeyLease } from '../../shared/agent-credential-lease.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import {
  CREDENTIAL_ACTIVE_EXECUTION_STATUSES,
  RESOLVE_AGENT_CREDENTIALS,
  authorizeAgentCredentialRequest,
  authorizeCredentialRequest,
  executionIncludesRepository,
  executionLinksRepository,
  loggableAgentCredentialErrorCode,
} from '../index.js';
import { signAgentCredentialGrant } from '../../shared/agent-credential-grants.js';
import { legacyConnection } from '../../shared/agent-connection-repository.js';
import { connectionBinding } from '../../shared/agent-binding-selection.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const secretsMock = mockClient(SecretsManagerClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

describe('credential broker authorization', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.stubEnv('V2_PROCESS_TABLE', 'process');
    vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'bindings');
  });

  it('requires the repository and provider to be on the execution snapshot', () => {
    const meta = {
      gitProvider: 'github',
      repos: ['Acme/API', { url: 'group/web', provider: 'gitlab' }],
    };
    expect(executionIncludesRepository(meta, 'github', 'acme/api')).toBe(true);
    expect(executionIncludesRepository(meta, 'gitlab', 'group/web')).toBe(true);
    expect(executionIncludesRepository(meta, 'github', 'group/web')).toBe(false);
    expect(executionIncludesRepository(meta, 'github', 'acme/other')).toBe(false);
  });

  it('supports the explicit per-repository provider snapshot', () => {
    const meta = {
      gitProvider: 'github',
      repos: ['group/web'],
      repoProviders: { 'group/web': 'gitlab' },
    };
    expect(executionIncludesRepository(meta, 'gitlab', 'group/web')).toBe(true);
    expect(executionIncludesRepository(meta, 'github', 'group/web')).toBe(false);
  });

  it('only permits credentials while an execution can perform repository work', () => {
    expect([...CREDENTIAL_ACTIVE_EXECUTION_STATUSES]).toEqual(['CREATED', 'RUNNING']);
    for (const status of ['DRAFT', 'FAILED', 'CANCELLED', 'SUCCEEDED']) {
      expect(CREDENTIAL_ACTIVE_EXECUTION_STATUSES.has(status)).toBe(false);
    }
  });

  it.each(['DRAFT', 'FAILED', 'CANCELLED', 'SUCCEEDED'])(
    'denies credential resolution for terminal/inactive status %s',
    async (status) => {
      ddbMock.on(GetCommand, { TableName: 'process' }).resolves({
        Item: {
          projectId: 'p1',
          status,
          repos: ['acme/api'],
          gitProvider: 'github',
        },
      });
      await expect(
        authorizeCredentialRequest(
          {
            executionId: 'e1',
            projectId: 'p1',
            provider: 'github',
            repository: 'acme/api',
          },
          { ddbClient: ddb },
        ),
      ).rejects.toMatchObject({ code: 'EXECUTION_NOT_ACTIVE' });
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    },
  );

  it('denies a repository that was not snapshotted onto the execution', async () => {
    ddbMock.on(GetCommand, { TableName: 'process' }).resolves({
      Item: {
        projectId: 'p1',
        status: 'RUNNING',
        repos: ['acme/allowed'],
        gitProvider: 'github',
      },
    });
    await expect(
      authorizeCredentialRequest(
        {
          executionId: 'e1',
          projectId: 'p1',
          provider: 'github',
          repository: 'acme/other',
        },
        { ddbClient: ddb },
      ),
    ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_ON_EXECUTION' });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
  });
});

// META.cliSync links a workspace repository for CLI progress sync. The engine
// may read it and nothing more; everything else about the request is checked
// exactly as for the execution's own repositories.
describe('credential broker: linked workspace repository', () => {
  const stsMock = mockClient(STSClient);
  const sts = new STSClient({});
  const ROLE_ARN = 'arn:aws:iam::111122223333:role/aidlc-codecommit';
  const EXTERNAL_ID = 'aidlc:0b0e6c1e-6a52-4d0c-9d58-3f6a3b1f2c11';
  const WORKSPACE = 'arn:aws:codecommit:eu-west-1:111122223333:team-workspace';
  const CODE_REPO = 'arn:aws:codecommit:eu-west-1:111122223333:payments';

  const execution = (overrides = {}) => ({
    projectId: 'p1',
    status: 'RUNNING',
    repos: [CODE_REPO],
    gitProvider: 'codecommit',
    cliSync: { provider: 'codecommit', repo: WORKSPACE, branch: 'cli-work' },
    ...overrides,
  });
  const roleBinding = (overrides = {}) => ({
    projectId: 'p1',
    provider: 'codecommit',
    repo: WORKSPACE,
    authType: 'codecommit-role',
    status: 'active',
    roleArn: ROLE_ARN,
    externalId: EXTERNAL_ID,
    credentialRef: `codecommit-role#${ROLE_ARN}#${EXTERNAL_ID}`,
    capabilities: { repositoryWrite: true },
    ...overrides,
  });
  const stub = ({ meta = execution(), binding = roleBinding() } = {}) => {
    ddbMock.on(GetCommand, { TableName: 'process' }).resolves({ Item: meta });
    ddbMock.on(GetCommand, { TableName: 'bindings' }).resolves({ Item: binding ?? undefined });
  };
  const request = (overrides = {}) => ({
    executionId: 'e1',
    projectId: 'p1',
    provider: 'codecommit',
    repository: WORKSPACE,
    requiredAccess: 'read',
    ...overrides,
  });
  const authorize = (overrides) =>
    authorizeCredentialRequest(request(overrides), { ddbClient: ddb, stsClient: sts });
  const sessionPolicy = () => {
    const calls = stsMock.commandCalls(AssumeRoleCommand);
    expect(calls).toHaveLength(1);
    const policy = JSON.parse(calls[0].args[0].input.Policy);
    return {
      actions: policy.Statement.flatMap((statement) => statement.Action),
      resources: policy.Statement.flatMap((statement) => statement.Resource),
    };
  };

  beforeEach(() => {
    ddbMock.reset();
    ssmMock.reset();
    stsMock.reset();
    vi.stubEnv('V2_PROCESS_TABLE', 'process');
    vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'bindings');
    stsMock.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: 'AKIAEXAMPLE',
        SecretAccessKey: 'example-secret',
        SessionToken: 'example-session',
        Expiration: new Date(Date.now() + 900_000),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('matches only the linked repository and provider', () => {
    const meta = execution();
    expect(executionLinksRepository(meta, 'codecommit', WORKSPACE)).toBe(true);
    expect(executionLinksRepository(meta, 'codecommit', CODE_REPO)).toBe(false);
    expect(executionLinksRepository(meta, 'github', 'acme/workspace')).toBe(false);
    expect(executionLinksRepository({ ...meta, cliSync: null }, 'codecommit', WORKSPACE)).toBe(
      false,
    );
    expect(executionLinksRepository(meta, 'codecommit', 'not-an-arn')).toBe(false);
    // The link does not make it a code repository of the execution.
    expect(executionIncludesRepository(meta, 'codecommit', WORKSPACE)).toBe(false);
  });

  it('issues a read-scoped credential for the linked repository', async () => {
    stub();
    const credential = await authorize();

    expect(credential.username).toBeTruthy();
    const { actions, resources } = sessionPolicy();
    expect(actions).toContain('codecommit:GitPull');
    expect(actions).not.toContain('codecommit:GitPush');
    expect(new Set(resources)).toEqual(new Set([WORKSPACE]));
  });

  it.each(['write', 'identity'])('denies %s access to the linked repository', async (access) => {
    stub();
    await expect(authorize({ requiredAccess: access })).rejects.toMatchObject({
      code: 'REPOSITORY_NOT_ON_EXECUTION',
    });
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('denies the default (write) access to the linked repository', async () => {
    stub();
    await expect(authorize({ requiredAccess: undefined })).rejects.toMatchObject({
      code: 'REPOSITORY_NOT_ON_EXECUTION',
    });
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('denies read access to a repository that is neither linked nor on the execution', async () => {
    stub();
    await expect(
      authorize({ repository: 'arn:aws:codecommit:eu-west-1:111122223333:other' }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_ON_EXECUTION' });
  });

  it('denies read access once the repository is unlinked', async () => {
    stub({ meta: execution({ cliSync: undefined }) });
    await expect(authorize()).rejects.toMatchObject({ code: 'REPOSITORY_NOT_ON_EXECUTION' });
  });

  it('denies the linked repository under another provider', async () => {
    stub();
    await expect(
      authorize({ provider: 'github', repository: 'acme/workspace' }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_ON_EXECUTION' });
  });

  it.each(['WAITING', 'FAILED', 'CANCELLED', 'SUCCEEDED', 'DRAFT'])(
    'denies read access to the linked repository while the execution is %s',
    async (status) => {
      stub({ meta: execution({ status }) });
      await expect(authorize()).rejects.toMatchObject({ code: 'EXECUTION_NOT_ACTIVE' });
      expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
    },
  );

  it('denies read access for an execution of another project', async () => {
    stub({ meta: execution({ projectId: 'p2' }) });
    await expect(authorize()).rejects.toMatchObject({ code: 'EXECUTION_NOT_FOUND' });
  });

  it('denies read access when the project binding is missing or not active', async () => {
    stub({ binding: null });
    await expect(authorize()).rejects.toMatchObject({ code: 'SOURCE_CONTROL_NOT_READY' });
    stub({ binding: roleBinding({ status: 'invalid' }) });
    await expect(authorize()).rejects.toMatchObject({ code: 'SOURCE_CONTROL_NOT_READY' });
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('denies read access through a binding that cannot be scoped to read', async () => {
    // A delegated OAuth token is the same token for read and write.
    stub({
      meta: execution({
        repos: ['group/api'],
        gitProvider: 'gitlab',
        cliSync: { provider: 'gitlab', repo: 'group/workspace', branch: 'cli-work' },
      }),
      binding: {
        projectId: 'p1',
        provider: 'gitlab',
        repo: 'group/workspace',
        authType: 'gitlab-oauth',
        status: 'active',
        connectionUserId: 'u1',
        credentialRef: 'oauth#gitlab#u1',
        capabilities: { repositoryWrite: true },
      },
    });
    await expect(
      authorizeCredentialRequest(request({ provider: 'gitlab', repository: 'group/workspace' }), {
        ddbClient: ddb,
        ssmClient: ssm,
        secretsClient: secrets,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
  });

  it('keeps write access to a repository that is both linked and on the execution', async () => {
    stub({ meta: execution({ repos: [CODE_REPO, WORKSPACE] }) });
    await authorize({ requiredAccess: 'write' });
    expect(sessionPolicy().actions).toContain('codecommit:GitPush');
  });
});

describe('agent credential grant authorization', () => {
  const SECRET = 'g'.repeat(48);
  const NOW = Date.parse('2026-09-01T12:00:00.000Z');

  beforeEach(() => {
    ssmMock.reset();
    vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/app/dev');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves only the bindings carried by a valid signed grant', async () => {
    const grant = signAgentCredentialGrant(
      {
        purpose: 'capabilities',
        projectId: 'p-1',
        bindings: [
          { provider: 'bedrock', source: 'space' },
          { provider: 'kiro', source: 'user', userId: 'u-1' },
        ],
      },
      SECRET,
      { now: () => NOW, randomId: () => 'grant-1234567890' },
    );
    const values = new Map([
      ['/app/dev/projects/p-1/agent-credentials/bedrock-bearer-token', 'bedrock-space'],
      ['/app/dev/users/u-1/agent-credentials/kiro-api-key', 'kiro-user'],
    ]);
    ssmMock.on(GetParameterCommand).callsFake((input) => ({
      Parameter: values.has(input.Name)
        ? { Name: input.Name, Value: values.get(input.Name) }
        : undefined,
    }));

    await expect(
      authorizeAgentCredentialRequest(
        { grant },
        {
          ssmClient: ssm,
          secret: SECRET,
          env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
          now: () => NOW,
        },
      ),
    ).resolves.toEqual({
      purpose: 'capabilities',
      projectId: 'p-1',
      executionId: null,
      credentials: [
        {
          binding: { provider: 'bedrock', source: 'space' },
          value: 'bedrock-space',
          lease: apiKeyLease('bedrock-space'),
        },
        {
          binding: { provider: 'kiro', source: 'user', userId: 'u-1' },
          value: 'kiro-user',
          lease: apiKeyLease('kiro-user'),
        },
      ],
    });
    expect(
      ssmMock.commandCalls(GetParameterCommand).map((call) => call.args[0].input.Name),
    ).toEqual([
      '/app/dev/projects/p-1/agent-credentials/bedrock-bearer-token',
      '/app/dev/users/u-1/agent-credentials/kiro-api-key',
    ]);
  });

  it('rejects a tampered grant before reading any credential', async () => {
    const grant = signAgentCredentialGrant(
      {
        purpose: 'execution',
        projectId: 'p-1',
        executionId: 'e-1',
        bindings: [{ provider: 'kiro', source: 'space' }],
      },
      SECRET,
      { now: () => NOW, randomId: () => 'grant-1234567890' },
    );
    const [claims, signature] = grant.split('.');

    await expect(
      authorizeAgentCredentialRequest(
        { grant: `${claims.slice(0, -1)}A.${signature}` },
        {
          ssmClient: ssm,
          secret: SECRET,
          env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' });
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
  });

  // Published key-only runtimes read these bytes: key order included.
  it('keeps the v2 keys wire: an api-key lease beside the top-level value, null when missing', async () => {
    const bedrock = connectionBinding(legacyConnection('legacy-space-bedrock-p-1'), 2);
    const kiro = connectionBinding(legacyConnection('legacy-user-kiro-u-1'), 2);
    const grant = signAgentCredentialGrant(
      { purpose: 'capabilities', projectId: 'p-1', bindings: [kiro, bedrock] },
      SECRET,
      { now: () => NOW, randomId: () => 'grant-1234567890' },
    );
    ssmMock.on(GetParameterCommand).callsFake((input) => {
      if (input.Name === '/app/dev/projects/p-1/agent-credentials/bedrock-bearer-token')
        return { Parameter: { Name: input.Name, Value: 'bedrock-space' } };
      throw Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
    });

    const result = await authorizeAgentCredentialRequest(
      { grant },
      {
        ssmClient: ssm,
        secret: SECRET,
        env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
        now: () => NOW,
      },
    );

    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        purpose: 'capabilities',
        projectId: 'p-1',
        executionId: null,
        credentials: [
          { lease: apiKeyLease('bedrock-space'), binding: bedrock, value: 'bedrock-space' },
          { lease: apiKeyLease(null), binding: kiro, value: null },
        ],
      }),
    );
    expect(
      ssmMock.commandCalls(GetParameterCommand).map((call) => call.args[0].input.Name),
    ).toEqual([
      '/app/dev/projects/p-1/agent-credentials/bedrock-bearer-token',
      '/app/dev/users/u-1/agent-credentials/kiro-api-key',
    ]);
  });

  it('keeps the v1 grant wire byte-identical', async () => {
    const grant = signAgentCredentialGrant(
      {
        purpose: 'discussion',
        projectId: 'p-1',
        bindings: [{ provider: 'bedrock', source: 'platform' }],
      },
      SECRET,
      { now: () => NOW, randomId: () => 'grant-1234567890' },
    );
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'platform-key' } });

    const result = await authorizeAgentCredentialRequest(
      { grant, action: RESOLVE_AGENT_CREDENTIALS },
      {
        ssmClient: ssm,
        secret: SECRET,
        env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
        now: () => NOW,
      },
    );

    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        purpose: 'discussion',
        projectId: 'p-1',
        executionId: null,
        credentials: [
          {
            binding: { provider: 'bedrock', source: 'platform' },
            value: 'platform-key',
            lease: apiKeyLease('platform-key'),
          },
        ],
      }),
    );
  });

  it('requires a grant before loading the signing key', async () => {
    await expect(
      authorizeAgentCredentialRequest(
        { action: RESOLVE_AGENT_CREDENTIALS },
        {
          ssmClient: ssm,
          env: { AGENT_CREDENTIAL_GRANT_SECRET_PARAM: '/app/dev/grant-secret' },
        },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' });
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
  });

  it('logs only allowlisted codes and keeps the five base codes', () => {
    for (const code of [
      'AGENT_CREDENTIAL_GRANT_EXPIRED',
      'AGENT_CREDENTIAL_GRANT_INVALID',
      'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED',
      'AGENT_AUTH_CONNECTION_UNAVAILABLE',
      'AGENT_AUTH_CHANGE_IN_PROGRESS',
    ])
      expect(loggableAgentCredentialErrorCode({ code })).toBe(code);
    for (const error of [
      { code: 'AGENT_AUTH_MODE_UNAVAILABLE' },
      Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' }),
      null,
    ])
      expect(loggableAgentCredentialErrorCode(error)).toBe('AGENT_CREDENTIAL_BROKER_FAILED');
  });
});

describe('concurrent GitLab credential requests (refresh race)', () => {
  const PARAM = '/proj/dev/git-token/gitlab/lane-user';

  const stubTables = () => {
    // Execution snapshot for both requests.
    ddbMock.on(GetCommand, { TableName: 'process' }).resolves({
      Item: {
        projectId: 'p1',
        status: 'RUNNING',
        repos: [{ url: 'group/web', provider: 'gitlab' }],
        gitProvider: 'gitlab',
      },
    });
    // Active gitlab-oauth binding.
    ddbMock.on(GetCommand, { TableName: 'bindings' }).resolves({
      Item: {
        projectId: 'p1',
        bindingKey: 'gitlab#group/web',
        provider: 'gitlab',
        repo: 'group/web',
        authType: 'gitlab-oauth',
        status: 'active',
        connectionUserId: 'lane-user',
        credentialRef: 'oauth#gitlab#lane-user',
        capabilities: { repositoryWrite: true },
      },
    });
    // Delegated user's connection row (composite-key table).
    ddbMock.on(GetCommand, { TableName: 'provider-connections' }).resolves({
      Item: {
        userId: 'lane-user',
        providerInstance: 'gitlab#public',
        provider: 'gitlab',
        parameterName: PARAM,
        scope: 'api read_user',
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
  };

  beforeEach(async () => {
    ddbMock.reset();
    ssmMock.reset();
    secretsMock.reset();
    vi.stubEnv('V2_PROCESS_TABLE', 'process');
    vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'bindings');
    vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'provider-connections');
    vi.stubEnv('GITLAB_OAUTH_SECRET_NAME', 'test/gitlab-oauth');
    delete globalThis.fetch;
    stubTables();
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: {
        Value: JSON.stringify({
          accessToken: 'stale',
          refreshToken: 'r1',
          expiresAt: Date.now() - 1000, // expired → both requests want a refresh
        }),
      },
    });
    ssmMock.on(PutParameterCommand).resolves({});
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'csec' }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.fetch;
  });

  it('resolves both requests with one refresh and never invalidates the binding', async () => {
    // One-time-use refresh token: succeed once, then fail like GitLab would.
    let refreshCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return {
          json: async () => ({
            access_token: 'fresh',
            refresh_token: 'r2',
            token_type: 'bearer',
            expires_in: 7200,
          }),
        };
      }
      return { status: 400, json: async () => ({ error: 'invalid_grant' }) };
    });

    const request = {
      executionId: 'e1',
      projectId: 'p1',
      provider: 'gitlab',
      repository: 'group/web',
      requiredAccess: 'write',
    };
    const [a, b] = await Promise.all([
      authorizeCredentialRequest(request, {
        ddbClient: ddb,
        ssmClient: ssm,
        secretsClient: secrets,
      }),
      authorizeCredentialRequest(request, {
        ddbClient: ddb,
        ssmClient: ssm,
        secretsClient: secrets,
      }),
    ]);

    expect(a.token).toBe('fresh');
    expect(b.token).toBe('fresh');
    expect(refreshCalls).toBe(1);
    // The losing request must NOT have marked the binding invalid.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
