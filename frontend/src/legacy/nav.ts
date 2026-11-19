// src/legacy/nav.ts — hash routing for the Digital Legacy section.
// Routes: #/legacy · #/legacy/new · #/legacy/p/<id>[/<tab>] · #/legacy/p/<id>/call

export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'persona'; id: string; tab: string }
  | { name: 'call'; id: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean); // ['legacy', ...]
  if (parts[1] === 'new') return { name: 'new' };
  if (parts[1] === 'p' && parts[2]) {
    if (parts[3] === 'call') return { name: 'call', id: parts[2] };
    return { name: 'persona', id: parts[2], tab: parts[3] || 'memories' };
  }
  return { name: 'home' };
}

export function go(path: string) {
  window.location.hash = `#/legacy${path}`;
}
