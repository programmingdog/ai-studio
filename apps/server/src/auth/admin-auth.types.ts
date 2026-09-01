export interface AdminPrincipal {
  sub: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  type: "admin";
  mustChangePassword: boolean;
  mfaRequired: boolean;
}
