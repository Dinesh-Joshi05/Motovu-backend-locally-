-- 1. Enable RLS on memberships and role requests
ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.role_requests ENABLE ROW LEVEL SECURITY;

-- 2. Force RLS (so it applies to table owners/superusers as well)
ALTER TABLE app.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE app.role_requests FORCE ROW LEVEL SECURITY;

-- 3. Policy for app.memberships:
-- A user can see their own memberships, OR an Org Admin can see all members in their active org
CREATE POLICY memberships_tenant_isolation ON app.memberships
FOR ALL
USING (
    -- User viewing their own membership
    user_id = NULLIF(current_setting('app.current_user_id', true), '')
    OR
    -- Or user viewing members of their active organization
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR
    -- Or platform admin
    EXISTS (
        SELECT 1 FROM app.platform_admins pa 
        WHERE pa.user_id = NULLIF(current_setting('app.current_user_id', true), '')
    )
);

-- 4. Policy for app.role_requests:
-- A user can see their own requests, Org Admin can see their org's staff requests, Platform Admin can see Option A
CREATE POLICY role_requests_tenant_isolation ON app.role_requests
FOR ALL
USING (
    -- User viewing their own request
    user_id = NULLIF(current_setting('app.current_user_id', true), '')
    OR
    -- Org Admin viewing staff requests for their org
    (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND requested_role != 'org_admin'
    )
    OR
    -- Platform Admin viewing Option A requests
    (
        requested_role = 'org_admin'
        AND EXISTS (
            SELECT 1 FROM app.platform_admins pa 
            WHERE pa.user_id = NULLIF(current_setting('app.current_user_id', true), '')
        )
    )
);



-- Check Rls
SELECT
    n.nspname AS schema_name,
    c.relname AS table_name,
    c.relrowsecurity AS rls_enabled,
    c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n
    ON n.oid = c.relnamespace
WHERE n.nspname = 'app'
  AND c.relkind IN ('r', 'p')
ORDER BY c.relname;
