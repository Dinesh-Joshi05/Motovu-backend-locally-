import { pool, withTenantContext } from "../config/db.js";
import {
  uploadToMinIO,
  getPresignedDownloadUrl,
  getObjectFromMinIO,
  buildTenantObjectKey,
} from "../config/minio.js";
import crypto from "crypto";
import type { Readable } from "stream";

export interface MessageAttachment {
  id: string;
  message_id: string;
  org_id: string;
  object_key: string;
  original_filename: string | null;
  content_type: string;
  size_bytes: number;
  url: string;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_membership_id: string;
  sender_user_id: string;
  sender_name: string;
  sender_email: string;
  sender_role: string;
  content: string | null;
  created_at: string;
  is_me: boolean;
  attachments?: MessageAttachment[];
}

export interface OutgoingAttachment {
  buffer: Buffer;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
}

export interface ConversationInfo {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
  members_count: number;
}

/**
 * Ensures a company chat conversation exists for the given organization.
 * Used during approval or as a fallback.
 */
export async function ensureOrganizationConversation(orgId: string) {
  const result = await pool.query(
    `INSERT INTO app.conversations (id, org_id, name)
     VALUES (gen_random_uuid(), $1, 'Company Chat')
     ON CONFLICT (org_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, org_id, name, created_at`,
    [orgId]
  );
  return result.rows[0];
}

/**
 * Gets or initializes the company chat conversation for an organization.
 * Runs in RLS tenant context.
 */
export async function getOrganizationChat(orgId: string, userId: string) {
  return withTenantContext({ userId, orgId }, async (client) => {
    // 1. Fetch conversation
    let convResult = await client.query(
      `SELECT id, org_id, name, created_at
       FROM app.conversations
       WHERE org_id = $1`,
      [orgId]
    );

    // If no conversation found, auto-create one
    if (convResult.rowCount === 0) {
      convResult = await client.query(
        `INSERT INTO app.conversations (id, org_id, name)
         VALUES (gen_random_uuid(), $1, 'Company Chat')
         ON CONFLICT (org_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, org_id, name, created_at`,
        [orgId]
      );
    }

    const conversation = convResult.rows[0];

    // 2. Fetch conversation members count and member list
    const membersResult = await client.query(
      `SELECT
         cm.membership_id,
         cm.joined_at,
         u.id AS user_id,
         u.name,
         u.email,
         m.role
       FROM app.conversation_members cm
       JOIN app.memberships m ON m.id = cm.membership_id
       JOIN public."user" u ON u.id = m.user_id
       WHERE cm.org_id = $1 AND cm.conversation_id = $2
       ORDER BY cm.joined_at ASC`,
      [orgId, conversation.id]
    );

    return {
      conversation: {
        ...conversation,
        members_count: membersResult.rowCount ?? 0,
      },
      members: membersResult.rows,
    };
  });
}

/**
 * Retrieves recent messages in an organization conversation,
 * including any media attachments from app.message_attachments.
 * Runs in RLS tenant context.
 */
export async function getConversationMessages(
  orgId: string,
  userId: string,
  limit: number = 100
): Promise<ChatMessage[]> {
  return withTenantContext({ userId, orgId }, async (client) => {
    // 1. Get conversation id
    const convResult = await client.query(
      "SELECT id FROM app.conversations WHERE org_id = $1",
      [orgId]
    );

    if (convResult.rowCount === 0) {
      return [];
    }

    const conversationId = convResult.rows[0].id;

    // 2. Fetch messages joined with sender info
    const result = await client.query(
      `SELECT
         msg.id,
         msg.conversation_id,
         msg.sender_membership_id,
         m.user_id AS sender_user_id,
         msg.content,
         msg.created_at,
         u.name AS sender_name,
         u.email AS sender_email,
         m.role AS sender_role,
         (m.user_id = $3) AS is_me
       FROM app.messages msg
       JOIN app.memberships m ON m.id = msg.sender_membership_id
       JOIN public."user" u ON u.id = m.user_id
       WHERE msg.org_id = $1 AND msg.conversation_id = $2
       ORDER BY msg.created_at ASC
       LIMIT $4`,
      [orgId, conversationId, userId, limit]
    );

    const messages = result.rows;
    if (messages.length === 0) {
      return [];
    }

    // 3. Fetch message attachments for these messages (tenant isolated via RLS & org_id filter)
    const messageIds = messages.map((m) => m.id);
    const attachmentsResult = await client.query(
      `SELECT
         id,
         message_id,
         org_id,
         object_key,
         original_filename,
         content_type,
         size_bytes,
         created_at
       FROM app.message_attachments
       WHERE org_id = $1 AND message_id = ANY($2::uuid[])
       ORDER BY created_at ASC`,
      [orgId, messageIds]
    );

    // 4. Map attachments to their messages with download URLs
    const attachmentsByMessageId: Record<string, MessageAttachment[]> = {};
    for (const att of attachmentsResult.rows) {
      let downloadUrl = "";
      try {
        downloadUrl = await getPresignedDownloadUrl(att.object_key);
      } catch {
        // Fallback to proxy API URL if MinIO is temporarily unreachable
        downloadUrl = `/api/organizations/${orgId}/chat/attachments/${att.id}`;
      }

      const item: MessageAttachment = {
        id: att.id,
        message_id: att.message_id,
        org_id: att.org_id,
        object_key: att.object_key,
        original_filename: att.original_filename,
        content_type: att.content_type,
        size_bytes: Number(att.size_bytes),
        url: downloadUrl,
        created_at: att.created_at,
      };

      if (!attachmentsByMessageId[att.message_id]) {
        attachmentsByMessageId[att.message_id] = [];
      }
      attachmentsByMessageId[att.message_id].push(item);
    }

    return messages.map((msg) => ({
      ...msg,
      attachments: attachmentsByMessageId[msg.id] || [],
    }));
  });
}

/**
 * Sends a message to the organization's company chat, optionally containing
 * media files stored in MinIO and recorded in app.message_attachments.
 * 
 * Supports:
 * - Text-only messages
 * - Image-only messages
 * - Image messages with captions
 * 
 * Runs in RLS tenant context.
 */
export async function sendChatMessage(
  orgId: string,
  userId: string,
  content?: string | null,
  attachments?: OutgoingAttachment[]
): Promise<ChatMessage> {
  const trimmed = content && content.trim().length > 0 ? content.trim() : null;
  const hasAttachments = Boolean(attachments && attachments.length > 0);

  if (!trimmed && !hasAttachments) {
    throw new Error("Message must contain text content or at least one attachment");
  }

  return withTenantContext({ userId, orgId }, async (client) => {
    // 1. Ensure conversation exists
    let convResult = await client.query(
      "SELECT id FROM app.conversations WHERE org_id = $1",
      [orgId]
    );

    let conversationId: string;
    if (convResult.rowCount === 0) {
      const created = await client.query(
        `INSERT INTO app.conversations (id, org_id, name)
         VALUES (gen_random_uuid(), $1, 'Company Chat')
         ON CONFLICT (org_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [orgId]
      );
      conversationId = created.rows[0].id;
    } else {
      conversationId = convResult.rows[0].id;
    }

    // 2. Fetch sender's active membership in this organization
    const memberResult = await client.query(
      `SELECT id, role FROM app.memberships
       WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [orgId, userId]
    );

    if (memberResult.rowCount === 0) {
      throw new Error("Forbidden: You are not an active member of this organization");
    }

    const membershipId = memberResult.rows[0].id;
    const role = memberResult.rows[0].role;

    // 3. Ensure user is in app.conversation_members
    await client.query(
      `INSERT INTO app.conversation_members (org_id, conversation_id, membership_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, membership_id) DO NOTHING`,
      [orgId, conversationId, membershipId]
    );

    // 4. Insert message into app.messages
    const messageId = crypto.randomUUID();
    const msgResult = await client.query(
      `INSERT INTO app.messages (id, org_id, conversation_id, sender_membership_id, content)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, conversation_id, sender_membership_id, content, created_at`,
      [messageId, orgId, conversationId, membershipId, trimmed]
    );

    const msg = msgResult.rows[0];

    // 5. If attachments are provided, upload to MinIO and insert metadata into app.message_attachments
    const savedAttachments: MessageAttachment[] = [];
    if (hasAttachments && attachments) {
      for (const att of attachments) {
        const attachmentId = crypto.randomUUID();
        const objectKey = buildTenantObjectKey(
          orgId,
          messageId,
          attachmentId,
          att.originalFilename
        );

        // Upload to MinIO object storage
        await uploadToMinIO({
          key: objectKey,
          buffer: att.buffer,
          contentType: att.contentType,
        });

        // Insert metadata into app.message_attachments
        const attResult = await client.query(
          `INSERT INTO app.message_attachments (
             id,
             org_id,
             message_id,
             object_key,
             original_filename,
             content_type,
             size_bytes
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, org_id, message_id, object_key, original_filename, content_type, size_bytes, created_at`,
          [
            attachmentId,
            orgId,
            messageId,
            objectKey,
            att.originalFilename,
            att.contentType,
            att.sizeBytes,
          ]
        );

        const savedRow = attResult.rows[0];

        // Generate download URL
        let downloadUrl = "";
        try {
          downloadUrl = await getPresignedDownloadUrl(objectKey);
        } catch {
          downloadUrl = `/api/organizations/${orgId}/chat/attachments/${attachmentId}`;
        }

        savedAttachments.push({
          id: savedRow.id,
          message_id: savedRow.message_id,
          org_id: savedRow.org_id,
          object_key: savedRow.object_key,
          original_filename: savedRow.original_filename,
          content_type: savedRow.content_type,
          size_bytes: Number(savedRow.size_bytes),
          url: downloadUrl,
          created_at: savedRow.created_at,
        });
      }
    }

    // 6. Fetch sender profile
    const userResult = await client.query(
      `SELECT name, email FROM public."user" WHERE id = $1`,
      [userId]
    );
    const user = userResult.rows[0] || {};

    return {
      id: msg.id,
      conversation_id: msg.conversation_id,
      sender_membership_id: msg.sender_membership_id,
      sender_user_id: userId,
      sender_name: user.name || "Unknown",
      sender_email: user.email || "",
      sender_role: role,
      content: msg.content,
      created_at: msg.created_at,
      is_me: false,
      attachments: savedAttachments,
    };
  });
}

/**
 * Retrieves attachment metadata and its object stream from MinIO.
 * Enforces tenant isolation via PostgreSQL RLS on app.message_attachments.
 */
export async function getAttachmentStream(
  orgId: string,
  userId: string,
  attachmentId: string
): Promise<{
  attachment: {
    id: string;
    original_filename: string;
    content_type: string;
    size_bytes: number;
  };
  stream: Readable;
}> {
  return withTenantContext({ userId, orgId }, async (client) => {
    const res = await client.query(
      `SELECT id, org_id, message_id, object_key, original_filename, content_type, size_bytes
       FROM app.message_attachments
       WHERE id = $1 AND org_id = $2`,
      [attachmentId, orgId]
    );

    if (res.rowCount === 0) {
      throw new Error("Attachment not found or access denied");
    }

    const row = res.rows[0];
    const { stream } = await getObjectFromMinIO(row.object_key);

    return {
      attachment: {
        id: row.id,
        original_filename: row.original_filename,
        content_type: row.content_type,
        size_bytes: Number(row.size_bytes),
      },
      stream,
    };
  });
}
