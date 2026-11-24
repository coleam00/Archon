import type { ReactElement } from 'react';
import { Factory } from 'lucide-react';
import { RailNavLink } from '../components/RailNavLink';
import { useFactoryPacks } from './useFactoryPacks';

/**
 * The sidebar's Factory entry, shown once an installed pack has a factory overview file (or
 * a broken one). Nothing shows while the read loads or after it fails: the entry has nowhere
 * to go without a pack, and `/console/factory` itself says why a read failed.
 */
export function FactoryRailLink(): ReactElement | null {
  const { data } = useFactoryPacks();
  if (data === undefined || data.packs.length === 0) return null;
  return <RailNavLink to="/console/factory" icon={Factory} label="Factory" />;
}
