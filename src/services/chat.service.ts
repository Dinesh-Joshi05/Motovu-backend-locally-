import { pool, withTenantContext } from "../config/db.js";

export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_membership_id: string;
  sender_user_id: string;
  sender_name: string;
  sender_email: string;
  sender_role: string;
  content: string;
  created_at: string;
  is_me: boolean;
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
 * Retrieves recent messages in an organization conversation.
 * Runs in RLS tenant context.
 */
export async function getConversationMessages(
  orgId: string,
  userId: string,
  limit: number = 100
): Promise<ChatMessage[]> {
  return withTenantContext({ userId, orgId }, async (client) => {
    // Get conversation id
    const convResult = await client.query(
      "SELECT id FROM app.conversations WHERE org_id = $1",
      [orgId]
    );

    if (convResult.rowCount === 0) {
      return [];
    }

    const conversationId = convResult.rows[0].id;

    // Fetch messages joined with sender info
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

    return result.rows;
  });
}

/**
 * Sends a message to the organization's company chat.
 * Runs in RLS tenant context.
 */
export async function sendChatMessage(
  orgId: string,
  userId: string,
  content: string
): Promise<ChatMessage> {
  const trimmed = content?.trim();
  if (!trimmed) {
    throw new Error("Message content cannot be blank");
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

    // 4. Insert message
    const msgResult = await client.query(
      `INSERT INTO app.messages (id, org_id, conversation_id, sender_membership_id, content)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       RETURNING id, conversation_id, sender_membership_id, content, created_at`,
      [orgId, conversationId, membershipId, trimmed]
    );

    const msg = msgResult.rows[0];

    // 5. Fetch user profile
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
    };
  });
}

