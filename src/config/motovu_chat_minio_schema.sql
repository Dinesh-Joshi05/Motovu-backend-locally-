BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- Motovu organization-wide chat schema.
-- UUID columns intentionally have no database DEFAULT:
-- generate UUIDv7 IDs in the application layer and pass them on INSERT.
-- Existing UUIDv4 values in organizations/memberships remain valid.

-- One company-wide conversation per organization.
CREATE TABLE app.conversations (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL
        REFERENCES app.organizations(id) ON DELETE RESTRICT,
    name TEXT NOT NULL DEFAULT 'Company Chat',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Enforce exactly one company-wide conversation per organization.
    CONSTRAINT conversations_one_per_org UNIQUE (org_id),

    -- Required as a target for tenant-aware composite foreign keys.
    CONSTRAINT conversations_id_org_unique UNIQUE (id, org_id)
);

-- Required for tenant-aware composite foreign keys from chat tables.
ALTER TABLE app.memberships
    ADD CONSTRAINT memberships_id_org_unique UNIQUE (id, org_id);

-- Tracks which organization memberships have access to the company chat.
-- Only active memberships should be present here.
CREATE TABLE app.conversation_members (
    org_id UUID NOT NULL,
    conversation_id UUID NOT NULL,
    membership_id UUID NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT conversation_members_pk
        PRIMARY KEY (conversation_id, membership_id),

    CONSTRAINT conversation_members_conversation_fk
        FOREIGN KEY (conversation_id, org_id)
        REFERENCES app.conversations (id, org_id)
        ON DELETE CASCADE,

    CONSTRAINT conversation_members_membership_fk
        FOREIGN KEY (membership_id, org_id)
        REFERENCES app.memberships (id, org_id)
        ON DELETE RESTRICT
);

CREATE INDEX conversation_members_org_membership_idx
    ON app.conversation_members (org_id, membership_id);

-- Stores text messages. The actual media bytes live in MinIO.
-- content may be NULL for a media-only message; application code must
-- ensure that every message has text or at least one attachment.
CREATE TABLE app.messages (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    conversation_id UUID NOT NULL,
    sender_membership_id UUID NOT NULL,
    content TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT messages_content_not_blank
        CHECK (content IS NULL OR length(btrim(content)) > 0),

    CONSTRAINT messages_id_org_unique UNIQUE (id, org_id),

    CONSTRAINT messages_conversation_fk
        FOREIGN KEY (conversation_id, org_id)
        REFERENCES app.conversations (id, org_id)
        ON DELETE CASCADE,

    CONSTRAINT messages_sender_membership_fk
        FOREIGN KEY (sender_membership_id, org_id)
        REFERENCES app.memberships (id, org_id)
        ON DELETE RESTRICT
);

-- Supports loading a conversation's newest messages efficiently.
CREATE INDEX messages_conversation_created_idx
    ON app.messages (conversation_id, created_at DESC, id DESC);

-- Useful for tenant-scoped moderation/reporting queries.
CREATE INDEX messages_org_created_idx
    ON app.messages (org_id, created_at DESC);

-- Stores MinIO object references and metadata, never the file bytes.
CREATE TABLE app.message_attachments (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    message_id UUID NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    original_filename TEXT,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT message_attachments_message_fk
        FOREIGN KEY (message_id, org_id)
        REFERENCES app.messages (id, org_id)
        ON DELETE CASCADE
);

CREATE INDEX message_attachments_message_idx
    ON app.message_attachments (message_id);

-- Automatically synchronize chat membership when an organization membership
-- is inserted or its status changes.
-- The organization-wide conversation must exist before a membership becomes
-- active. Create it in the same transaction as organization creation.
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

        IF v_conversation_id IS NULL THEN
            RAISE EXCEPTION
                'Company chat conversation does not exist for organization %',
                NEW.org_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

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

CREATE TRIGGER memberships_sync_company_chat
AFTER INSERT OR UPDATE OF status ON app.memberships
FOR EACH ROW
EXECUTE FUNCTION app.sync_company_chat_membership();

COMMIT;

-- IMPORTANT APPLICATION INTEGRATION NOTES:
-- 1. Generate UUIDv7 IDs in Node.js for new conversations, messages,
--    and attachment records. Existing UUIDv4 IDs need not be migrated.
-- 2. When creating an organization, insert the organization and its single
--    app.conversations row in the SAME transaction.
-- 3. For existing organizations, backfill one conversation per organization
--    using application-generated UUIDv7 IDs before activating chat memberships.
-- 4. When an active membership is inserted, the trigger adds it to the chat.
--    When status becomes 'removed', the trigger removes its chat membership.
-- 5. The trigger does not grant authorization to read/send messages by itself.
--    Every API/Socket.IO action must authenticate the user and check active
--    membership plus conversation membership.
-- 6. The application must ensure each message contains nonblank text or at
--    least one attachment, because a SQL CHECK cannot validate another table.
