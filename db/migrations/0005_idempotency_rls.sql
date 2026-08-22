-- Idempotency responses can contain the just-created resource. Restrict them
-- to the exact tenant and actor even if a future repository query omits a
-- predicate. The runtime role is not the table owner and cannot bypass FORCE.

alter table app_private.idempotency_records enable row level security;
alter table app_private.idempotency_records force row level security;

create policy idempotency_records_actor_isolation
on app_private.idempotency_records
for all
using (
  tenant_id = app_private.current_tenant_id()
  and actor_user_id = app_private.current_user_id()
)
with check (
  tenant_id = app_private.current_tenant_id()
  and actor_user_id = app_private.current_user_id()
);
