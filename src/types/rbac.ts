export type OrganizationRole =
  | "org_admin"
  | "advisor"
  | "guard"
  | "worker"
  | "store_keeper";

export type MembershipStatus = "invited" | "active" | "removed";

export type OrganizationStatus = "active" | "suspended";

export type RoleRequestStatus = "pending" | "approved" | "rejected";

export interface AuthenticatedUser {
  id: string;
  email?: string;
  name?: string;
  isPlatformAdmin?: boolean;
}

export interface OrganizationMembership {
  id: string;
  orgId: string;
  userId: string;
  role: OrganizationRole;
  status: MembershipStatus;
  createdAt: Date;
  orgName?: string;
  orgStatus?: OrganizationStatus;
}

export interface Organization {
  id: string;
  name: string;
  status: OrganizationStatus;
  createdAt: Date;
}
