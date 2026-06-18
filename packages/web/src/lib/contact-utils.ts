export interface ContactStubCandidate {
  email?: string | null;
  role?: string | null;
}

function isPlaceholder(value?: string | null): boolean {
  const normalized = (value ?? '').trim().toUpperCase();
  return normalized === 'TBD' || normalized === '?';
}

export function isContactStub(contact: ContactStubCandidate): boolean {
  return (
    isPlaceholder(contact.email) || (contact.role ?? '').trim().toUpperCase().startsWith('TBD')
  );
}
