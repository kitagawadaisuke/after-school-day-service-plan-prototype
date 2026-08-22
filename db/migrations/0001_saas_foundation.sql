begin;

create schema if not exists app_private;

create or replace function app_private.current_tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create or replace function app_private.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create table public.organizations (
  id uuid primary key,
  name text not null,
  status text not null default 'active' check (status in ('trial', 'active', 'suspended', 'closed')),
  data_retention_months integer not null default 60 check (data_retention_months between 1 and 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0)
);

create table public.facilities (
  id uuid primary key,
  tenant_id uuid not null references public.organizations(id) on delete restrict,
  code text not null,
  name text not null,
  service_type text not null default '放課後等デイサービス',
  status text not null default 'active' check (status in ('active', 'inactive')),
  timezone text not null default 'Asia/Tokyo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

create table public.app_users (
  id uuid primary key,
  cognito_sub text unique,
  email text not null,
  display_name text not null,
  status text not null default 'active' check (status in ('invited', 'active', 'suspended', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0)
);

create unique index app_users_email_lower_idx on public.app_users (lower(email));

create table public.memberships (
  id uuid primary key,
  tenant_id uuid not null references public.organizations(id) on delete restrict,
  user_id uuid not null references public.app_users(id) on delete restrict,
  role text not null check (role in ('tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'viewer', 'auditor')),
  status text not null default 'active' check (status in ('invited', 'active', 'suspended', 'ended')),
  invited_at timestamptz,
  joined_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0),
  unique (tenant_id, id),
  unique (tenant_id, user_id)
);

create index memberships_user_status_idx on public.memberships (user_id, status);
create index memberships_tenant_role_idx on public.memberships (tenant_id, role, status);

create table public.membership_facilities (
  tenant_id uuid not null,
  membership_id uuid not null,
  facility_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, membership_id, facility_id),
  foreign key (tenant_id, membership_id) references public.memberships(tenant_id, id) on delete cascade,
  foreign key (tenant_id, facility_id) references public.facilities(tenant_id, id) on delete cascade
);

create index membership_facilities_facility_idx on public.membership_facilities (tenant_id, facility_id, membership_id);

create or replace function app_private.has_tenant_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.tenant_id = app_private.current_tenant_id()
      and m.user_id = app_private.current_user_id()
      and m.status = 'active'
      and m.role = any(allowed_roles)
  )
$$;

create or replace function app_private.can_access_facility(requested_facility_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.tenant_id = app_private.current_tenant_id()
      and m.user_id = app_private.current_user_id()
      and m.status = 'active'
      and (
        m.role = 'tenant_admin'
        or exists (
          select 1
          from public.membership_facilities mf
          where mf.tenant_id = m.tenant_id
            and mf.membership_id = m.id
            and mf.facility_id = requested_facility_id
        )
      )
  )
$$;

create table public.children (
  id uuid primary key,
  tenant_id uuid not null,
  facility_id uuid not null,
  management_code text not null,
  display_name text not null,
  legal_name text not null,
  birth_date date,
  grade text,
  gender text check (gender is null or gender in ('male', 'female', 'other', 'not_stated')),
  address jsonb not null default '{}'::jsonb,
  primary_phone text,
  emergency_contact jsonb not null default '{}'::jsonb,
  disability_category text,
  medical_summary text,
  recipient_certificate_ciphertext bytea,
  recipient_certificate_last4 text check (recipient_certificate_last4 is null or char_length(recipient_certificate_last4) <= 4),
  certificate_valid_from date,
  certificate_valid_to date,
  status text not null default 'active' check (status in ('active', 'inactive', 'transferred', 'closed')),
  created_by uuid not null references public.app_users(id) on delete restrict,
  updated_by uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.app_users(id) on delete restrict,
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, facility_id) references public.facilities(tenant_id, id) on delete restrict,
  unique (tenant_id, id),
  unique (tenant_id, id, facility_id),
  unique (tenant_id, facility_id, management_code),
  check (certificate_valid_to is null or certificate_valid_from is null or certificate_valid_to >= certificate_valid_from)
);

create index children_tenant_facility_status_idx on public.children (tenant_id, facility_id, status) where deleted_at is null;
create index children_tenant_updated_idx on public.children (tenant_id, updated_at desc, id);

create table public.guardians (
  id uuid primary key,
  tenant_id uuid not null,
  child_id uuid not null,
  legal_name text not null,
  relationship text not null,
  phone text,
  email text,
  address jsonb not null default '{}'::jsonb,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, child_id) references public.children(tenant_id, id) on delete restrict,
  unique (tenant_id, id)
);

create index guardians_child_idx on public.guardians (tenant_id, child_id, is_primary desc);
create unique index guardians_one_primary_idx on public.guardians (tenant_id, child_id) where is_primary;

create table public.family_members (
  id uuid primary key,
  tenant_id uuid not null,
  child_id uuid not null,
  display_label text not null,
  relationship text not null,
  age integer check (age is null or age between 0 and 130),
  occupation_or_role text,
  cohabitation_status text check (cohabitation_status is null or cohabitation_status in ('same_household', 'separate_household', 'unknown')),
  support_summary text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, child_id) references public.children(tenant_id, id) on delete restrict,
  unique (tenant_id, id)
);

create index family_members_child_idx on public.family_members (tenant_id, child_id, sort_order, id);

create table public.institutions (
  id uuid primary key,
  tenant_id uuid not null references public.organizations(id) on delete restrict,
  kind text not null check (kind in ('consultation_support', 'school', 'nursery', 'medical', 'welfare', 'day_service', 'home_care', 'community', 'other')),
  name text not null,
  contact_name text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0),
  unique (tenant_id, id)
);

create index institutions_tenant_kind_idx on public.institutions (tenant_id, kind, name);

create table public.child_institution_relations (
  id uuid primary key,
  tenant_id uuid not null,
  child_id uuid not null,
  institution_id uuid not null,
  relationship_kind text not null,
  service_details text,
  frequency_text text,
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, child_id) references public.children(tenant_id, id) on delete restrict,
  foreign key (tenant_id, institution_id) references public.institutions(tenant_id, id) on delete restrict,
  unique (tenant_id, id),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create index child_institution_relations_child_idx on public.child_institution_relations (tenant_id, child_id, valid_from desc);
create index child_institution_relations_institution_idx on public.child_institution_relations (tenant_id, institution_id);

create table public.schedule_versions (
  id uuid primary key,
  tenant_id uuid not null,
  facility_id uuid not null,
  child_id uuid not null,
  schedule_kind text not null check (schedule_kind in ('current', 'planned')),
  version_number integer not null check (version_number > 0),
  status text not null default 'draft' check (status in ('draft', 'finalized', 'superseded')),
  valid_from date,
  valid_to date,
  summary text,
  created_by uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_at timestamptz,
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, facility_id) references public.facilities(tenant_id, id) on delete restrict,
  foreign key (tenant_id, child_id, facility_id) references public.children(tenant_id, id, facility_id) on delete restrict,
  unique (tenant_id, id),
  unique (tenant_id, child_id, schedule_kind, version_number),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create index schedule_versions_child_kind_idx on public.schedule_versions (tenant_id, child_id, schedule_kind, version_number desc);

create table public.schedule_items (
  id uuid primary key,
  tenant_id uuid not null,
  schedule_version_id uuid not null,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_minute smallint not null check (start_minute between 0 and 1439),
  end_minute smallint not null check (end_minute between 1 and 2880),
  activity text not null,
  location text,
  service_kind text,
  recurrence_note text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, schedule_version_id) references public.schedule_versions(tenant_id, id) on delete restrict,
  unique (tenant_id, id),
  check (end_minute > start_minute)
);

create index schedule_items_version_day_idx on public.schedule_items (tenant_id, schedule_version_id, day_of_week, start_minute);

create table public.case_documents (
  id uuid primary key,
  tenant_id uuid not null,
  facility_id uuid not null,
  child_id uuid not null,
  document_kind text not null check (document_kind in ('basic_assessment', 'consultation_plan', 'individual_support_plan', 'monitoring_record')),
  status text not null default 'draft' check (status in ('draft', 'internal_review', 'explanation_pending', 'consented', 'approved', 'distributed', 'active', 'superseded', 'closed', 'void')),
  version_number integer not null check (version_number > 0),
  previous_version_id uuid,
  template_version text not null,
  period_start date,
  period_end date,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.app_users(id) on delete restrict,
  updated_by uuid not null references public.app_users(id) on delete restrict,
  approved_by uuid references public.app_users(id) on delete restrict,
  approved_at timestamptz,
  consented_at timestamptz,
  distributed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.app_users(id) on delete restrict,
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, facility_id) references public.facilities(tenant_id, id) on delete restrict,
  foreign key (tenant_id, child_id, facility_id) references public.children(tenant_id, id, facility_id) on delete restrict,
  foreign key (tenant_id, previous_version_id) references public.case_documents(tenant_id, id) on delete restrict,
  unique (tenant_id, id),
  unique (tenant_id, child_id, document_kind, version_number),
  check (period_end is null or period_start is null or period_end >= period_start),
  check ((status not in ('approved', 'distributed', 'active', 'superseded', 'closed')) or approved_at is not null)
);

create index case_documents_child_kind_idx on public.case_documents (tenant_id, child_id, document_kind, version_number desc) where deleted_at is null;
create index case_documents_facility_status_idx on public.case_documents (tenant_id, facility_id, status, updated_at desc) where deleted_at is null;

create table public.document_goals (
  id uuid primary key,
  tenant_id uuid not null,
  document_id uuid not null,
  predecessor_goal_id uuid,
  goal_kind text not null check (goal_kind in ('long_term', 'short_term', 'support')),
  title text not null,
  desired_outcome text,
  support_details text,
  evaluation_method text,
  responsible_party text,
  target_date date,
  five_domains text[] not null default '{}',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, document_id) references public.case_documents(tenant_id, id) on delete restrict,
  foreign key (tenant_id, predecessor_goal_id) references public.document_goals(tenant_id, id) on delete restrict,
  unique (tenant_id, id)
);

create index document_goals_document_idx on public.document_goals (tenant_id, document_id, goal_kind, sort_order, id);
create index document_goals_predecessor_idx on public.document_goals (tenant_id, predecessor_goal_id) where predecessor_goal_id is not null;

create table public.daily_logs (
  id uuid primary key,
  tenant_id uuid not null,
  facility_id uuid not null,
  child_id uuid not null,
  occurred_at timestamptz not null,
  activity text not null,
  observation text not null,
  support_provided text not null,
  child_response text not null,
  health_note text,
  five_domains text[] not null default '{}',
  recorded_by uuid not null references public.app_users(id) on delete restrict,
  updated_by uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.app_users(id) on delete restrict,
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, facility_id) references public.facilities(tenant_id, id) on delete restrict,
  foreign key (tenant_id, child_id, facility_id) references public.children(tenant_id, id, facility_id) on delete restrict,
  unique (tenant_id, id)
);

create index daily_logs_child_date_idx on public.daily_logs (tenant_id, child_id, occurred_at desc, id) where deleted_at is null;
create index daily_logs_facility_date_idx on public.daily_logs (tenant_id, facility_id, occurred_at desc) where deleted_at is null;

create table public.daily_log_goals (
  tenant_id uuid not null,
  daily_log_id uuid not null,
  goal_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, daily_log_id, goal_id),
  foreign key (tenant_id, daily_log_id) references public.daily_logs(tenant_id, id) on delete restrict,
  foreign key (tenant_id, goal_id) references public.document_goals(tenant_id, id) on delete restrict
);

create index daily_log_goals_goal_idx on public.daily_log_goals (tenant_id, goal_id, daily_log_id);

create table public.contact_book_entries (
  id uuid primary key,
  tenant_id uuid not null,
  facility_id uuid not null,
  child_id uuid not null,
  entry_date date not null,
  family_message text,
  facility_reply text,
  request_summary text,
  reflected_in_support boolean not null default false,
  recorded_by uuid not null references public.app_users(id) on delete restrict,
  updated_by uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.app_users(id) on delete restrict,
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, facility_id) references public.facilities(tenant_id, id) on delete restrict,
  foreign key (tenant_id, child_id, facility_id) references public.children(tenant_id, id, facility_id) on delete restrict,
  unique (tenant_id, id)
);

create index contact_book_child_date_idx on public.contact_book_entries (tenant_id, child_id, entry_date desc, id) where deleted_at is null;

create table public.monitoring_goal_results (
  id uuid primary key,
  tenant_id uuid not null,
  monitoring_document_id uuid not null,
  goal_id uuid not null,
  progress_status text not null check (progress_status in ('not_evaluated', 'improving', 'maintained', 'mixed', 'needs_review', 'achieved')),
  progress_summary text,
  current_challenge text,
  next_support_policy text,
  next_goal_action text check (next_goal_action is null or next_goal_action in ('continue', 'revise', 'complete')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (tenant_id, monitoring_document_id) references public.case_documents(tenant_id, id) on delete restrict,
  foreign key (tenant_id, goal_id) references public.document_goals(tenant_id, id) on delete restrict,
  unique (tenant_id, id),
  unique (tenant_id, monitoring_document_id, goal_id)
);

create index monitoring_goal_results_document_idx on public.monitoring_goal_results (tenant_id, monitoring_document_id, id);

create table public.document_events (
  id uuid primary key,
  tenant_id uuid not null,
  document_id uuid not null,
  event_type text not null check (event_type in ('submitted', 'returned', 'explained', 'consented', 'approved', 'distributed', 'activated', 'superseded', 'closed', 'voided')),
  actor_user_id uuid not null references public.app_users(id) on delete restrict,
  actor_name_snapshot text not null,
  actor_role_snapshot text not null,
  event_at timestamptz not null default now(),
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  foreign key (tenant_id, document_id) references public.case_documents(tenant_id, id) on delete restrict,
  unique (tenant_id, id)
);

create index document_events_document_idx on public.document_events (tenant_id, document_id, event_at, id);

create table public.document_snapshots (
  id uuid primary key,
  tenant_id uuid not null,
  document_id uuid not null,
  template_version text not null,
  storage_key text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size > 0),
  mime_type text not null default 'application/pdf' check (mime_type = 'application/pdf'),
  snapshot_kind text not null check (snapshot_kind in ('draft', 'official', 'corrected')),
  generated_by uuid not null references public.app_users(id) on delete restrict,
  generated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, storage_key),
  foreign key (tenant_id, document_id) references public.case_documents(tenant_id, id) on delete restrict
);

create index document_snapshots_document_idx on public.document_snapshots (tenant_id, document_id, generated_at desc);

create table public.audit_events (
  id uuid primary key,
  tenant_id uuid not null references public.organizations(id) on delete restrict,
  facility_id uuid,
  actor_user_id uuid references public.app_users(id) on delete restrict,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  occurred_at timestamptz not null default now(),
  request_id text not null,
  ip_hash text,
  user_agent_family text,
  outcome text not null check (outcome in ('success', 'denied', 'failed')),
  changed_fields text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  foreign key (tenant_id, facility_id) references public.facilities(tenant_id, id) on delete restrict,
  unique (tenant_id, id)
);

create index audit_events_tenant_time_idx on public.audit_events (tenant_id, occurred_at desc, id);
create index audit_events_resource_idx on public.audit_events (tenant_id, resource_type, resource_id, occurred_at desc);
create index audit_events_actor_idx on public.audit_events (tenant_id, actor_user_id, occurred_at desc) where actor_user_id is not null;

create table app_private.sessions (
  id uuid primary key,
  token_hash bytea not null unique,
  user_id uuid not null references public.app_users(id) on delete cascade,
  active_tenant_id uuid not null references public.organizations(id) on delete cascade,
  csrf_token_hash bytea not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip_hash text,
  user_agent_family text,
  check (expires_at > created_at),
  foreign key (active_tenant_id, user_id) references public.memberships(tenant_id, user_id) on delete cascade
);

create index sessions_user_active_idx on app_private.sessions (user_id, expires_at desc) where revoked_at is null;
create index sessions_expiry_idx on app_private.sessions (expires_at) where revoked_at is null;

create table app_private.idempotency_records (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid not null references public.app_users(id) on delete cascade,
  idempotency_key text not null,
  request_fingerprint text not null,
  response_status integer not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (tenant_id, actor_user_id, idempotency_key),
  check (expires_at > created_at)
);

create index idempotency_records_expiry_idx on app_private.idempotency_records (expires_at);

-- Foreign-key and authorization lookups must remain indexed even for soft-deleted rows.
create index children_created_by_idx on public.children (created_by);
create index children_updated_by_idx on public.children (updated_by);
create index children_deleted_by_idx on public.children (deleted_by) where deleted_by is not null;
create index schedule_versions_facility_idx on public.schedule_versions (tenant_id, facility_id);
create index schedule_versions_child_facility_idx on public.schedule_versions (tenant_id, child_id, facility_id);
create index schedule_versions_created_by_idx on public.schedule_versions (created_by);
create index case_documents_facility_idx on public.case_documents (tenant_id, facility_id);
create index case_documents_child_facility_idx on public.case_documents (tenant_id, child_id, facility_id);
create index case_documents_previous_idx on public.case_documents (tenant_id, previous_version_id) where previous_version_id is not null;
create index case_documents_created_by_idx on public.case_documents (created_by);
create index case_documents_updated_by_idx on public.case_documents (updated_by);
create index case_documents_approved_by_idx on public.case_documents (approved_by) where approved_by is not null;
create index case_documents_deleted_by_idx on public.case_documents (deleted_by) where deleted_by is not null;
create index daily_logs_child_fk_idx on public.daily_logs (tenant_id, child_id, facility_id);
create index daily_logs_facility_fk_idx on public.daily_logs (tenant_id, facility_id);
create index daily_logs_recorded_by_idx on public.daily_logs (recorded_by);
create index daily_logs_updated_by_idx on public.daily_logs (updated_by);
create index daily_logs_deleted_by_idx on public.daily_logs (deleted_by) where deleted_by is not null;
create index contact_book_child_fk_idx on public.contact_book_entries (tenant_id, child_id, facility_id);
create index contact_book_facility_fk_idx on public.contact_book_entries (tenant_id, facility_id);
create index contact_book_recorded_by_idx on public.contact_book_entries (recorded_by);
create index contact_book_updated_by_idx on public.contact_book_entries (updated_by);
create index contact_book_deleted_by_idx on public.contact_book_entries (deleted_by) where deleted_by is not null;
create index monitoring_goal_results_goal_idx on public.monitoring_goal_results (tenant_id, goal_id);
create index document_events_actor_idx on public.document_events (actor_user_id);
create index document_snapshots_generated_by_idx on public.document_snapshots (generated_by);
create index audit_events_facility_fk_idx on public.audit_events (tenant_id, facility_id) where facility_id is not null;
create index audit_events_actor_fk_idx on public.audit_events (actor_user_id) where actor_user_id is not null;
create index sessions_tenant_user_idx on app_private.sessions (active_tenant_id, user_id);
create index idempotency_records_actor_idx on app_private.idempotency_records (actor_user_id);

create or replace function app_private.provision_tenant(
  organization_id uuid,
  organization_name text,
  administrator_user_id uuid,
  administrator_cognito_sub text,
  administrator_email text,
  administrator_display_name text,
  administrator_membership_id uuid,
  first_facility_id uuid,
  first_facility_code text,
  first_facility_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if organization_name is null or btrim(organization_name) = ''
     or administrator_email is null or btrim(administrator_email) = ''
     or first_facility_name is null or btrim(first_facility_name) = '' then
    raise exception using errcode = '22023', message = 'organization, administrator and facility names are required';
  end if;

  insert into public.organizations (id, name)
  values (organization_id, organization_name);

  insert into public.app_users (id, cognito_sub, email, display_name, status)
  values (
    administrator_user_id,
    nullif(administrator_cognito_sub, ''),
    lower(administrator_email),
    administrator_display_name,
    case when nullif(administrator_cognito_sub, '') is null then 'invited' else 'active' end
  );

  insert into public.memberships (id, tenant_id, user_id, role, status, invited_at, joined_at)
  values (
    administrator_membership_id,
    organization_id,
    administrator_user_id,
    'tenant_admin',
    case when nullif(administrator_cognito_sub, '') is null then 'invited' else 'active' end,
    now(),
    case when nullif(administrator_cognito_sub, '') is null then null else now() end
  );

  insert into public.facilities (id, tenant_id, code, name)
  values (first_facility_id, organization_id, first_facility_code, first_facility_name);

  insert into public.membership_facilities (tenant_id, membership_id, facility_id)
  values (organization_id, administrator_membership_id, first_facility_id);

  return jsonb_build_object(
    'tenantId', organization_id,
    'userId', administrator_user_id,
    'membershipId', administrator_membership_id,
    'facilityId', first_facility_id
  );
end
$$;

create or replace function app_private.append_audit_event(
  event_id uuid,
  event_facility_id uuid,
  event_action text,
  event_resource_type text,
  event_resource_id uuid,
  event_request_id text,
  event_ip_hash text,
  event_user_agent_family text,
  event_outcome text,
  event_changed_fields text[],
  event_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app_private.current_tenant_id() is null or app_private.current_user_id() is null then
    raise exception using errcode = '42501', message = 'audit actor context is required';
  end if;
  if event_facility_id is not null and not app_private.can_access_facility(event_facility_id) then
    raise exception using errcode = '42501', message = 'facility access denied';
  end if;

  insert into public.audit_events (
    id, tenant_id, facility_id, actor_user_id, action, resource_type, resource_id,
    request_id, ip_hash, user_agent_family, outcome, changed_fields, metadata
  ) values (
    event_id,
    app_private.current_tenant_id(),
    event_facility_id,
    app_private.current_user_id(),
    event_action,
    event_resource_type,
    event_resource_id,
    event_request_id,
    event_ip_hash,
    event_user_agent_family,
    event_outcome,
    coalesce(event_changed_fields, '{}'),
    coalesce(event_metadata, '{}'::jsonb)
  );
end
$$;

create or replace function app_private.append_document_event(
  event_id uuid,
  requested_document_id uuid,
  requested_event_type text,
  event_reason text,
  event_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_name text;
  actor_role text;
begin
  if app_private.current_tenant_id() is null or app_private.current_user_id() is null then
    raise exception using errcode = '42501', message = 'document event actor context is required';
  end if;
  if not exists (
    select 1
    from public.case_documents d
    where d.tenant_id = app_private.current_tenant_id()
      and d.id = requested_document_id
      and app_private.can_access_facility(d.facility_id)
  ) then
    raise exception using errcode = '42501', message = 'document access denied';
  end if;

  select u.display_name, m.role
    into actor_name, actor_role
  from public.app_users u
  join public.memberships m
    on m.user_id = u.id
   and m.tenant_id = app_private.current_tenant_id()
   and m.status = 'active'
  where u.id = app_private.current_user_id()
    and u.status = 'active';

  if actor_name is null
     or actor_role not in ('tenant_admin', 'facility_admin', 'plan_approver') then
    raise exception using errcode = '42501', message = 'document event requires an approver role';
  end if;

  insert into public.document_events (
    id, tenant_id, document_id, event_type, actor_user_id,
    actor_name_snapshot, actor_role_snapshot, reason, metadata
  ) values (
    event_id,
    app_private.current_tenant_id(),
    requested_document_id,
    requested_event_type,
    app_private.current_user_id(),
    actor_name,
    actor_role,
    nullif(event_reason, ''),
    coalesce(event_metadata, '{}'::jsonb)
  );
end
$$;

create or replace function app_private.protect_document_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transition_allowed boolean := false;
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.facility_id is distinct from old.facility_id
     or new.child_id is distinct from old.child_id
     or new.document_kind is distinct from old.document_kind
     or new.version_number is distinct from old.version_number
     or new.previous_version_id is distinct from old.previous_version_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'document identity and lineage are immutable';
  end if;

  if new.status = old.status then
    transition_allowed := true;
  else
    transition_allowed := case old.status
      when 'draft' then new.status in ('internal_review', 'void')
      when 'internal_review' then new.status in ('draft', 'explanation_pending', 'void')
      when 'explanation_pending' then new.status in ('internal_review', 'consented', 'void')
      when 'consented' then new.status in ('internal_review', 'approved', 'void')
      when 'approved' then new.status in ('distributed', 'active', 'void')
      when 'distributed' then new.status in ('active', 'void')
      when 'active' then new.status in ('superseded', 'closed', 'void')
      else false
    end;
  end if;

  if not transition_allowed then
    raise exception using errcode = '55000', message = 'invalid or backward document status transition';
  end if;

  if new.status is distinct from old.status
     and new.status in ('explanation_pending', 'consented', 'approved', 'distributed', 'active', 'superseded', 'closed', 'void')
     and not app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver']) then
    raise exception using errcode = '42501', message = 'document transition requires an approver role';
  end if;

  if old.status = 'void' then
    raise exception using errcode = '55000', message = 'void document is immutable';
  end if;

  if old.deleted_at is not null then
    raise exception using errcode = '55000', message = 'deleted document is immutable';
  end if;
  if (new.deleted_at is null) <> (new.deleted_by is null) then
    raise exception using errcode = '23514', message = 'document deletion requires actor and timestamp together';
  end if;
  if old.deleted_at is null and new.deleted_at is not null
     and new.deleted_by is distinct from app_private.current_user_id() then
    raise exception using errcode = '42501', message = 'document deletion actor must match the authenticated actor';
  end if;

  if old.approved_at is not null and (
       new.payload is distinct from old.payload
       or new.period_start is distinct from old.period_start
       or new.period_end is distinct from old.period_end
       or new.template_version is distinct from old.template_version
       or new.approved_at is distinct from old.approved_at
       or new.approved_by is distinct from old.approved_by
       or new.deleted_at is distinct from old.deleted_at
     ) then
    raise exception using errcode = '55000', message = 'finalized document content is immutable';
  end if;

  if old.consented_at is not null
     and new.payload is distinct from old.payload
     and new.consented_at is not null then
    raise exception using errcode = '55000', message = 'consent must be invalidated before changing document content';
  end if;

  if new.status in ('approved', 'distributed', 'active', 'superseded', 'closed')
     and (new.approved_at is null or new.approved_by is null) then
    raise exception using errcode = '23514', message = 'approved document requires approver and approval timestamp';
  end if;
  if new.status = 'consented' and new.consented_at is null then
    raise exception using errcode = '23514', message = 'consented document requires consent timestamp';
  end if;
  if new.status = 'distributed' and new.distributed_at is null then
    raise exception using errcode = '23514', message = 'distributed document requires distribution timestamp';
  end if;
  if new.approved_at is not null
     and new.status not in ('approved', 'distributed', 'active', 'superseded', 'closed', 'void') then
    raise exception using errcode = '23514', message = 'approval metadata is only valid for a finalized document';
  end if;
  if old.approved_at is null and new.approved_at is not null
     and new.approved_by is distinct from app_private.current_user_id() then
    raise exception using errcode = '42501', message = 'approver must match the authenticated actor';
  end if;
  return new;
end
$$;

create trigger case_documents_protect_version
before update on public.case_documents
for each row execute function app_private.protect_document_version();

create or replace function app_private.protect_schedule_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transition_allowed boolean := false;
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.facility_id is distinct from old.facility_id
     or new.child_id is distinct from old.child_id
     or new.schedule_kind is distinct from old.schedule_kind
     or new.version_number is distinct from old.version_number
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'schedule identity is immutable';
  end if;

  transition_allowed := new.status = old.status
    or (old.status = 'draft' and new.status = 'finalized')
    or (old.status = 'finalized' and new.status = 'superseded');
  if not transition_allowed then
    raise exception using errcode = '55000', message = 'invalid or backward schedule status transition';
  end if;
  if new.status is distinct from old.status
     and not app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver']) then
    raise exception using errcode = '42501', message = 'schedule finalization requires an approver role';
  end if;

  if new.status in ('finalized', 'superseded') and new.finalized_at is null then
    raise exception using errcode = '23514', message = 'finalized schedule requires a timestamp';
  end if;
  if new.status = 'draft' and new.finalized_at is not null then
    raise exception using errcode = '23514', message = 'draft schedule cannot have a finalization timestamp';
  end if;
  if old.finalized_at is not null and (
       new.valid_from is distinct from old.valid_from
       or new.valid_to is distinct from old.valid_to
       or new.summary is distinct from old.summary
       or new.finalized_at is distinct from old.finalized_at
     ) then
    raise exception using errcode = '55000', message = 'finalized schedule content is immutable';
  end if;
  return new;
end
$$;

create trigger schedule_versions_protect_version
before update on public.schedule_versions
for each row execute function app_private.protect_schedule_version();

create or replace function app_private.protect_schedule_item_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_parent_locked boolean := false;
  new_parent_locked boolean := false;
begin
  if tg_op <> 'INSERT' then
    select (s.finalized_at is not null or s.status in ('finalized', 'superseded'))
      into old_parent_locked
    from public.schedule_versions s
    where s.tenant_id = old.tenant_id and s.id = old.schedule_version_id;
  end if;
  if tg_op <> 'DELETE' then
    select (s.finalized_at is not null or s.status in ('finalized', 'superseded'))
      into new_parent_locked
    from public.schedule_versions s
    where s.tenant_id = new.tenant_id and s.id = new.schedule_version_id;
  end if;
  if coalesce(old_parent_locked, false) or coalesce(new_parent_locked, false) then
    raise exception using errcode = '55000', message = 'items in a finalized schedule are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger schedule_items_prevent_finalized_change
before insert or update or delete on public.schedule_items
for each row execute function app_private.protect_schedule_item_rows();

create or replace function app_private.validate_document_lineage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_row record;
begin
  if new.previous_version_id is null then
    if new.version_number <> 1 then
      raise exception using errcode = '23514', message = 'first document version must be version 1';
    end if;
    return new;
  end if;

  select d.child_id, d.document_kind, d.version_number
    into previous_row
  from public.case_documents d
  where d.tenant_id = new.tenant_id and d.id = new.previous_version_id;

  if not found
     or previous_row.child_id <> new.child_id
     or previous_row.document_kind <> new.document_kind
     or previous_row.version_number + 1 <> new.version_number then
    raise exception using errcode = '23514', message = 'invalid previous document version';
  end if;
  return new;
end
$$;

create trigger case_documents_validate_lineage
before insert on public.case_documents
for each row execute function app_private.validate_document_lineage();

create unique index case_documents_one_active_idx
  on public.case_documents (tenant_id, child_id, document_kind)
  where status = 'active' and deleted_at is null;

create or replace function app_private.protect_document_child_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_parent_locked boolean := false;
  new_parent_locked boolean := false;
  old_document_id uuid;
  new_document_id uuid;
begin
  if tg_op <> 'INSERT' then
    old_document_id := old.document_id;
    select (d.approved_at is not null or d.status in ('superseded', 'closed', 'void'))
      into old_parent_locked
    from public.case_documents d
    where d.tenant_id = old.tenant_id and d.id = old_document_id;
  end if;

  if tg_op <> 'DELETE' then
    new_document_id := new.document_id;
    select (d.approved_at is not null or d.status in ('superseded', 'closed', 'void'))
      into new_parent_locked
    from public.case_documents d
    where d.tenant_id = new.tenant_id and d.id = new_document_id;
  end if;

  if coalesce(old_parent_locked, false) or coalesce(new_parent_locked, false) then
    raise exception using errcode = '55000', message = 'rows in a finalized document are immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

create trigger document_goals_prevent_finalized_change
before insert or update or delete on public.document_goals
for each row execute function app_private.protect_document_child_rows();

create or replace function app_private.protect_monitoring_result_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_parent_locked boolean := false;
  new_parent_locked boolean := false;
begin
  if tg_op <> 'INSERT' then
    select (d.approved_at is not null or d.status in ('superseded', 'closed', 'void'))
      into old_parent_locked
    from public.case_documents d
    where d.tenant_id = old.tenant_id and d.id = old.monitoring_document_id;
  end if;
  if tg_op <> 'DELETE' then
    select (d.approved_at is not null or d.status in ('superseded', 'closed', 'void'))
      into new_parent_locked
    from public.case_documents d
    where d.tenant_id = new.tenant_id and d.id = new.monitoring_document_id;
  end if;
  if coalesce(old_parent_locked, false) or coalesce(new_parent_locked, false) then
    raise exception using errcode = '55000', message = 'monitoring results in a finalized document are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger monitoring_goal_results_protect_finalized_change
before insert or update or delete on public.monitoring_goal_results
for each row execute function app_private.protect_monitoring_result_rows();

create or replace function app_private.validate_monitoring_goal_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  monitoring_child_id uuid;
  monitoring_kind text;
  goal_child_id uuid;
begin
  select d.child_id, d.document_kind
    into monitoring_child_id, monitoring_kind
  from public.case_documents d
  where d.tenant_id = new.tenant_id and d.id = new.monitoring_document_id;

  select d.child_id
    into goal_child_id
  from public.document_goals g
  join public.case_documents d on d.tenant_id = g.tenant_id and d.id = g.document_id
  where g.tenant_id = new.tenant_id and g.id = new.goal_id;

  if monitoring_kind <> 'monitoring_record'
     or monitoring_child_id is null
     or goal_child_id is null
     or monitoring_child_id <> goal_child_id then
    raise exception using errcode = '23514', message = 'monitoring result must reference a goal for the same child';
  end if;
  return new;
end
$$;

create trigger monitoring_goal_results_validate_link
before insert or update on public.monitoring_goal_results
for each row execute function app_private.validate_monitoring_goal_link();

create or replace function app_private.validate_daily_log_goal_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  log_child_id uuid;
  goal_child_id uuid;
begin
  select l.child_id into log_child_id
  from public.daily_logs l
  where l.tenant_id = new.tenant_id and l.id = new.daily_log_id;

  select d.child_id into goal_child_id
  from public.document_goals g
  join public.case_documents d on d.tenant_id = g.tenant_id and d.id = g.document_id
  where g.tenant_id = new.tenant_id and g.id = new.goal_id;

  if log_child_id is null or goal_child_id is null or log_child_id <> goal_child_id then
    raise exception using errcode = '23514', message = 'daily log must reference a goal for the same child';
  end if;
  return new;
end
$$;

create trigger daily_log_goals_validate_link
before insert or update on public.daily_log_goals
for each row execute function app_private.validate_daily_log_goal_link();

create or replace function app_private.protect_child_actor_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.id is distinct from old.id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'child identity and creator are immutable';
  end if;
  if old.deleted_at is not null then
    raise exception using errcode = '55000', message = 'deleted child is immutable';
  end if;
  if (new.deleted_at is null) <> (new.deleted_by is null) then
    raise exception using errcode = '23514', message = 'child deletion requires actor and timestamp together';
  end if;
  if old.deleted_at is null and new.deleted_at is not null
     and new.deleted_by is distinct from app_private.current_user_id() then
    raise exception using errcode = '42501', message = 'child deletion actor must match the authenticated actor';
  end if;
  return new;
end
$$;

create trigger children_protect_actor_fields
before update on public.children
for each row execute function app_private.protect_child_actor_fields();

create or replace function app_private.protect_daily_log_actor_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.id is distinct from old.id
     or new.facility_id is distinct from old.facility_id
     or new.child_id is distinct from old.child_id
     or new.recorded_by is distinct from old.recorded_by
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'daily log identity and recorder are immutable';
  end if;
  if old.deleted_at is not null then
    raise exception using errcode = '55000', message = 'deleted daily log is immutable';
  end if;
  if (new.deleted_at is null) <> (new.deleted_by is null) then
    raise exception using errcode = '23514', message = 'daily log deletion requires actor and timestamp together';
  end if;
  if old.deleted_at is null and new.deleted_at is not null
     and new.deleted_by is distinct from app_private.current_user_id() then
    raise exception using errcode = '42501', message = 'daily log deletion actor must match the authenticated actor';
  end if;
  return new;
end
$$;

create trigger daily_logs_protect_actor_fields
before update on public.daily_logs
for each row execute function app_private.protect_daily_log_actor_fields();

create or replace function app_private.protect_contact_book_actor_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     or new.id is distinct from old.id
     or new.facility_id is distinct from old.facility_id
     or new.child_id is distinct from old.child_id
     or new.recorded_by is distinct from old.recorded_by
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'contact-book identity and recorder are immutable';
  end if;
  if old.deleted_at is not null then
    raise exception using errcode = '55000', message = 'deleted contact-book entry is immutable';
  end if;
  if (new.deleted_at is null) <> (new.deleted_by is null) then
    raise exception using errcode = '23514', message = 'contact-book deletion requires actor and timestamp together';
  end if;
  if old.deleted_at is null and new.deleted_at is not null
     and new.deleted_by is distinct from app_private.current_user_id() then
    raise exception using errcode = '42501', message = 'contact-book deletion actor must match the authenticated actor';
  end if;
  return new;
end
$$;

create trigger contact_book_entries_protect_actor_fields
before update on public.contact_book_entries
for each row execute function app_private.protect_contact_book_actor_fields();

create or replace function app_private.bump_row_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.row_version := old.row_version + 1;
  new.updated_at := now();
  return new;
end
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations', 'facilities', 'app_users', 'memberships', 'children', 'guardians',
    'family_members', 'institutions', 'child_institution_relations', 'schedule_versions',
    'schedule_items', 'case_documents', 'document_goals', 'daily_logs',
    'contact_book_entries', 'monitoring_goal_results'
  ]
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function app_private.bump_row_version()',
      table_name || '_bump_row_version',
      table_name
    );
  end loop;
end
$$;

create or replace function app_private.prevent_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'audit events are append-only';
end
$$;

create trigger audit_events_append_only
before update or delete on public.audit_events
for each row execute function app_private.prevent_audit_mutation();

create or replace function app_private.prevent_document_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'document history is append-only';
end
$$;

create trigger document_events_append_only
before update or delete on public.document_events
for each row execute function app_private.prevent_document_history_mutation();

create trigger document_snapshots_append_only
before update or delete on public.document_snapshots
for each row execute function app_private.prevent_document_history_mutation();

create or replace function app_private.can_access_child(requested_child_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.children c
    where c.tenant_id = app_private.current_tenant_id()
      and c.id = requested_child_id
      and app_private.can_access_facility(c.facility_id)
  )
$$;

create or replace function app_private.can_access_document(requested_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.case_documents d
    where d.tenant_id = app_private.current_tenant_id()
      and d.id = requested_document_id
      and app_private.can_access_facility(d.facility_id)
  )
$$;

create or replace function app_private.can_access_schedule(requested_schedule_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.schedule_versions s
    where s.tenant_id = app_private.current_tenant_id()
      and s.id = requested_schedule_id
      and app_private.can_access_facility(s.facility_id)
  )
$$;

create or replace function app_private.can_access_daily_log(requested_daily_log_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.daily_logs l
    where l.tenant_id = app_private.current_tenant_id()
      and l.id = requested_daily_log_id
      and app_private.can_access_facility(l.facility_id)
  )
$$;

alter table public.organizations enable row level security;
alter table public.organizations force row level security;
create policy organizations_read on public.organizations
  for select using (
    id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'viewer', 'auditor'])
  );
create policy organizations_update on public.organizations
  for update using (
    id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin'])
  ) with check (id = app_private.current_tenant_id());

alter table public.app_users enable row level security;
alter table public.app_users force row level security;
create policy app_users_self_read on public.app_users
  for select using (id = app_private.current_user_id());
create policy app_users_tenant_roster_read on public.app_users
  for select using (
    app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
    and exists (
      select 1 from public.memberships m
      where m.tenant_id = app_private.current_tenant_id()
        and m.user_id = app_users.id
        and m.status <> 'ended'
    )
  );

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'facilities', 'memberships', 'membership_facilities', 'children', 'guardians',
    'family_members', 'institutions', 'child_institution_relations', 'schedule_versions',
    'schedule_items', 'case_documents', 'document_goals', 'daily_logs', 'daily_log_goals',
    'contact_book_entries', 'monitoring_goal_results', 'document_events',
    'document_snapshots', 'audit_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
  end loop;
end
$$;

-- Policy helper functions read these two tables as their owner. Keep RLS enabled,
-- but do not FORCE it here; the runtime role must never own either table.
alter table public.memberships no force row level security;
alter table public.membership_facilities no force row level security;

create policy memberships_read on public.memberships
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'viewer', 'auditor'])
  );
create policy memberships_write on public.memberships
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin'])
  );

create policy membership_facilities_read on public.membership_facilities
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'viewer', 'auditor'])
  );
create policy membership_facilities_write on public.membership_facilities
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin'])
  );

create policy facilities_read on public.facilities
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(id)
  );
create policy facilities_write on public.facilities
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin'])
  );

create policy children_read on public.children
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
  );
create policy children_write on public.children
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
    and created_by = app_private.current_user_id()
    and updated_by = app_private.current_user_id()
  );
create policy children_update on public.children
  for update using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
    and updated_by = app_private.current_user_id()
  );

create policy guardians_read on public.guardians
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_child(child_id));
create policy guardians_write on public.guardians
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_child(child_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_child(child_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  );

create policy family_members_read on public.family_members
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_child(child_id));
create policy family_members_write on public.family_members
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_child(child_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_child(child_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  );

create policy institutions_read on public.institutions
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'viewer', 'auditor'])
  );
create policy institutions_write on public.institutions
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  );

create policy child_institution_relations_read on public.child_institution_relations
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_child(child_id));
create policy child_institution_relations_write on public.child_institution_relations
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_child(child_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_child(child_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
  );

create policy schedule_versions_read on public.schedule_versions
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_facility(facility_id));
create policy schedule_versions_insert on public.schedule_versions
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
    and created_by = app_private.current_user_id()
  );
create policy schedule_versions_update on public.schedule_versions
  for update using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  );

create policy schedule_items_read on public.schedule_items
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_schedule(schedule_version_id));
create policy schedule_items_write on public.schedule_items
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_schedule(schedule_version_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_schedule(schedule_version_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  );

create policy case_documents_read on public.case_documents
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_facility(facility_id));
create policy case_documents_write on public.case_documents
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
    and created_by = app_private.current_user_id()
    and updated_by = app_private.current_user_id()
  );
create policy case_documents_update on public.case_documents
  for update using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
    and updated_by = app_private.current_user_id()
  );

create policy document_goals_read on public.document_goals
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_document(document_id));
create policy document_goals_write on public.document_goals
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  );

create policy daily_logs_read on public.daily_logs
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_facility(facility_id));
create policy daily_logs_write on public.daily_logs
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
    and recorded_by = app_private.current_user_id()
    and updated_by = app_private.current_user_id()
  );
create policy daily_logs_update on public.daily_logs
  for update using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
    and updated_by = app_private.current_user_id()
  );

create policy daily_log_goals_read on public.daily_log_goals
  for select using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_daily_log(daily_log_id)
  );
create policy daily_log_goals_write on public.daily_log_goals
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_daily_log(daily_log_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_daily_log(daily_log_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  );

create policy contact_book_entries_read on public.contact_book_entries
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_facility(facility_id));
create policy contact_book_entries_write on public.contact_book_entries
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
    and recorded_by = app_private.current_user_id()
    and updated_by = app_private.current_user_id()
  );
create policy contact_book_entries_update on public.contact_book_entries
  for update using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_facility(facility_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
    and updated_by = app_private.current_user_id()
  );

create policy monitoring_goal_results_read on public.monitoring_goal_results
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_document(monitoring_document_id));
create policy monitoring_goal_results_write on public.monitoring_goal_results
  for all using (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(monitoring_document_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  ) with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(monitoring_document_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff'])
  );

create policy document_events_read on public.document_events
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_document(document_id));
create policy document_events_insert on public.document_events
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
    and actor_user_id = app_private.current_user_id()
  );

create policy document_snapshots_read on public.document_snapshots
  for select using (tenant_id = app_private.current_tenant_id() and app_private.can_access_document(document_id));
create policy document_snapshots_insert on public.document_snapshots
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and app_private.can_access_document(document_id)
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver'])
    and generated_by = app_private.current_user_id()
  );

create policy audit_events_read on public.audit_events
  for select using (
    tenant_id = app_private.current_tenant_id()
    and (facility_id is null or app_private.can_access_facility(facility_id))
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'auditor'])
  );
create policy audit_events_insert on public.audit_events
  for insert with check (
    tenant_id = app_private.current_tenant_id()
    and (facility_id is null or app_private.can_access_facility(facility_id))
    and app_private.has_tenant_role(array['tenant_admin', 'facility_admin', 'plan_approver', 'support_staff', 'viewer', 'auditor'])
    and actor_user_id = app_private.current_user_id()
  );

revoke all on schema app_private from public;
revoke execute on all functions in schema app_private from public;
revoke all on all tables in schema app_private from public;

commit;
