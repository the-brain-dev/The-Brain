import { describe, it, expect } from "bun:test";
import { PermissionResolver } from "../auth-permissions";
import { UserRole } from "../auth-types";
import type { User } from "../auth-types";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u-1",
    name: "testuser",
    role: UserRole.CONTRIBUTOR,
    permissions: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("PermissionResolver", () => {
  const resolver = new PermissionResolver();

  describe("Admin", () => {
    it("can do everything on any project", () => {
      const admin = makeUser({ role: UserRole.ADMIN });
      expect(resolver.canRead(admin, "proj-a")).toBe(true);
      expect(resolver.canWrite(admin, "proj-a")).toBe(true);
      expect(resolver.canConsolidate(admin, "proj-a")).toBe(true);
      expect(resolver.canTrain(admin, "proj-a")).toBe(true);
      expect(resolver.canManageUsers(admin, "proj-a")).toBe(true);
    });

    it("can do everything without a project (global)", () => {
      const admin = makeUser({ role: UserRole.ADMIN });
      expect(resolver.canRead(admin)).toBe(true);
      expect(resolver.canWrite(admin)).toBe(true);
      expect(resolver.canConsolidate(admin)).toBe(true);
      expect(resolver.canTrain(admin)).toBe(true);
      expect(resolver.canManageUsers(admin)).toBe(true);
    });
  });

  describe("Contributor", () => {
    it("can read and write, but not consolidate/train/manage", () => {
      const contributor = makeUser({ role: UserRole.CONTRIBUTOR });
      expect(resolver.canRead(contributor, "proj-a")).toBe(true);
      expect(resolver.canWrite(contributor, "proj-a")).toBe(true);
      expect(resolver.canConsolidate(contributor, "proj-a")).toBe(false);
      expect(resolver.canTrain(contributor, "proj-a")).toBe(false);
      expect(resolver.canManageUsers(contributor, "proj-a")).toBe(false);
    });

    it("global check (no project) also works", () => {
      const contributor = makeUser({ role: UserRole.CONTRIBUTOR });
      expect(resolver.canRead(contributor)).toBe(true);
      expect(resolver.canWrite(contributor)).toBe(true);
      expect(resolver.canConsolidate(contributor)).toBe(false);
      expect(resolver.canTrain(contributor)).toBe(false);
      expect(resolver.canManageUsers(contributor)).toBe(false);
    });
  });

  describe("Observer", () => {
    it("can only read", () => {
      const observer = makeUser({ role: UserRole.OBSERVER });
      expect(resolver.canRead(observer, "proj-a")).toBe(true);
      expect(resolver.canWrite(observer, "proj-a")).toBe(false);
      expect(resolver.canConsolidate(observer, "proj-a")).toBe(false);
      expect(resolver.canTrain(observer, "proj-a")).toBe(false);
      expect(resolver.canManageUsers(observer, "proj-a")).toBe(false);
    });
  });

  describe("Per-project override", () => {
    it("global observer but admin on specific project", () => {
      const user = makeUser({
        role: UserRole.OBSERVER,
        permissions: [
          { project: "proj-a", role: UserRole.ADMIN },
        ],
      });

      // On proj-a: admin permissions
      expect(resolver.canRead(user, "proj-a")).toBe(true);
      expect(resolver.canWrite(user, "proj-a")).toBe(true);
      expect(resolver.canConsolidate(user, "proj-a")).toBe(true);
      expect(resolver.canTrain(user, "proj-a")).toBe(true);
      expect(resolver.canManageUsers(user, "proj-a")).toBe(true);

      // On proj-b: observer (global fallback)
      expect(resolver.canRead(user, "proj-b")).toBe(true);
      expect(resolver.canWrite(user, "proj-b")).toBe(false);
      expect(resolver.canConsolidate(user, "proj-b")).toBe(false);
      expect(resolver.canTrain(user, "proj-b")).toBe(false);
      expect(resolver.canManageUsers(user, "proj-b")).toBe(false);
    });

    it("global contributor but observer on specific project", () => {
      const user = makeUser({
        role: UserRole.CONTRIBUTOR,
        permissions: [
          { project: "proj-x", role: UserRole.OBSERVER },
        ],
      });

      // On proj-x: observer (project-specific override)
      expect(resolver.canRead(user, "proj-x")).toBe(true);
      expect(resolver.canWrite(user, "proj-x")).toBe(false);

      // On other project: contributor (global)
      expect(resolver.canRead(user, "proj-y")).toBe(true);
      expect(resolver.canWrite(user, "proj-y")).toBe(true);
    });
  });

  describe("Null / undefined project", () => {
    it("returns false for all actions when project is explicitly undefined", () => {
      // This tests that undefined project uses global role.
      // For contributor, read + write are true.
      const contributor = makeUser({ role: UserRole.CONTRIBUTOR });
      expect(resolver.canRead(contributor, undefined)).toBe(true);
      expect(resolver.canWrite(contributor, undefined)).toBe(true);
      expect(resolver.canConsolidate(contributor, undefined)).toBe(false);
      expect(resolver.canTrain(contributor, undefined)).toBe(false);
      expect(resolver.canManageUsers(contributor, undefined)).toBe(false);
    });
  });

  describe("User with no permissions array (defaults to global role)", () => {
    it("uses global role when permissions is empty", () => {
      const user = makeUser({
        role: UserRole.OBSERVER,
        permissions: [],
      });

      expect(resolver.canRead(user, "any-project")).toBe(true);
      expect(resolver.canWrite(user, "any-project")).toBe(false);
    });

    it("uses global role when permissions is not provided", () => {
      const user: User = {
        id: "u-2",
        name: "noperms",
        role: UserRole.CONTRIBUTOR,
        permissions: [],
        createdAt: Date.now(),
      };

      expect(resolver.canRead(user, "any-project")).toBe(true);
      expect(resolver.canWrite(user, "any-project")).toBe(true);
      expect(resolver.canConsolidate(user, "any-project")).toBe(false);
    });
  });

  describe("getProjectRole", () => {
    it("returns the project-specific role when defined", () => {
      const user = makeUser({
        role: UserRole.OBSERVER,
        permissions: [{ project: "proj-a", role: UserRole.CONTRIBUTOR }],
      });

      expect(resolver.getProjectRole(user, "proj-a")).toBe(UserRole.CONTRIBUTOR);
    });

    it("returns global role when no project-specific permission exists", () => {
      const user = makeUser({ role: UserRole.OBSERVER });

      expect(resolver.getProjectRole(user, "proj-unknown")).toBe(UserRole.OBSERVER);
    });

    it("returns ADMIN for admin users regardless of project", () => {
      const admin = makeUser({ role: UserRole.ADMIN });

      expect(resolver.getProjectRole(admin, "any-project")).toBe(UserRole.ADMIN);
    });
  });
});
