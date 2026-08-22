# AWS production infrastructure

This directory defines the production AWS platform for みちのーと. `main.template.json` is the retained platform stack;
`migration-task.template.json` is a deliberately ephemeral stack used only for a controlled database migration run;
`onboarding-task.template.json` is a second ephemeral stack for the first tenant only. None is deployed by this
repository or by the test suite.

## Scope

`main.template.json` creates the following resources in `ap-northeast-3` (Asia Pacific, Osaka):

- one VPC spanning two Availability Zones;
- two public ALB subnets, two private ECS application subnets and two isolated RDS subnets;
- one NAT gateway in each Availability Zone and an S3 gateway endpoint;
- an internet-facing ALB with HTTP-to-HTTPS redirect, an ACM certificate and Route 53 alias;
- a regional WAF web ACL with AWS managed rules, per-IP rate limiting and block-only logs;
- an ECS Fargate service with at least two tasks, deployment rollback and CPU/memory auto scaling;
- RDS for PostgreSQL 16 with Multi-AZ, encryption, managed master credentials, 35-day automated backups and PITR;
- a private, versioned S3 document bucket with SSE-KMS, public-access blocks and lifecycle retention;
- a Cognito Plus User Pool with administrator-created users, mandatory TOTP MFA, threat protection and OAuth Authorization Code flow;
- customer-managed KMS encryption, independent Secrets Manager DB/session/audit secrets and least-privilege task roles;
- encrypted CloudWatch application/WAF/VPC-flow logs, operational alarms and an SNS alarm topic;
- AWS Backup continuous/daily and monthly protection for RDS, with backup-failure notifications.

The recovery targets are **RPO 15 minutes** and **RTO 4 hours**. The template supplies the controls needed to pursue these targets; the targets are not considered proven until a timed restore exercise has succeeded and evidence has been recorded as described in [`docs/operations-runbook.md`](../docs/operations-runbook.md).

The application root filesystem is read-only. A Fargate-compatible empty bind volume is mounted at `/tmp` for Chromium profiles and temporary PDF work. ECS `linuxParameters.tmpfs` is deliberately not used because [Fargate does not support that task-definition parameter](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html); an [empty bind mount](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specify-bind-mount-config.html) uses the task's ephemeral storage instead.

RDS is pinned to `rds-ca-rsa2048-g1`. The production image downloads the official Osaka regional bundle from `truststore.pki.rds.amazonaws.com` during build, verifies its repository-pinned SHA-256, and stores it read-only at `/opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem`. Both web and migration tasks set their CA-file variable to that path and use `rejectUnauthorized=true`; `require` never means encryption without identity verification.

## Prerequisites

Before creating a change set:

1. Use a dedicated staging or production AWS account with AWS CloudTrail and account-level security monitoring enabled.
2. Confirm that the account has at least two usable Availability Zones and sufficient service quotas in `ap-northeast-3`.
3. Own a Route 53 public hosted zone for `DomainName`.
4. Publish a reviewed multi-architecture image to a private ECR repository. Supply an immutable `@sha256:` image digest for production.
5. During the image build, verify the pinned Osaka RDS bundle checksum. If AWS publishes a replacement bundle, review the CA change, update the checksum deliberately, rebuild, and validate staging before changing the RDS CA.
6. Register an operational SNS destination and a 24-hour incident escalation roster.
7. Confirm the selected `DatabaseEngineVersion` and `rds-ca-rsa2048-g1` are currently offered by RDS in Osaka.
8. Obtain change approval for recurring costs. Multi-AZ RDS, two NAT gateways, WAF managed rules, Cognito advanced security and retained backups are deliberate production controls.

Do not put passwords, token values, database credentials or personal information in CloudFormation parameters. The stack generates credentials in Secrets Manager. Its task role can create, inspect, enable and disable users only in the User Pool created by this stack; it has no wildcard Cognito administrator permission.

## Parameters

Copy `parameters.example.json` outside source control and replace only the non-secret placeholders. Important parameters are:

| Parameter | Purpose |
| --- | --- |
| `ContainerImage` | Immutable ECR image URI; a digest is required by the release checklist |
| `DomainName` / `HostedZoneId` | HTTPS application hostname and its Route 53 public zone |
| `CognitoDomainPrefix` | Globally unique Cognito managed-login prefix |
| `CognitoCallbackUrl` / `CognitoLogoutUrl` | Exact BFF callback/logout URLs under `DomainName` |
| `DatabaseEngineVersion` | PostgreSQL 16 minor version available in Osaka |
| `DesiredTaskCount` / `MaximumTaskCount` | Minimum high-availability capacity and auto-scaling ceiling |
| `AlarmEmail` | Required SNS email; the recipient must confirm the subscription before launch |

VPC CIDRs are parameters so they can be checked against connected networks before deployment. They must not overlap a corporate VPN, another peered VPC or a future disaster-recovery network.

## Validation

Local contract validation does not call AWS:

```powershell
npm test
```

The contract also keeps the source template within CloudFormation's 51,200-byte direct-upload limit. It is intentionally close to that limit; if the stack grows, split it by lifecycle (network/data/application) or upload the reviewed template to a versioned infrastructure bucket and use `--template-url`.

With an authenticated AWS CLI session, validate against the CloudFormation service before raising a change request:

```powershell
aws cloudformation validate-template `
  --region ap-northeast-3 `
  --template-body file://infra/main.template.json

aws cloudformation validate-template `
  --region ap-northeast-3 `
  --template-body file://infra/migration-task.template.json

aws cloudformation validate-template `
  --region ap-northeast-3 `
  --template-body file://infra/onboarding-task.template.json
```

After validation, create a change set and inspect every replacement, IAM policy and retention change. Do not execute a change set from an unreviewed workstation session.

```powershell
aws cloudformation create-change-set `
  --region ap-northeast-3 `
  --stack-name michinote-production `
  --change-set-name release-YYYYMMDD-HHMM `
  --change-set-type CREATE `
  --template-body file://infra/main.template.json `
  --parameters file://C:/secure/michinote-production-parameters.json `
  --capabilities CAPABILITY_IAM
```

For updates, use `--change-set-type UPDATE`. The example shows the workflow only; no command in this repository creates or updates AWS resources automatically.

## Database bootstrap boundary

The web task receives only the generated `michinote_runtime` credential. It never receives the RDS master secret.
The runtime role is intentionally `NOLOGIN` until the migration succeeds, so first deployment uses this order:

1. Create the main stack with `DatabaseBootstrapMode=enabled`. This keeps the ECS service desired and autoscaling minimum counts at zero while RDS, Secrets Manager, networking and the cluster become available.
2. Read the main stack outputs for its RDS endpoint/name, managed master-secret ARN, `DatabaseRuntimeSecret` ARN, `DatabaseProvisionerSecret` ARN, `PdfFinalizationSecret` ARN, data KMS key ARN, application log-group name, application subnet IDs and application security-group ID. Put identifiers—not secret values—in a reviewed migration-stack parameter file outside Git.
3. Create `migration-task.template.json` as a short-lived stack. Its execution role can read exactly the master, runtime, provisioner and independent PDF-finalization secrets and decrypt them with the data key. Its task role has no application permissions.
4. Run its task definition once in the main cluster, private application subnets and application security group with `assignPublicIp=DISABLED`. Do not pass credentials through `--overrides`, shell arguments, CloudFormation parameters or CLI history.
5. Wait for `STOPPED`, require container exit code `0`, and save the migration event names/outcomes as release evidence. `npm run migrate` applies checksum-verified schema/grants, derives SCRAM verifiers in memory, and configures only `michinote_runtime` and `michinote_provisioner` as least-privilege `LOGIN` roles.
6. Delete the migration stack immediately after the task stops successfully. This removes the task definition and execution role that could read the master secret. The retained database and secrets are not members of that stack.
7. Update the main stack to `DatabaseBootstrapMode=disabled`. Confirm at least two healthy web tasks and verify `/health/ready` plus an authenticated read/write smoke test.

The following PowerShell example makes the one-off boundary explicit. It reads only CloudFormation identifiers, never secret values. Use the same reviewed image digest as the web release and run it from an approved release workstation:

```powershell
$region = "ap-northeast-3"
$mainStackName = "michinote-production"
$migrationStackName = "michinote-production-migration-YYYYMMDDHHMM"
$imageDigest = "123456789012.dkr.ecr.ap-northeast-3.amazonaws.com/michinote@sha256:REVIEWED_DIGEST"

$mainStack = aws cloudformation describe-stacks `
  --region $region `
  --stack-name $mainStackName | ConvertFrom-Json
$main = @{}
$mainStack.Stacks[0].Outputs | ForEach-Object { $main[$_.OutputKey] = $_.OutputValue }

aws cloudformation deploy `
  --region $region `
  --stack-name $migrationStackName `
  --template-file infra/migration-task.template.json `
  --capabilities CAPABILITY_IAM `
  --parameter-overrides `
    ContainerImage=$imageDigest `
    DatabaseHost=$($main.DatabaseEndpoint) `
    DatabaseName=$($main.DatabaseName) `
    DatabaseMasterSecretArn=$($main.DatabaseAdminSecretArn) `
    DatabaseRuntimeSecretArn=$($main.DatabaseRuntimeSecretArn) `
    DatabaseProvisionerSecretArn=$($main.DatabaseProvisionerSecretArn) `
    PdfFinalizationSecretArn=$($main.PdfFinalizationSecretArn) `
    DataKeyArn=$($main.DataKeyArn) `
    ApplicationLogGroupName=$($main.ApplicationLogGroupName)

$migrationStack = aws cloudformation describe-stacks `
  --region $region `
  --stack-name $migrationStackName | ConvertFrom-Json
$migration = @{}
$migrationStack.Stacks[0].Outputs | ForEach-Object { $migration[$_.OutputKey] = $_.OutputValue }
$network = @{
  awsvpcConfiguration = @{
    subnets = @($main.ApplicationSubnetIds -split ",")
    securityGroups = @($main.ApplicationSecurityGroupId)
    assignPublicIp = "DISABLED"
  }
} | ConvertTo-Json -Compress -Depth 4

$run = aws ecs run-task `
  --region $region `
  --cluster $main.EcsClusterName `
  --task-definition $migration.MigrationTaskDefinitionArn `
  --launch-type FARGATE `
  --network-configuration $network | ConvertFrom-Json
if ($run.failures.Count -ne 0 -or $run.tasks.Count -ne 1) {
  throw "Migration task was not started"
}
$taskArn = $run.tasks[0].taskArn
aws ecs wait tasks-stopped --region $region --cluster $main.EcsClusterName --tasks $taskArn
$stopped = aws ecs describe-tasks `
  --region $region `
  --cluster $main.EcsClusterName `
  --tasks $taskArn | ConvertFrom-Json
if ($stopped.tasks[0].containers[0].exitCode -ne 0) {
  throw "Migration task failed; keep DatabaseBootstrapMode enabled"
}

aws cloudformation delete-stack --region $region --stack-name $migrationStackName
aws cloudformation wait stack-delete-complete --region $region --stack-name $migrationStackName
```

Do not disable bootstrap mode until the successful exit code and the migration log events have both been reviewed. If stack deletion fails, treat the still-existing master-secret execution role as an access-control incident and remove the ephemeral stack before continuing the release.

For later releases the existing web service may remain online while an expand-only migration runs. Recreate the ephemeral migration stack, run and verify one task, delete that stack, then deploy the compatible application image. Password rotation uses the same controlled task: publish the new `DatabaseRuntimeSecret` version, run the migrator to update the PostgreSQL verifier, and rolling-restart web tasks only after success.

If any migration step fails, keep bootstrap mode enabled on first deployment, do not start the web service, delete the ephemeral migration stack after evidence capture, correct the release and rerun. Never work around failure by injecting the master secret into `TaskDefinition`.

Application migrations follow expand/contract rules. Destructive schema changes require a separate release after old application tasks have drained.

## Initial tenant onboarding boundary

After migration, use `onboarding-task.template.json` for the first corporation, facility and tenant administrator.
Its execution role reads only the dedicated provisioner DB secret and a short-lived onboarding-request secret; its
task role has only `AdminCreateUser` and `AdminGetUser` on the one configured User Pool. It creates a separate security
group with PostgreSQL access that is removed with the stack. It never receives the master/runtime DB secrets, S3/KMS
document permissions or normal web-task permissions.

Create the request secret with the reviewed stable UUIDs and initial display/contact values described in
[`docs/operations-runbook.md`](../docs/operations-runbook.md). Pass only its ARN to CloudFormation. Run the task in the
main cluster and private application subnets with the onboarding stack's security group, require exit code zero, then
verify the pre-authentication audit event and immutable DB receipt. On a partial failure, rerun the same operation and
unchanged secret; the Cognito-to-DB saga reconciles an already-created verified user. Delete the request secret and
ephemeral stack after evidence capture. Never put names/email in task overrides or CloudFormation parameters.

## Retention and deletion

The database, Cognito User Pool, KMS key, Secrets Manager secrets, document bucket, backup vault and log groups use `Retain` or snapshot deletion policies. Deleting a CloudFormation stack does not erase regulated records. Disposal is a separate, dual-approved process in the operations runbook.

S3 noncurrent versions move to Glacier after 90 days and expire after seven years. This is an infrastructure default, not a substitute for a customer-specific retention or legal-hold decision.

## Outputs

The main stack returns the public application URL, ECS cluster/service and one-off-task network identifiers, application log group, RDS endpoint/name and admin/runtime/provisioner secret ARNs, data key ARN, document bucket name, Cognito pool ID/ARN and client ID, alarm topic and backup vault. Outputs contain identifiers only, never secret values.

## Deliberate trade-offs

- The first formal deployment uses a single regional stack and Multi-AZ services. Cross-region failover is outside the RTO 4-hour baseline and needs a separately funded design.
- PostgreSQL remains the source of truth for tenant membership and authorization. Cognito authenticates users but does not decide tenant access.
- The User Pool is shared across tenants; every API request still derives tenant membership from the database and enforces PostgreSQL RLS.
- WAF logs retain blocked requests only, and authorization/cookie headers are redacted to reduce unnecessary personal-data collection.
- The application bucket rejects uploads that omit the expected KMS encryption headers. Upload clients must send SSE-KMS settings explicitly.
