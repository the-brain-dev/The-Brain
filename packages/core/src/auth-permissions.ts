import type { User, UserRole } from "./auth-types";
import { UserRole as UR } from "./auth-types";

/**
 * PermissionResolver checks if a user has sufficient permissions
 * for an action on a project.
 *
 * Logic:
 * - ADMIN: everything allowed on all projects
 * - If project is undefined/null → global check using user.role
 * - If project specified → look up user.permissions for matching
 *   project role, fallback to user.role
 * - OBSERVER: can only read
 */
export class PermissionResolver {
  /**
   * Any role can read (observer, contributor, admin).
   */
  canRead(user: User, project?: string): boolean {
    const role = this.resolveRole(user, project);
    if (role === null) return false;
    return true; // All roles can read
  }

  /**
   * Admin or contributor can write.
   */
  canWrite(user: User, project?: string): boolean {
    const role = this.resolveRole(user, project);
    if (role === null) return false;
    return role === UR.ADMIN || role === UR.CONTRIBUTOR;
  }

  /**
   * Admin only can consolidate.
   */
  canConsolidate(user: User, project?: string): boolean {
    const role = this.resolveRole(user, project);
    if (role === null) return false;
    return role === UR.ADMIN;
  }

  /**
   * Admin only can train.
   */
  canTrain(user: User, project?: string): boolean {
    const role = this.resolveRole(user, project);
    if (role === null) return false;
    return role === UR.ADMIN;
  }

  /**
   * Admin only can manage users.
   */
  canManageUsers(user: User, project?: string): boolean {
    const role = this.resolveRole(user, project);
    if (role === null) return false;
    return role === UR.ADMIN;
  }

  /**
   * Resolve the effective role for a user on a given project.
   *
   * - If user.role is ADMIN, return ADMIN (covers all projects).
   * - If project is not specified, return user.role (global check).
   * - If project is specified, look for a matching entry in
   *   user.permissions. If found, return that project-specific role.
   *   Otherwise, fall back to user.role.
   * - Returns null when the user has no project access at all
   *   (shouldn't happen with OBSERVER+ roles but guards null inputs).
   */
  getProjectRole(user: User, project: string): UserRole | null {
    return this.resolveRole(user, project);
  }

  /**
   * Internal: resolve the effective role for a user/project pair.
   */
  private resolveRole(user: User, project?: string): UserRole | null {
    // Admin override — allowed everywhere
    if (user.role === UR.ADMIN) {
      return UR.ADMIN;
    }

    // No project specified → global role check
    if (project === undefined || project === null) {
      return user.role;
    }

    // Look for a project-specific permission entry
    if (user.permissions && user.permissions.length > 0) {
      const perm = user.permissions.find((p) => p.project === project);
      if (perm) {
        return perm.role;
      }
    }

    // Fallback to global role
    return user.role;
  }
}
