begin;

-- Later migrations revoke or grant permissions for these application roles.
-- Create the deliberately unprivileged roles before that point so a clean
-- database can apply the complete migration sequence in order.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'michinote_runtime') then
    create role michinote_runtime nologin noinherit nobypassrls;
  end if;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'michinote_provisioner') then
    create role michinote_provisioner nologin noinherit nobypassrls;
  end if;
end
$$;

commit;
