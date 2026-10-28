BEGIN;

-- 1. Ensure conversation auto-creation and membership sync trigger function
CREATE OR REPLACE FUNCTION app.sync_company_chat_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_conversation_id UUID;
BEGIN
    IF NEW.status = 'active' THEN
        SELECT c.id
          INTO v_conversation_id
          FROM app.conversations AS c
         WHERE c.org_id = NEW.org_id;

        -- If conversation does not exist yet for this organization,
        -- create it automatically (e.g. when Option A is approved)
        IF v_conversation_id IS NULL THEN
            INSERT INTO app.conversations (id, org_id, name)
            VALUES (gen_random_uuid(), NEW.org_id, 'Company Chat')
            ON CONFLICT (org_id) DO UPDATE SET name = EXCLUDED.name
            RETURNING id INTO v_conversation_id;
        END IF;

        -- Automatically add the active member into the conversation (e.g. Option A & Option B)
        INSERT INTO app.conversation_members (
            org_id,
            conversation_id,
            membership_id
        )
        VALUES (
            NEW.org_id,
            v_conversation_id,
            NEW.id
        )
        ON CONFLICT (conversation_id, membership_id)
        DO UPDATE SET joined_at = NOW();

    ELSIF NEW.status = 'removed' THEN
        DELETE FROM app.conversation_members
         WHERE org_id = NEW.org_id
           AND membership_id = NEW.id;
    END IF;

    RETURN NEW;
END;
$$;

-- 2. Ensure trigger exists on app.memberships
DROP TRIGGER IF EXISTS memberships_sync_company_chat ON app.memberships;
CREATE TRIGGER memberships_sync_company_chat
AFTER INSERT OR UPDATE OF status ON app.memberships
FOR EACH ROW
EXECUTE FUNCTION app.sync_company_chat_membership();

-- 2b. Make conversation cascades cleanly on delete
ALTER TABLE app.conversations
  DROP CONSTRAINT IF EXISTS conversations_org_id_fkey,
  ADD CONSTRAINT conversations_org_id_fkey
    FOREIGN KEY (org_id)
    REFERENCES app.organizations (id)
    ON DELETE CASCADE;

ALTER TABLE app.conversation_members
  DROP CONSTRAINT IF EXISTS conversation_members_membership_fk,
  ADD CONSTRAINT conversation_members_membership_fk
    FOREIGN KEY (membership_id, org_id)
    REFERENCES app.memberships (id, org_id)
    ON DELETE CASCADE;

ALTER TABLE app.messages
  DROP CONSTRAINT IF EXISTS messages_sender_membership_fk,
  ADD CONSTRAINT messages_sender_membership_fk
    FOREIGN KEY (sender_membership_id, org_id)
    REFERENCES app.memberships (id, org_id)
    ON DELETE CASCADE;

-- 3. Enable and Force Row Level Security (RLS) on all chat tables
ALTER TABLE app.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.conversations FORCE ROW LEVEL SECURITY;

ALTER TABLE app.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.conversation_members FORCE ROW LEVEL SECURITY;

ALTER TABLE app.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.messages FORCE ROW LEVEL SECURITY;

ALTER TABLE app.message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.message_attachments FORCE ROW LEVEL SECURITY;

-- 4. RLS Policy for app.conversations
DROP POLICY IF EXISTS conversations_tenant_isolation ON app.conversations;
CREATE POLICY conversations_tenant_isolation ON app.conversations
FOR ALL
USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR EXISTS (
        SELECT 1 FROM app.memberships m 
        WHERE m.org_id = app.conversations.org_id 
          AND m.user_id = NULLIF(current_setting('app.current_user_id', true), '')
          AND m.status = 'active'
    )
    OR EXISTS (
        SELECT 1 FROM app.platform_admins pa 
        WHERE pa.user_id = NULLIF(current_setting('app.current_user_id', true), '')
    )
);

-- 5. RLS Policy for app.conversation_members
DROP POLICY IF EXISTS conversation_members_tenant_isolation ON app.conversation_members;
CREATE POLICY conversation_members_tenant_isolation ON app.conversation_members
FOR ALL
USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR EXISTS (
        SELECT 1 FROM app.memberships m 
        WHERE m.org_id = app.conversation_members.org_id 
          AND m.user_id = NULLIF(current_setting('app.current_user_id', true), '')
          AND m.status = 'active'
    )
    OR EXISTS (
        SELECT 1 FROM app.platform_admins pa 
        WHERE pa.user_id = NULLIF(current_setting('app.current_user_id', true), '')
    )
);

-- 6. RLS Policy for app.messages
DROP POLICY IF EXISTS messages_tenant_isolation ON app.messages;
CREATE POLICY messages_tenant_isolation ON app.messages
FOR ALL
USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
        EXISTS (
            SELECT 1 FROM app.conversation_members cm
            JOIN app.memberships m ON m.id = cm.membership_id
            WHERE cm.conversation_id = app.messages.conversation_id
              AND m.user_id = NULLIF(current_setting('app.current_user_id', true), '')
              AND m.status = 'active'
        )
        OR EXISTS (
            SELECT 1 FROM app.platform_admins pa 
            WHERE pa.user_id = NULLIF(current_setting('app.current_user_id', true), '')
        )
    )
)
WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
        EXISTS (
            SELECT 1 FROM app.conversation_members cm
            JOIN app.memberships m ON m.id = cm.membership_id
            WHERE cm.conversation_id = app.messages.conversation_id
              AND m.user_id = NULLIF(current_setting('app.current_user_id', true), '')
              AND m.status = 'active'
        )
        OR EXISTS (
            SELECT 1 FROM app.platform_admins pa 
            WHERE pa.user_id = NULLIF(current_setting('app.current_user_id', true), '')
        )
    )
);

-- 7. RLS Policy for app.message_attachments
DROP POLICY IF EXISTS message_attachments_tenant_isolation ON app.message_attachments;
CREATE POLICY message_attachments_tenant_isolation ON app.message_attachments
FOR ALL
USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
);

-- 8. Grant privileges to app_user role
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT USAGE ON SCHEMA app TO app_user;
    GRANT ALL ON ALL TABLES IN SCHEMA app TO app_user;
  END IF;
END
$$;

COMMIT;
