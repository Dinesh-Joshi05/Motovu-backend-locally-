BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

--Organizations (tenant)
CREATE TABLE app.organizations (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--membership
CREATE TABLE app.memberships (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL
        REFERENCES app.organizations(id) ON DELETE RESTRICT,
    user_id TEXT NOT NULL
        REFERENCES public."user"(id) ON DELETE RESTRICT,
    role TEXT NOT NULL
        CHECK (role IN ('org_admin',
        'advisor',
        'guard',
        'worker',
        'store_keeper')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('invited', 'active', 'removed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (org_id, user_id)
);
--role_request
CREATE TABLE app.role_requests (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL
        REFERENCES public."user"(id) ON DELETE RESTRICT,
    org_id UUID NOT NULL
        REFERENCES app.organizations(id) ON DELETE RESTRICT,
    requested_role TEXT NOT NULL
        CHECK (requested_role IN ('org_admin',
        'advisor',
        'guard',
        'worker',
        'store_keeper')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by TEXT
        REFERENCES public."user"(id) ON DELETE RESTRICT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--admin
CREATE TABLE app.platform_admins (
    user_id TEXT PRIMARY KEY
        REFERENCES public."user"(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;