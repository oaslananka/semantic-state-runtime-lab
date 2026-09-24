export interface AccessPrincipal {
  readonly subject: string;
  readonly scopes: readonly string[];
}

export type AccessDecision =
  | { readonly effect: "allow" }
  | { readonly effect: "deny"; readonly code: string };

export function normalizeAccessPrincipal(principal: AccessPrincipal): AccessPrincipal {
  const subject = principal.subject.trim();
  if (subject.length === 0) throw new TypeError("Access principal subject must not be empty");
  const scopes = principal.scopes.map((scope, index) => {
    const normalized = scope.trim();
    if (normalized.length === 0) {
      throw new TypeError(`Access principal scope at index ${index} must not be empty`);
    }
    return normalized;
  });
  return {
    subject,
    scopes: [...new Set(scopes)].toSorted((left, right) => left.localeCompare(right)),
  };
}
