import { z } from "zod";

// ── User Roles ──────────────────────────────────────────────────

export enum UserRole {
  ADMIN = "admin",
  CONTRIBUTOR = "contributor",
  OBSERVER = "observer",
}

// ── User Scopes ──────────────────────────────────────────────────

export enum UserScope {
  GLOBAL = "global",
  PROJECT = "project",
}

// ── User Permission ──────────────────────────────────────────────

export interface UserPermission {
  project: string;
  role: UserRole;
}

// ── User ─────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  displayName?: string;
  role: UserRole;
  permissions: UserPermission[];
  createdAt: number;
  lastActive?: number;
}

// ── Auth Token ───────────────────────────────────────────────────

export interface AuthToken {
  id: string;
  userId: string;
  token: string;
  label?: string;
  createdAt: number;
  lastUsed?: number;
  revoked: boolean;
}

// ── Audit Entry ──────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  userId: string;
  action: string;
  project?: string;
  detail?: string;
  timestamp: number;
}

// ── Zod Schemas ──────────────────────────────────────────────────

export const UserPermissionSchema = z.object({
  project: z.string(),
  role: z.nativeEnum(UserRole),
});

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  role: z.nativeEnum(UserRole),
  permissions: z.array(UserPermissionSchema),
  createdAt: z.number(),
  lastActive: z.number().optional(),
});

export const AuthTokenSchema = z.object({
  id: z.string(),
  userId: z.string(),
  token: z.string(),
  label: z.string().optional(),
  createdAt: z.number(),
  lastUsed: z.number().optional(),
  revoked: z.boolean(),
});

export const AuditEntrySchema = z.object({
  id: z.string(),
  userId: z.string(),
  action: z.string(),
  project: z.string().optional(),
  detail: z.string().optional(),
  timestamp: z.number(),
});
