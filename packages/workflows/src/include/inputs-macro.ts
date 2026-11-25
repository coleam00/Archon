import type { DagNode, IncludeDirective, WorkflowDefinition } from '../schemas';
import {
  inputEnvKey,
  isBindingDirectiveShape,
  isIncludeDirective,
  isLoopGroupNode,
} from '../schemas';
import { canonicalValueText, INPUTS_REF, parseWholeInputsRef, type JsonValue } from '../output-ref';
import { resolveDeclaredInputs } from '../workflow-inputs';
import { parseWhenExpression } from '../when-atom';
import { mapNodeTemplateSlots, mapNodeTemplateValueSlots } from '../template-walker';
import {
  attachComposedBindings,
  readComposedBindings,
  readComposedMeta,
} from '../compiled-command';
import { IncludeExpansionError } from './expansion-error';

/**
 * Apply an include node's input mapping to every inline text surface in the cloned node.
 * Unlike output-ref rewriting, substitutions also apply inside Markdown code spans because
 * `$INPUTS` has no documentation-only meaning. An inserted value may itself be a
 * `$node.output` reference; it deliberately remains unresolved for the executor's existing
 * runtime substitution pass.
 *
 * This walks the same field set as rewriteNodeOutputRefs. It was deliberately a SUPERSET
 * until #1764 — it added systemPrompt and agents.*, which took include inputs but had no
 * runtime substitution pass — and that asymmetry is exactly what made a workflow using
 * `$INPUTS.<name>` in a `systemPrompt:` resolve when composed and stay literal standalone
 * (#2476). Those fields are ordinary runtime surfaces now, so the two sets agree.
 *
 * The asymmetry in FAILURE MODE remains, and is why a missed surface matters more here:
 *
 *   - a surface rewriteNodeOutputRefs misses is only a NAMESPACING miss; the executor's
 *     substituteNodeOutputRefs pass still resolves the ref at run time.
 *   - a surface this function misses is permanent. The literal `$INPUTS.<name>` reaches
 *     the model as text, and because the field was never visited the name never reaches
 *     `missing` either — so a caller who forgot to supply it gets no load error.
 *
 * Every model-facing string field must be walked for include inputs. A future field that
 * takes include inputs but is NOT a runtime node-ref surface would reopen the #2476 gap;
 * it belongs in one of these two functions, not silently in this one alone.
 *
 * An input whose value is a binding directive `{ from, if_skipped }` (#5760) resolves at
 * run time, so it is never spliced as text. It travels as the directive object into
 * value positions (a command/script binding, a `workflow:` or runtime-width include
 * `with:`, and the composed inputs a bash or script node reads as `INPUTS_<NAME>`). An AI
 * prompt keeps `$INPUTS.<name>` standing and gets the directive as one of its node's
 * composed bindings, which the prompt's `$INPUTS` bag resolves at run time. Every other
 * text surface is substituted at load, so naming the input there is a load error.
 */
export function applyInputsMacro(
  node: DagNode,
  args: Record<string, JsonValue>,
  missing: Set<string>,
  includeNode: IncludeDirective
): void {
  const directiveNames = new Set(
    Object.keys(args).filter(name => isBindingDirectiveShape(args[name]))
  );
  // A text surface the directive cannot reach: it is substituted now, the directive later.
  const refuseDirective =
    (owner: DagNode, where: string) =>
    (name: string): string => {
      throw new IncludeExpansionError(
        `Node '${includeNode.id}': input '${name}' is a binding directive, which resolves at run time, but included node '${owner.id}' reads it in '${where}', which is substituted at load. Read it in a command or script node's 'with:', a bash or script node's ${inputEnvKey(name)}, or an AI node's prompt.`
      );
    };

  const substitute = (
    text: string,
    onDirective: (name: string, match: string) => string,
    shielded?: ReadonlySet<string>,
    // Canonical text (#2637): a typed input splices as its one deterministic
    // representation (strings raw, everything else canonical JSON text).
    render: (name: string) => string = name => canonicalValueText(args[name])
  ): string =>
    text.replace(INPUTS_REF, (match, name: string) => {
      // A name the node's own `with:` binds is neither the caller's to supply nor the
      // caller's to override — it resolves at run time from the nearest source in the
      // documented precedence order, so it is left standing for the executor (#2964).
      if (shielded?.has(name) === true) return match;
      // `Object.hasOwn` rather than a plain `args[name]` lookup: a bare index read reaches
      // Object.prototype, so an unsupplied `$INPUTS.toString` / `$INPUTS.constructor`
      // would resolve to an inherited member and splice a native function body into the
      // prompt instead of being reported as a missing input. Anything not supplied as an
      // OWN key is missing, and missing always fails the load — never a silent passthrough.
      if (!Object.hasOwn(args, name)) {
        missing.add(name);
        return match;
      }
      if (directiveNames.has(name)) return onDirective(name, match);
      return render(name);
    });

  // Value-position substitution (#2637): in a `with:` map value, a string that is
  // EXACTLY `$INPUTS.<name>` forwards the LOGICAL input value (a boolean stays a
  // boolean through nested composition, a binding directive stays the directive); any
  // other string splices text as usual, and non-strings carry no macro at all.
  const substituteValue = (value: JsonValue, path: string): JsonValue => {
    if (typeof value !== 'string') return value;
    const name = parseWholeInputsRef(value);
    if (name !== undefined) {
      if (Object.hasOwn(args, name)) return args[name];
      missing.add(name);
      return value;
    }
    return substitute(value, refuseDirective(node, path));
  };

  const substituteWhen = (when: string): string => {
    const expanded = substitute(when, refuseDirective(node, 'when'));
    const wasParseable = parseWhenExpression(when) !== null;
    const isParseable = parseWhenExpression(expanded) !== null;
    if (expanded !== when && wasParseable && !isParseable) {
      throw new IncludeExpansionError(
        `Node '${includeNode.id}': input substitution made included node '${node.id}' field 'when' unparseable: "${when}" became "${expanded}". Put '$INPUTS.<name>' on the right-hand side of a comparison whose left-hand side is a node-output reference.`
      );
    }
    return expanded;
  };

  // A loop_group body node carries the enclosing include's boundary too, so a gate that
  // names an input is substituted there as well. Left as `$INPUTS.<name>`, the body's
  // copy cannot be evaluated and every body node is skipped on the first iteration.
  const substituteBoundaries = (target: DagNode): void => {
    for (const boundary of readComposedMeta(target)?.boundaries ?? []) {
      if (boundary.when !== undefined) boundary.when = substituteWhen(boundary.when);
    }
    if (isLoopGroupNode(target)) {
      for (const body of target.loop_group.nodes) {
        if (!isIncludeDirective(body)) substituteBoundaries(body);
      }
    }
  };
  substituteBoundaries(node);

  // Values first: the two walks touch disjoint slots, and the text walk attaches
  // composed bindings that this level's value walk must not visit.
  const valueMapped = mapNodeTemplateValueSlots(node, slot => {
    const value = substituteValue(slot.value, slot.path);
    if (
      slot.position === 'binding' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !isBindingDirectiveShape(value)
    ) {
      const bindingName = slot.path.slice(slot.path.lastIndexOf('with.') + 'with.'.length);
      throw new IncludeExpansionError(
        `Node '${includeNode.id}': input substitution supplied an OBJECT to binding '${bindingName}' of included node '${node.id}' (value '${canonicalValueText(slot.value)}'). Command/script binding values must be strings, numbers, booleans, null, arrays, or a binding directive '{ from, if_skipped }'.`
      );
    }
    return value;
  });
  // Prompts that read a directive input, by owner: attached as composed bindings below.
  const promptDirectives = new Map<DagNode, Set<string>>();
  const textMapped = mapNodeTemplateSlots(valueMapped, slot => {
    if (slot.surface === 'binding_from' || slot.name === 'binding.if_skipped') return slot.value;
    if (
      slot.name.endsWith('with.*') ||
      slot.name === 'binding.value' ||
      slot.name === 'composed.inputs.*'
    )
      return slot.value;
    if (slot.surface === 'condition') return substituteWhen(slot.value);
    // Executable source never receives an input value (#2115): the shell delivers each
    // input as INPUTS_<UPPER_SNAKE>, so a bash body keeps the author's macro as a quoted
    // reference to that variable. Inline script languages share no safe quoting form,
    // so there the macro is refused and the author reads the env var directly. A
    // directive input rides the same env channel (inputEnvVars resolves it).
    if (slot.surface === 'shell') {
      const envRef = (name: string): string => `"\${${inputEnvKey(name)}}"`;
      return substitute(slot.value, envRef, undefined, envRef);
    }
    if (slot.surface === 'script') {
      const name = slot.value.matchAll(INPUTS_REF).next().value?.[1];
      if (name !== undefined)
        throw new IncludeExpansionError(
          `Node '${includeNode.id}': included node '${slot.owner.id}' script uses '$INPUTS.${name}', which would splice the input value into script source. Read it from the environment as ${inputEnvKey(name)} instead.`
        );
      return slot.value;
    }
    // Names a command node supplies itself. Only its compiled body reads them: the
    // executor merges the node's resolved bindings OVER the run inputs into the `$INPUTS`
    // bag it builds for the prompt, and nothing else (dag-executor.ts). So the shield is
    // scoped to that one surface — a `when:` or `systemPrompt:` naming the same input
    // still reads the run's bag, and a caller who never supplied it still gets the load
    // error. The slot's owner, not `node`, holds the bindings: the walk also visits
    // loop_group body nodes.
    if (slot.name === 'agent.prompt') {
      const owner = slot.owner;
      return substitute(
        slot.value,
        (name, match) => {
          // Left standing and bound under the name the text uses at THIS level: an inner
          // include already spliced its caller's `$INPUTS.<name>` into the text, so the
          // name is this level's, and the shield above protects it at every level out.
          const names = promptDirectives.get(owner) ?? new Set<string>();
          names.add(name);
          promptDirectives.set(owner, names);
          return match;
        },
        new Set(Object.keys(readComposedBindings(owner) ?? {}))
      );
    }
    return substitute(slot.value, refuseDirective(slot.owner, slot.path));
  });
  // Bound after the value walk, so the caller's directive is not re-substituted with this
  // level's inputs. The text walk ran on a clone, so bind on the clone's owners, each its
  // own copy so a later level's `from` rename on one node cannot reach another.
  for (const [owner, names] of promptDirectives) {
    const bindings = { ...readComposedBindings(owner) };
    for (const name of names) bindings[name] = structuredClone(args[name]) as JsonValue;
    attachComposedBindings(owner, bindings);
  }
  Object.assign(node, textMapped);
}

/**
 * Resolve a caller's `with:` map against a block's declared `inputs:` (#2470).
 * Only active when the block declares `inputs:` — an undeclared block keeps Phase-1
 * behaviour byte-for-byte (the caller's `with:` passes through verbatim). When declared:
 * applies each input's `default` for an omitted name, errors on an unsupplied `required`
 * input, and errors on a caller `with:` key the block doesn't declare.
 */
export function resolveIncludeInputs(
  includeNode: IncludeDirective,
  child: Pick<WorkflowDefinition, 'name' | 'inputs'>
): Record<string, JsonValue> {
  try {
    return resolveDeclaredInputs(
      includeNode.with ?? {},
      child.inputs,
      `Node '${includeNode.id}'`,
      `included block '${child.name}'`
    );
  } catch (err) {
    // Re-typed so the per-workflow expansion loop treats a contract violation as the
    // same resilient "drop one workflow, keep the rest" failure as every other
    // expansion error, rather than escaping as an unhandled throw.
    throw new IncludeExpansionError((err as Error).message);
  }
}
