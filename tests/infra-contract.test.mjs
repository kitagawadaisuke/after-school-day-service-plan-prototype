import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateUrl = new URL("../infra/main.template.json", import.meta.url);
const templateText = await readFile(templateUrl, "utf8");
const template = JSON.parse(templateText);
const resources = template.Resources;
const migrationTemplateText = await readFile(
  new URL("../infra/migration-task.template.json", import.meta.url),
  "utf8",
);
const migrationTemplate = JSON.parse(migrationTemplateText);
const onboardingTemplateText = await readFile(
  new URL("../infra/onboarding-task.template.json", import.meta.url),
  "utf8",
);
const onboardingTemplate = JSON.parse(onboardingTemplateText);
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const RDS_CA_PATH = "/opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem";

function resourcesOfType(type) {
  return Object.entries(resources).filter(([, resource]) => resource.Type === type);
}

function collectLogicalDependencies(value, dependencies = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectLogicalDependencies(entry, dependencies);
    return dependencies;
  }

  if (!value || typeof value !== "object") return dependencies;

  if (typeof value.Ref === "string" && resources[value.Ref]) {
    dependencies.add(value.Ref);
  }

  if (Array.isArray(value["Fn::GetAtt"]) && resources[value["Fn::GetAtt"][0]]) {
    dependencies.add(value["Fn::GetAtt"][0]);
  }

  if (typeof value["Fn::Sub"] === "string") {
    for (const match of value["Fn::Sub"].matchAll(/\$\{([A-Za-z0-9:._-]+)\}/g)) {
      const logicalId = match[1].split(".")[0];
      if (resources[logicalId]) dependencies.add(logicalId);
    }
  }

  for (const nested of Object.values(value)) collectLogicalDependencies(nested, dependencies);
  return dependencies;
}

function assertNoDependencyCycles() {
  const graph = new Map(
    Object.entries(resources).map(([logicalId, resource]) => {
      const dependencies = collectLogicalDependencies(resource.Properties);
      const explicit = Array.isArray(resource.DependsOn)
        ? resource.DependsOn
        : resource.DependsOn
          ? [resource.DependsOn]
          : [];
      for (const dependency of explicit) dependencies.add(dependency);
      dependencies.delete(logicalId);
      return [logicalId, dependencies];
    }),
  );

  const complete = new Set();
  const active = [];

  function visit(logicalId) {
    if (complete.has(logicalId)) return;
    const activeIndex = active.indexOf(logicalId);
    assert.equal(
      activeIndex,
      -1,
      `CloudFormation dependency cycle: ${[...active.slice(activeIndex), logicalId].join(" -> ")}`,
    );
    active.push(logicalId);
    for (const dependency of graph.get(logicalId) ?? []) visit(dependency);
    active.pop();
    complete.add(logicalId);
  }

  for (const logicalId of graph.keys()) visit(logicalId);
}

test("CloudFormation template is valid JSON and pinned to Osaka", () => {
  assert.equal(template.AWSTemplateFormatVersion, "2010-09-09");
  assert.equal(template.Parameters.DeploymentRegion.Default, "ap-northeast-3");
  assert.deepEqual(template.Parameters.DeploymentRegion.AllowedValues, ["ap-northeast-3"]);
  assert.ok(template.Rules.OsakaRegionOnly);
  assert.match(template.Description, /ap-northeast-3/);
  assert.ok(Object.keys(resources).length >= 80, "the platform stack must not silently lose resources");
  assert.ok(Buffer.byteLength(templateText, "utf8") <= 51_200, "template must fit direct CloudFormation validation");
});

test("network uses two AZs and keeps application and database workloads private", () => {
  const subnets = resourcesOfType("AWS::EC2::Subnet");
  assert.equal(subnets.length, 6);
  assert.equal(resources.ApplicationSubnetA.Properties.MapPublicIpOnLaunch, false);
  assert.equal(resources.ApplicationSubnetB.Properties.MapPublicIpOnLaunch, false);
  assert.equal(resources.DatabaseSubnetA.Properties.MapPublicIpOnLaunch, false);
  assert.equal(resources.DatabaseSubnetB.Properties.MapPublicIpOnLaunch, false);
  assert.deepEqual(resources.EcsService.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp, "DISABLED");
  assert.equal(resources.Database.Properties.PubliclyAccessible, false);
  assert.deepEqual(resources.DatabaseSubnetGroup.Properties.SubnetIds, [
    { Ref: "DatabaseSubnetA" },
    { Ref: "DatabaseSubnetB" },
  ]);
  assert.ok(resources.NatGatewayA && resources.NatGatewayB, "one NAT gateway per AZ is required");
  assert.ok(resources.S3VpcEndpoint);
});

test("security groups expose only ALB HTTP/HTTPS and use SG-to-SG application paths", () => {
  const ingress = resourcesOfType("AWS::EC2::SecurityGroupIngress").map(([, rule]) => rule.Properties);
  const publicIngress = ingress.filter((rule) => rule.CidrIp === "0.0.0.0/0");
  assert.deepEqual(publicIngress.map((rule) => rule.ToPort).sort((left, right) => left - right), [80, 443]);
  assert.deepEqual(resources.ApplicationFromLoadBalancerIngress.Properties.SourceSecurityGroupId, {
    Ref: "LoadBalancerSecurityGroup",
  });
  assert.deepEqual(resources.DatabaseFromApplicationIngress.Properties.SourceSecurityGroupId, {
    Ref: "ApplicationSecurityGroup",
  });
  assert.equal(resources.DatabaseFromApplicationIngress.Properties.ToPort, 5432);
  assert.equal(resources.ApplicationToDatabaseEgress.Properties.ToPort, 5432);
});

test("ALB terminates modern TLS, redirects HTTP and is protected by WAF", () => {
  assert.equal(resources.LoadBalancer.Properties.Scheme, "internet-facing");
  assert.equal(resources.HttpsListener.Properties.Protocol, "HTTPS");
  assert.equal(resources.HttpsListener.Properties.SslPolicy, "ELBSecurityPolicy-TLS13-1-2-2021-06");
  assert.deepEqual(resources.HttpsListener.Properties.Certificates, [{ CertificateArn: { Ref: "Certificate" } }]);
  assert.equal(resources.HttpListener.Properties.DefaultActions[0].RedirectConfig.StatusCode, "HTTP_301");
  assert.equal(resources.WebAcl.Properties.Scope, "REGIONAL");
  assert.ok(resources.WebAcl.Properties.Rules.some((rule) => rule.Statement?.RateBasedStatement));
  assert.deepEqual(resources.WebAclAssociation.Properties.ResourceArn, { Ref: "LoadBalancer" });
  assert.equal(resources.WafLogging.Properties.LoggingFilter.DefaultBehavior, "DROP");
});

test("ECS service runs at least two Fargate tasks across private subnets", () => {
  assert.ok(resources.EcsCluster);
  assert.deepEqual(resources.TaskDefinition.Properties.RequiresCompatibilities, ["FARGATE"]);
  assert.equal(template.Parameters.DesiredTaskCount.MinValue, 2);
  assert.deepEqual(resources.EcsService.Properties.NetworkConfiguration.AwsvpcConfiguration.Subnets, [
    { Ref: "ApplicationSubnetA" },
    { Ref: "ApplicationSubnetB" },
  ]);
  assert.equal(resources.EcsService.Properties.DeploymentConfiguration.DeploymentCircuitBreaker.Rollback, true);
  const container = resources.TaskDefinition.Properties.ContainerDefinitions[0];
  assert.equal(container.ReadonlyRootFilesystem, true);
  assert.equal(container.LinuxParameters.Tmpfs, undefined, "Fargate does not support task-definition tmpfs");
  assert.deepEqual(container.MountPoints, [{ SourceVolume: "scratch", ContainerPath: "/tmp", ReadOnly: false }]);
  assert.deepEqual(resources.TaskDefinition.Properties.Volumes, [{ Name: "scratch" }]);
  const environment = Object.fromEntries(container.Environment.map((entry) => [entry.Name, entry.Value]));
  assert.equal(environment.PDF_RENDER_CONCURRENCY, "1");
  assert.equal(environment.PDF_RENDER_QUEUE_LIMIT, "1");
  assert.equal(resources.EcsCluster.Properties.ClusterSettings[0].Value, "enabled");
  assert.ok(resources.EcsCpuScalingPolicy && resources.EcsMemoryScalingPolicy);
  assert.equal(template.Parameters.DatabaseBootstrapMode.Default, "disabled");
  assert.deepEqual(template.Parameters.DatabaseBootstrapMode.AllowedValues, ["disabled", "enabled"]);
  assert.deepEqual(resources.EcsService.Properties.DesiredCount, {
    "Fn::If": ["IsDatabaseBootstrap", 0, { Ref: "DesiredTaskCount" }],
  });
  assert.deepEqual(resources.EcsScalableTarget.Properties.MinCapacity, {
    "Fn::If": ["IsDatabaseBootstrap", 0, { Ref: "DesiredTaskCount" }],
  });
});

test("RDS PostgreSQL meets encryption, Multi-AZ, PITR and recovery contracts", () => {
  const database = resources.Database;
  assert.equal(database.Properties.Engine, "postgres");
  assert.equal(database.Properties.MultiAZ, true);
  assert.equal(database.Properties.StorageEncrypted, true);
  assert.equal(database.Properties.PubliclyAccessible, false);
  assert.deepEqual(database.Properties.KmsKeyId, { "Fn::GetAtt": ["DataKey", "Arn"] });
  assert.equal(database.Properties.ManageMasterUserPassword, true);
  assert.equal(database.Properties.CACertificateIdentifier, "rds-ca-rsa2048-g1");
  assert.equal(template.Parameters.DatabaseBackupRetentionDays.Default, 35);
  assert.equal(template.Parameters.DatabaseBackupRetentionDays.MinValue, 7);
  assert.equal(database.DeletionPolicy, "Snapshot");
  assert.equal(database.UpdateReplacePolicy, "Snapshot");
  assert.equal(resources.DatabaseParameterGroup.Properties.Parameters["rds.force_ssl"], "1");
  assert.ok(resources.BackupPlan.Properties.BackupPlan.BackupPlanRule.some((rule) => rule.EnableContinuousBackup));
});

test("document storage blocks public access, requires SSE-KMS and retains versions", () => {
  const bucket = resources.DocumentBucket;
  assert.equal(bucket.Properties.VersioningConfiguration.Status, "Enabled");
  assert.equal(bucket.Properties.ObjectLockEnabled, true);
  assert.deepEqual(bucket.Properties.ObjectLockConfiguration, {
    ObjectLockEnabled: "Enabled",
    Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 2555 } },
  });
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
  assert.equal(
    bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm,
    "aws:kms",
  );
  assert.ok(bucket.Properties.LifecycleConfiguration.Rules.length >= 2);
  assert.equal(bucket.DeletionPolicy, "Retain");
  const statements = resources.DocumentBucketPolicy.Properties.PolicyDocument.Statement;
  assert.ok(statements.some((statement) => statement.Sid === "DenyInsecureTransport"));
  assert.ok(statements.some((statement) => statement.Sid === "DenyWrongKmsKey"));
  assert.equal(resources.DataKey.Properties.EnableKeyRotation, true);
  const storageActions = resources.TaskRole.Properties.Policies.flatMap(
    (policy) => policy.PolicyDocument.Statement,
  ).flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
  assert.ok(storageActions.includes("s3:GetObjectVersion"));
  assert.ok(!storageActions.includes("s3:DeleteObject"));
});

test("Cognito requires MFA and supports authorization-code login", () => {
  const userPool = resources.UserPool.Properties;
  assert.equal(userPool.MfaConfiguration, "ON");
  assert.ok(userPool.EnabledMfas.includes("SOFTWARE_TOKEN_MFA"));
  assert.equal(userPool.AdminCreateUserConfig.AllowAdminCreateUserOnly, true);
  assert.equal(userPool.DeletionProtection, "ACTIVE");
  assert.equal(userPool.Policies.PasswordPolicy.MinimumLength, 14);
  assert.equal(userPool.UserPoolTier, "PLUS");
  assert.deepEqual(resources.UserPoolClient.Properties.AllowedOAuthFlows, ["code"]);
  assert.equal(resources.UserPoolClient.Properties.GenerateSecret, false);
  assert.equal(resources.UserPoolClient.Properties.EnableTokenRevocation, true);
});

test("secrets, logs, alarms and backup failures are operated without plaintext parameters", () => {
  assert.equal(resourcesOfType("AWS::SecretsManager::Secret").length, 5);
  assert.ok(resources.DatabaseRuntimeSecret.Properties.GenerateSecretString);
  assert.ok(resources.DatabaseProvisionerSecret.Properties.GenerateSecretString);
  assert.ok(resources.SessionSecret.Properties.GenerateSecretString);
  assert.ok(resources.AuditHashSecret.Properties.GenerateSecretString);
  assert.ok(resources.PdfFinalizationSecret.Properties.GenerateSecretString);
  assert.ok(resourcesOfType("AWS::Logs::LogGroup").length >= 3);
  assert.ok(resourcesOfType("AWS::CloudWatch::Alarm").length >= 7);
  assert.ok(resources.BackupFailureEventRule);
  assert.ok(resources.AlarmTopicPolicy);
  assert.deepEqual(resources.AlarmTopic.Properties.KmsMasterKeyId, { "Fn::GetAtt": ["AlarmKey", "Arn"] });
  const alarmKeyStatements = resources.AlarmKey.Properties.KeyPolicy.Statement;
  const cloudWatchKms = alarmKeyStatements.find((statement) => statement.Sid === "CloudWatchAlarmEncryption");
  const eventBridgeKms = alarmKeyStatements.find((statement) => statement.Sid === "EventBridgeAlarmEncryption");
  assert.deepEqual(cloudWatchKms.Action.sort(), ["kms:Decrypt", "kms:GenerateDataKey*"].sort());
  assert.deepEqual(cloudWatchKms.Condition.StringEquals, { "aws:SourceAccount": { Ref: "AWS::AccountId" } });
  assert.deepEqual(eventBridgeKms.Action.sort(), ["kms:Decrypt", "kms:GenerateDataKey*"].sort());
  assert.equal(eventBridgeKms.Condition, undefined);
  assert.equal(Object.hasOwn(template.Parameters.AlarmEmail, "Default"), false);
  assert.equal(resources.AlarmEmailSubscription.Condition, undefined);
  const alarmTopicStatements = resources.AlarmTopicPolicy.Properties.PolicyDocument.Statement;
  const eventBridgePublish = alarmTopicStatements.find((statement) => statement.Sid === "EventBridgePublish");
  const cloudWatchPublish = alarmTopicStatements.find((statement) => statement.Sid === "CloudWatchAlarmPublish");
  assert.equal(eventBridgePublish.Principal.Service, "events.amazonaws.com");
  assert.equal(eventBridgePublish.Condition, undefined);
  assert.equal(cloudWatchPublish.Principal.Service, "cloudwatch.amazonaws.com");
  assert.deepEqual(cloudWatchPublish.Condition.StringEquals, { "aws:SourceAccount": { Ref: "AWS::AccountId" } });
  assert.match(cloudWatchPublish.Condition.ArnLike["aws:SourceArn"]["Fn::Sub"], /:cloudwatch:.*:alarm:\*/);
  assert.equal(resources.VpcFlowLog.Properties.TrafficType, "REJECT");
});

test("runtime IAM roles remain least privilege", () => {
  const taskStatements = resources.TaskRole.Properties.Policies.flatMap(
    (policy) => policy.PolicyDocument.Statement,
  );
  const taskActions = taskStatements.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action],
  );
  assert.ok(!taskActions.includes("*"));
  assert.ok(!taskActions.includes("s3:DeleteObject"));
  assert.ok(!taskActions.some((action) => action.startsWith("secretsmanager:")));
  const cognitoAdmin = taskStatements.find((statement) =>
    Array.isArray(statement.Action) && statement.Action.includes("cognito-idp:AdminCreateUser"),
  );
  assert.deepEqual(cognitoAdmin.Action.sort(), [
    "cognito-idp:AdminCreateUser",
    "cognito-idp:AdminDisableUser",
    "cognito-idp:AdminEnableUser",
    "cognito-idp:AdminGetUser",
  ].sort());
  assert.deepEqual(cognitoAdmin.Resource, { "Fn::GetAtt": ["UserPool", "Arn"] });

  const executionStatements = resources.TaskExecutionRole.Properties.Policies.flatMap(
    (policy) => policy.PolicyDocument.Statement,
  );
  const secretRead = executionStatements.find((statement) => statement.Action === "secretsmanager:GetSecretValue");
  assert.deepEqual(secretRead.Resource, [
    { Ref: "DatabaseRuntimeSecret" },
    { Ref: "SessionSecret" },
    { Ref: "AuditHashSecret" },
    { Ref: "PdfFinalizationSecret" },
  ]);
  assert.equal(
    JSON.stringify(resources.TaskDefinition).includes("MasterUserSecret"),
    false,
    "the normal web task must never receive the RDS master secret",
  );
});

test("one-off migration task alone can read master, runtime and provisioner database secrets", () => {
  const migrationResources = migrationTemplate.Resources;
  const definition = migrationResources.MigrationTaskDefinition.Properties;
  const container = definition.ContainerDefinitions[0];
  assert.deepEqual(container.Command, ["node", "scripts/migrate.mjs"]);
  assert.equal(container.ReadonlyRootFilesystem, true);
  assert.deepEqual(definition.RequiresCompatibilities, ["FARGATE"]);

  const secretByName = Object.fromEntries(container.Secrets.map((entry) => [entry.Name, entry.ValueFrom]));
  assert.deepEqual(new Set(Object.keys(secretByName)), new Set([
    "MIGRATION_DATABASE_USER",
    "MIGRATION_DATABASE_PASSWORD",
    "RUNTIME_DATABASE_USER",
    "RUNTIME_DATABASE_PASSWORD",
    "PDF_FINALIZATION_SECRET",
    "PROVISION_DATABASE_USER",
    "PROVISION_DATABASE_PASSWORD",
  ]));
  assert.deepEqual(secretByName.MIGRATION_DATABASE_USER, {
    "Fn::Join": ["", [{ Ref: "DatabaseMasterSecretArn" }, ":username::"]],
  });
  assert.deepEqual(secretByName.RUNTIME_DATABASE_PASSWORD, {
    "Fn::Join": ["", [{ Ref: "DatabaseRuntimeSecretArn" }, ":password::"]],
  });
  assert.deepEqual(secretByName.PDF_FINALIZATION_SECRET, {
    "Fn::Join": ["", [{ Ref: "PdfFinalizationSecretArn" }, ":key::"]],
  });

  const executionStatements = migrationResources.MigrationTaskExecutionRole.Properties.Policies
    .flatMap((policy) => policy.PolicyDocument.Statement);
  const secretRead = executionStatements.find((statement) =>
    statement.Action === "secretsmanager:GetSecretValue");
  assert.deepEqual(secretRead.Resource, [
    { Ref: "DatabaseMasterSecretArn" },
    { Ref: "DatabaseRuntimeSecretArn" },
    { Ref: "DatabaseProvisionerSecretArn" },
    { Ref: "PdfFinalizationSecretArn" },
  ]);
  assert.equal(JSON.stringify(executionStatements).includes('"Resource":"*"'), false);
  assert.equal(migrationResources.MigrationTaskRole.Properties.Policies, undefined);
  const environment = Object.fromEntries(container.Environment.map((entry) => [entry.Name, entry.Value]));
  assert.equal(environment.MIGRATION_DATABASE_SSL, "require");
  assert.equal(environment.MIGRATION_DATABASE_CA_FILE, RDS_CA_PATH);
  assert.equal(
    Object.keys(migrationTemplate.Parameters).some((name) => /password/i.test(name)),
    false,
    "plaintext credentials must never be CloudFormation parameters",
  );
  assert.deepEqual(template.Outputs.ApplicationSubnetIds.Value, {
    "Fn::Join": [",", [{ Ref: "ApplicationSubnetA" }, { Ref: "ApplicationSubnetB" }]],
  });
  assert.deepEqual(template.Outputs.ApplicationSecurityGroupId.Value, { Ref: "ApplicationSecurityGroup" });
  assert.deepEqual(template.Outputs.ApplicationLogGroupName.Value, { Ref: "ApplicationLogGroup" });
  assert.deepEqual(template.Outputs.DataKeyArn.Value, { "Fn::GetAtt": ["DataKey", "Arn"] });
  assert.deepEqual(template.Outputs.DatabaseProvisionerSecretArn.Value, { Ref: "DatabaseProvisionerSecret" });
  assert.deepEqual(template.Outputs.PdfFinalizationSecretArn.Value, { Ref: "PdfFinalizationSecret" });
  assert.deepEqual(resources.DatabaseFromApplicationIngress.Properties.SourceSecurityGroupId, {
    Ref: "ApplicationSecurityGroup",
  });
});

test("one-off onboarding task separates DB, Cognito, network and PII-bearing request secrets", () => {
  const onboardingResources = onboardingTemplate.Resources;
  const definition = onboardingResources.OnboardingTaskDefinition.Properties;
  const container = definition.ContainerDefinitions[0];
  assert.deepEqual(container.Command, ["node", "scripts/provision-tenant.mjs"]);
  assert.equal(container.ReadonlyRootFilesystem, true);
  assert.deepEqual(definition.RequiresCompatibilities, ["FARGATE"]);

  const secrets = Object.fromEntries(container.Secrets.map((entry) => [entry.Name, entry.ValueFrom]));
  assert.deepEqual(new Set(Object.keys(secrets)), new Set([
    "PROVISION_DATABASE_USER",
    "PROVISION_DATABASE_PASSWORD",
    "ONBOARDING_OPERATION_ID",
    "ONBOARDING_ORGANIZATION_ID",
    "ONBOARDING_ORGANIZATION_NAME",
    "ONBOARDING_ADMIN_USER_ID",
    "ONBOARDING_ADMIN_EMAIL",
    "ONBOARDING_ADMIN_DISPLAY_NAME",
    "ONBOARDING_ADMIN_MEMBERSHIP_ID",
    "ONBOARDING_FACILITY_ID",
    "ONBOARDING_FACILITY_CODE",
    "ONBOARDING_FACILITY_NAME",
    "ONBOARDING_RESEND_INVITATION",
    "ONBOARDING_RESEND_EVENT_ID",
  ]));
  assert.deepEqual(secrets.PROVISION_DATABASE_USER, {
    "Fn::Join": ["", [{ Ref: "DatabaseProvisionerSecretArn" }, ":username::"]],
  });
  assert.deepEqual(secrets.ONBOARDING_ADMIN_EMAIL, {
    "Fn::Join": ["", [{ Ref: "OnboardingRequestSecretArn" }, ":administratorEmail::"]],
  });
  assert.equal(
    Object.keys(onboardingTemplate.Parameters).some((name) =>
      /organizationName|administratorEmail|administratorDisplayName|facilityName/i.test(name)),
    false,
    "PII and organization display values must not be CloudFormation parameters",
  );

  const taskStatements = onboardingResources.OnboardingTaskRole.Properties.Policies
    .flatMap((policy) => policy.PolicyDocument.Statement);
  assert.deepEqual(taskStatements, [{
    Effect: "Allow",
    Action: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"],
    Resource: { Ref: "CognitoUserPoolArn" },
  }]);
  const executionStatements = onboardingResources.OnboardingTaskExecutionRole.Properties.Policies
    .flatMap((policy) => policy.PolicyDocument.Statement);
  const secretRead = executionStatements.find((statement) =>
    statement.Action === "secretsmanager:GetSecretValue");
  assert.deepEqual(secretRead.Resource, [
    { Ref: "DatabaseProvisionerSecretArn" },
    { Ref: "OnboardingRequestSecretArn" },
  ]);
  assert.equal(JSON.stringify(onboardingResources).includes("DatabaseMasterSecretArn"), false);
  assert.equal(JSON.stringify(onboardingResources).includes("DatabaseRuntimeSecretArn"), false);

  const environment = Object.fromEntries(container.Environment.map((entry) => [entry.Name, entry.Value]));
  assert.equal(environment.PROVISION_DATABASE_SSL, "require");
  assert.equal(environment.PROVISION_DATABASE_CA_FILE, RDS_CA_PATH);
  const dbEgress = onboardingResources.OnboardingSecurityGroup.Properties.SecurityGroupEgress
    .find((rule) => rule.DestinationSecurityGroupId);
  assert.deepEqual(dbEgress.DestinationSecurityGroupId, { Ref: "DatabaseSecurityGroupId" });
  assert.deepEqual(
    onboardingResources.DatabaseFromOnboardingIngress.Properties.SourceSecurityGroupId,
    { Ref: "OnboardingSecurityGroup" },
  );
});

test("task environment matches the production server configuration contract", () => {
  const container = resources.TaskDefinition.Properties.ContainerDefinitions[0];
  const environmentNames = new Set(container.Environment.map((entry) => entry.Name));
  const secretNames = new Set(container.Secrets.map((entry) => entry.Name));
  for (const name of [
    "APP_BASE_URL",
    "DATABASE_HOST",
    "DATABASE_PORT",
    "DATABASE_NAME",
    "DATABASE_SSL",
    "DATABASE_CA_FILE",
    "AUTH_MODE",
    "COGNITO_USER_POOL_ID",
    "COGNITO_CLIENT_ID",
    "COGNITO_DOMAIN",
  ]) {
    assert.ok(environmentNames.has(name), `${name} must be injected into the task`);
  }
  for (const name of ["DATABASE_USER", "DATABASE_PASSWORD", "COOKIE_SECRET", "AUDIT_HASH_KEY", "PDF_FINALIZATION_SECRET"]) {
    assert.ok(secretNames.has(name), `${name} must come from Secrets Manager`);
  }
  assert.ok(!environmentNames.has("DATABASE_PASSWORD"));
  const environment = Object.fromEntries(container.Environment.map((entry) => [entry.Name, entry.Value]));
  assert.equal(environment.DATABASE_SSL, "require");
  assert.equal(environment.DATABASE_CA_FILE, RDS_CA_PATH);
});

test("production image pins and verifies the official Osaka RDS CA bundle", () => {
  assert.match(
    dockerfile,
    /https:\/\/truststore\.pki\.rds\.amazonaws\.com\/ap-northeast-3\/ap-northeast-3-bundle\.pem/,
  );
  assert.match(dockerfile, /a0eb6e614aec8920204c2a1d6b4fca8128780fc3535e23cd9a56ecf60c0ad1bd/);
  assert.match(dockerfile, /sha256sum --check --strict/);
  assert.match(dockerfile, new RegExp(`DATABASE_CA_FILE=${RDS_CA_PATH.replaceAll("/", "\\/")}`));
  assert.match(dockerfile, new RegExp(`MIGRATION_DATABASE_CA_FILE=${RDS_CA_PATH.replaceAll("/", "\\/")}`));
  assert.match(dockerfile, new RegExp(`PROVISION_DATABASE_CA_FILE=${RDS_CA_PATH.replaceAll("/", "\\/")}`));
  assert.match(dockerfile, /COPY scripts\/provision-tenant\.mjs \.\/scripts\/provision-tenant\.mjs/);
});

test("CloudFormation logical dependency graph has no circular references", () => {
  assertNoDependencyCycles();
});
