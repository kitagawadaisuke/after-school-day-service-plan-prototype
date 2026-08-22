begin;

alter table public.daily_logs
  add column status text not null default 'final';

alter table public.daily_logs
  add constraint daily_logs_status_check check (status in ('draft', 'final'));

create index daily_logs_child_status_date_idx
  on public.daily_logs (tenant_id, child_id, status, occurred_at desc, id)
  where deleted_at is null;

commit;
