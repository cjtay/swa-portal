import { IT_ADMIN_EMAILS, IT_ADMIN_NAMES } from '../../constants/portal';

// Subset of a D1 member row that resolveSessionRole needs. Kept loose so
// callers can pass the raw `.first()` result without reshaping.
export interface MemberRoleInput {
  name?: string | null;
  category?: string | null;
  reg_role?: string | null;
}

export interface ResolvedRole {
  name: string;
  role: string;
  regRole: string | null;
  isItAdmin: boolean;
}

// Single source of truth for the session role mapping. Mirrors the SWA role
// tiers documented in AGENTS.md:
//   - IT_ADMIN_EMAILS          -> 'admin' (is_it_admin = true)
//   - members.category='admin' -> 'admin'
//   - members.category='volunteer' -> 'volunteer' (check-in only)
//   - 'committee' | 'advisor' | 'member' -> 'committee'
//
// `email` should already be lowercased by the caller; we lowercase again
// defensively so a stray uppercase input can't bypass the IT-admin match.
// When `member` is null (not found / can_login=0), callers should usually
// reject the request — but we still return a fallback 'committee' role so
// this helper never throws.
export function resolveSessionRole(email: string, member: MemberRoleInput | null | undefined): ResolvedRole {
  const lowerEmail = email.toLowerCase();
  const isItAdmin = (IT_ADMIN_EMAILS as readonly string[]).includes(lowerEmail);

  const name =
    member && member.name
      ? (member.name as string)
      : (IT_ADMIN_NAMES[lowerEmail] ?? email.split('@')[0].replace(/[._-]/g, ' '));

  let role: string;
  if (isItAdmin) {
    role = 'admin';
  } else if (member && member.category === 'admin') {
    role = 'admin';
  } else if (member && member.category === 'volunteer') {
    role = 'volunteer';
  } else {
    role = 'committee';
  }

  const regRole = member && member.reg_role ? (member.reg_role as string) : null;

  return { name, role, regRole, isItAdmin };
}
