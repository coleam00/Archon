/** Route-loop variant: defaults + sparse fromDag/toDag conversion. */
import type { RouteLoopNodeData, WireDagNode } from '../types';

/** Default route-loop config for a freshly-created route-loop controller. */
export function defaultRouteLoopData(): RouteLoopNodeData {
  return {
    from: '',
    condition: '',
    max_iterations: 10,
    routes: {
      positive: '',
      negative: '',
      exhausted: '',
    },
  };
}

/**
 * Build `RouteLoopNodeData` from a partitioned wire node's variant-specific fields.
 * Throws when the `route_loop` mode field is absent.
 */
export function routeLoopFromDag(variantSpecific: Partial<WireDagNode>): RouteLoopNodeData {
  const routeLoop = variantSpecific.route_loop;
  if (routeLoop === undefined) {
    throw new Error(
      "routeLoopFromDag: wire node has no 'route_loop' field - use defaultRouteLoopData() for new nodes"
    );
  }
  return routeLoop;
}

/** Serialize `RouteLoopNodeData` to the sparse `{ route_loop: ... }` wire fragment. */
export function routeLoopToDag(data: RouteLoopNodeData): Partial<WireDagNode> {
  return { route_loop: data };
}
